const { EventEmitter } = require('node:events');
const logger = require('../../logger');
const { mediaUrl } = require('../../usb/library');
const tagReader = require('../../usb/tags');

// Strings the GUI uses for the repeat and shuffle buttons (RepeatShuffleStatus, NowPlayingData).
const REPEAT = {
    NONE: 'USBM_REPEAT_MODE_NONE',
    ALL: 'USBM_REPEAT_MODE_ALL',
    ONE: 'USBM_REPEAT_MODE_ONE'
};
const SHUFFLE = { OFF: 'USBM_SHUFFLE_MODE_NONE', ON: 'USBM_SHUFFLE_MODE_TRACKS' };
const REPEAT_CYCLE = [REPEAT.NONE, REPEAT.ALL, REPEAT.ONE];

// PlayerState values of the GUI.
const STATE = { PLAY: 'PLAY', PAUSE: 'PAUSE', STOPPED: 'STOPED' };

const RESTART_THRESHOLD_S = 3; // "previous" restarts the track after this many seconds
const HOLD_STEP_S = 4; // fast forward / rewind: seconds per step
const HOLD_INTERVAL_MS = 250;

// The head unit's USB audio player. It owns the queue, the order (shuffle), repeat and the
// progress of the track that is playing. The sound itself is made by the browser (see
// client/ui-usb-audio.js): the player sends it commands through `speaker.send()` and gets the
// state of the audio element back in `handleSpeakerEvent()`.
//
// Events: 'track' (a track was loaded), 'state' (play / pause / stop), 'progress' (the
// elapsed whole second or the duration changed), 'modes' (repeat or shuffle changed).
class UsbPlayer extends EventEmitter {
    constructor({
        speaker,
        readTags = tagReader.readTags,
        random = Math.random,
        onBeforePlay = () => {},
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval
    }) {
        super();
        this.speaker = speaker;
        this.readTags = readTags;
        // Called before the player makes sound (audio focus: other sources pause).
        this.onBeforePlay = onBeforePlay;
        this.random = random;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;

        this.queue = [];
        this.order = [];
        this.cursor = 0;
        this.filter = null;
        this.state = STATE.STOPPED;
        this.repeat = REPEAT.NONE;
        this.shuffle = SHUFFLE.OFF;
        this.elapsed = 0;
        this.duration = 0;
        this.track = null;
        this.failedInARow = 0;
        this.holdTimer = null;
    }

    hasQueue() {
        return this.queue.length > 0;
    }

    // Replaces the queue and plays `startIndex` of it. `filter` says where the list came from
    // (the GUI shows it as the song list).
    start(files, startIndex, filter) {
        this.stopHold();
        this.queue = files.slice();
        this.filter = filter || null;
        this.failedInARow = 0;
        const index = Math.min(Math.max(0, Number(startIndex) || 0), this.queue.length - 1);
        if (this.queue.length === 0) {
            this.stop();
            return;
        }
        this.buildOrder(index);
        this.loadCurrent(0);
    }

    // Order of the queue: as listed, or shuffled with `firstIndex` first.
    buildOrder(firstIndex) {
        const indexes = this.queue.map((_, i) => i);
        if (this.shuffle === SHUFFLE.ON) {
            const rest = indexes.filter((i) => i !== firstIndex);
            for (let i = rest.length - 1; i > 0; i--) {
                const j = Math.floor(this.random() * (i + 1));
                [rest[i], rest[j]] = [rest[j], rest[i]];
            }
            this.order = [firstIndex, ...rest];
        } else {
            this.order = indexes;
        }
        this.cursor = this.order.indexOf(firstIndex);
    }

    currentFile() {
        return this.queue.length > 0 ? this.queue[this.order[this.cursor]] : null;
    }

    // Index in the list the GUI knows (not in the shuffled order).
    currentIndex() {
        return this.queue.length > 0 ? this.order[this.cursor] : 0;
    }

    loadCurrent(startAt) {
        const file = this.currentFile();
        if (!file) {
            return;
        }
        const tags = this.readTags(file.absPath);
        this.track = {
            file: file,
            title: tags.title || tagReader.titleFromFileName(file.name),
            artist: tags.artist || '',
            album: tags.album || '',
            genre: tags.genre || '',
            hasCover: Boolean(tags.picture) || Boolean(tagReader.findFolderCover(file.absPath))
        };
        this.onBeforePlay();
        this.elapsed = startAt || 0;
        this.duration = 0;
        this.state = STATE.PLAY;
        this.sendToSpeaker({ cmd: 'load', url: mediaUrl(file), position: this.elapsed, play: true });
        logger.info('usb', 'Playing %s', file.relPath);
        this.emit('track', this.track);
        this.emit('state', this.state);
        this.emit('progress', { elapsed: this.elapsed, duration: this.duration });
    }

    sendToSpeaker(command) {
        if (!this.speaker.send(command) && command.cmd === 'load') {
            logger.warn('usb', 'No browser is connected to play the sound (audio port)');
        }
    }

    pause() {
        if (this.state !== STATE.PLAY) {
            return;
        }
        this.state = STATE.PAUSE;
        this.stopHold();
        this.sendToSpeaker({ cmd: 'pause' });
        this.emit('state', this.state);
    }

    resume() {
        if (!this.hasQueue() || this.state === STATE.PLAY) {
            return;
        }
        if (this.state === STATE.STOPPED) {
            // the list ended: play it again from the beginning
            this.buildOrder(this.shuffle === SHUFFLE.ON ? this.currentIndex() : 0);
            this.loadCurrent(0);
            return;
        }
        this.onBeforePlay();
        this.state = STATE.PLAY;
        this.sendToSpeaker({ cmd: 'play' });
        this.emit('state', this.state);
    }

    stop() {
        this.stopHold();
        this.state = STATE.STOPPED;
        this.sendToSpeaker({ cmd: 'stop' });
        this.emit('state', this.state);
    }

    // Skip button / steering wheel: wraps around at the end of the list.
    next() {
        if (!this.hasQueue()) {
            return;
        }
        this.stopHold();
        this.cursor = (this.cursor + 1) % this.order.length;
        this.loadCurrent(0);
    }

    previous() {
        if (!this.hasQueue()) {
            return;
        }
        this.stopHold();
        if (this.elapsed > RESTART_THRESHOLD_S) {
            this.seekTo(0);
            return;
        }
        this.cursor = (this.cursor - 1 + this.order.length) % this.order.length;
        this.loadCurrent(0);
    }

    seekTo(seconds) {
        if (!this.hasQueue()) {
            return;
        }
        const limit = this.duration > 0 ? this.duration : Number.MAX_SAFE_INTEGER;
        this.elapsed = Math.min(Math.max(0, seconds), limit);
        this.sendToSpeaker({ cmd: 'seek', position: this.elapsed });
        this.emit('progress', { elapsed: Math.floor(this.elapsed), duration: this.duration });
    }

    seekPercent(percent) {
        if (this.duration > 0) {
            this.seekTo((this.duration * Math.min(Math.max(0, Number(percent) || 0), 100)) / 100);
        }
    }

    // Holding the next / previous button winds the track forward or back.
    startHold(direction) {
        this.stopHold();
        if (!this.hasQueue() || this.state === STATE.STOPPED) {
            return;
        }
        this.holdTimer = this.setIntervalFn(
            () => this.seekTo(this.elapsed + direction * HOLD_STEP_S),
            HOLD_INTERVAL_MS
        );
    }

    stopHold() {
        if (this.holdTimer) {
            this.clearIntervalFn(this.holdTimer);
            this.holdTimer = null;
        }
    }

    cycleRepeat() {
        this.repeat = REPEAT_CYCLE[(REPEAT_CYCLE.indexOf(this.repeat) + 1) % REPEAT_CYCLE.length];
        this.emit('modes', this.modes());
    }

    toggleShuffle() {
        this.shuffle = this.shuffle === SHUFFLE.ON ? SHUFFLE.OFF : SHUFFLE.ON;
        if (this.hasQueue()) {
            this.buildOrder(this.currentIndex());
        }
        this.emit('modes', this.modes());
    }

    modes() {
        return { repeat: this.repeat, shuffle: this.shuffle };
    }

    // The browser (re)connected: tell it what should be playing.
    resyncSpeaker() {
        const file = this.currentFile();
        if (!file || this.state === STATE.STOPPED) {
            return;
        }
        this.sendToSpeaker({
            cmd: 'load',
            url: mediaUrl(file),
            position: this.elapsed,
            play: this.state === STATE.PLAY
        });
    }

    // What the audio element reports: { evt: 'loaded', duration } | { evt: 'time', time } |
    // { evt: 'ended' } | { evt: 'error' } | { evt: 'playing' } | { evt: 'paused' }.
    handleSpeakerEvent(event) {
        if (!event || !this.hasQueue()) {
            return;
        }
        switch (event.evt) {
            case 'loaded':
                this.duration = Number.isFinite(event.duration) ? Math.floor(event.duration) : 0;
                this.failedInARow = 0;
                this.emit('progress', { elapsed: Math.floor(this.elapsed), duration: this.duration });
                break;
            case 'time': {
                const whole = Math.floor(Number(event.time) || 0);
                const changed = whole !== Math.floor(this.elapsed);
                this.elapsed = Number(event.time) || 0;
                if (changed) {
                    this.emit('progress', { elapsed: whole, duration: this.duration });
                }
                break;
            }
            case 'ended':
                this.handleEnded();
                break;
            case 'error':
                this.handleError();
                break;
            case 'blocked':
                // the browser refused to start the sound without a click: show it as paused
                if (this.state === STATE.PLAY) {
                    this.state = STATE.PAUSE;
                    this.emit('state', this.state);
                }
                break;
            default:
                break;
        }
    }

    handleEnded() {
        if (this.state === STATE.STOPPED) {
            return;
        }
        if (this.repeat === REPEAT.ONE) {
            this.loadCurrent(0);
        } else if (this.cursor + 1 < this.order.length) {
            this.cursor += 1;
            this.loadCurrent(0);
        } else if (this.repeat === REPEAT.ALL) {
            this.cursor = 0;
            this.loadCurrent(0);
        } else {
            // end of the list: the head unit stops on the last track
            this.state = STATE.STOPPED;
            this.emit('state', this.state);
            this.emit('endOfList');
        }
    }

    // A file the browser cannot decode is skipped, but not forever when none of them play.
    handleError() {
        const file = this.currentFile();
        logger.warn('usb', 'The browser cannot play %s', file ? file.relPath : '?');
        this.failedInARow += 1;
        if (this.failedInARow >= this.queue.length) {
            this.failedInARow = 0;
            this.stop();
            return;
        }
        this.handleEnded();
    }

    snapshot() {
        return {
            hasQueue: this.hasQueue(),
            state: this.state,
            track: this.track,
            elapsed: Math.floor(this.elapsed),
            duration: this.duration,
            index: this.currentIndex(),
            count: this.queue.length,
            filter: this.filter,
            repeat: this.repeat,
            shuffle: this.shuffle
        };
    }
}

module.exports = { UsbPlayer, REPEAT, SHUFFLE, STATE };
