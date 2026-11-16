const { EventEmitter } = require('node:events');

// The calls of the virtual phone (see btPhone.js). There is no telephone line: an outgoing call
// "rings" and is answered after a moment, an incoming call is started from the emulator controls,
// and the call runs until someone hangs up. What the head unit does with them (the dial pad, the
// call screens, the sounds, the call history) is the real thing.
//
// Events: 'dialing', 'incoming', 'active', 'ended' ({ call, entry }), 'mute', 'audio'.
class PhoneCalls extends EventEmitter {
    constructor({
        answerMs = 3000,
        ringMs = 30000,
        now = Date.now,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout
    } = {}) {
        super();
        this.answerMs = answerMs;
        this.ringMs = ringMs;
        this.now = now;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.call = null;
        this.timer = null;
        this.nextId = 1;
        this.dialNumber = ''; // what is typed on the dial pad
        this.nextHistoryId = 1;
        this.history = []; // newest first: { id, number, direction, at, duration }
    }

    // The calls already in the history when the emulator starts (config/bluetooth.json).
    seedHistory(entries) {
        this.history = [];
        (entries || []).forEach((entry) => {
            if (['dialed', 'received', 'missed'].includes(entry.direction) && entry.number) {
                this.history.push({
                    id: this.nextHistoryId++,
                    number: String(entry.number),
                    direction: entry.direction,
                    at: this.now() - (Number(entry.minutesAgo) || 0) * 60000,
                    duration: Number(entry.duration) || 0
                });
            }
        });
        this.history.sort((a, b) => b.at - a.at);
    }

    isBusy() {
        return this.call !== null;
    }

    setTimer(action, ms) {
        this.clearTimer();
        this.timer = this.setTimeoutFn(action, ms);
    }

    clearTimer() {
        if (this.timer) {
            this.clearTimeoutFn(this.timer);
            this.timer = null;
        }
    }

    // Starts an outgoing call; the other side answers after answerMs.
    dial(number) {
        const digits = String(number || '').trim();
        if (this.call || digits === '') {
            return false;
        }
        this.call = this.newCall(digits, 'out', 'dialing');
        this.emit('dialing', this.call);
        this.setTimer(() => this.connect(), this.answerMs);
        return true;
    }

    // A call coming in (from the emulator controls); it is missed when nobody answers.
    incoming(number) {
        const digits = String(number || '').trim();
        if (this.call || digits === '') {
            return false;
        }
        this.call = this.newCall(digits, 'in', 'ringing');
        this.emit('incoming', this.call);
        this.setTimer(() => this.end('missed'), this.ringMs);
        return true;
    }

    newCall(number, direction, phase) {
        return {
            id: this.nextId++,
            number: number,
            direction: direction,
            phase: phase,
            startedAt: this.now(),
            connectedAt: null,
            muted: false,
            audio: 'Vehicle' // through the car's speakers; 'Handset' is the phone's own
        };
    }

    connect() {
        if (!this.call || this.call.phase === 'active') {
            return;
        }
        this.clearTimer();
        this.call.phase = 'active';
        this.call.connectedAt = this.now();
        this.emit('active', this.call);
    }

    answer() {
        if (this.call && this.call.direction === 'in' && this.call.phase === 'ringing') {
            this.connect();
        }
    }

    // Ignore an incoming call: it counts as missed.
    reject() {
        if (this.call && this.call.phase === 'ringing') {
            this.end('missed');
        }
    }

    hangup() {
        if (!this.call) {
            return;
        }
        if (this.call.phase === 'ringing') {
            this.end('missed');
        } else {
            this.end(this.call.direction === 'out' ? 'dialed' : 'received');
        }
    }

    // `direction` is how it goes in the call history: dialed, received or missed.
    end(direction) {
        if (!this.call) {
            return;
        }
        this.clearTimer();
        const call = this.call;
        this.call = null;
        const duration = call.connectedAt ? Math.round((this.now() - call.connectedAt) / 1000) : 0;
        const entry = {
            id: this.nextHistoryId++,
            number: call.number,
            direction: direction,
            at: this.now(),
            duration: duration
        };
        this.history.unshift(entry);
        this.emit('ended', { call: call, entry: entry });
    }

    // A call the phone made outside this class (the emergency call): it is only recorded.
    record(number, direction, duration) {
        this.history.unshift({
            id: this.nextHistoryId++,
            number: String(number),
            direction: direction,
            at: this.now(),
            duration: duration || 0
        });
    }

    toggleMute() {
        if (this.call && this.call.phase === 'active') {
            this.call.muted = !this.call.muted;
            this.emit('mute', this.call);
        }
    }

    // The call audio through the car or through the phone.
    toggleAudio() {
        if (this.call && this.call.phase === 'active') {
            this.call.audio = this.call.audio === 'Vehicle' ? 'Handset' : 'Vehicle';
            this.emit('audio', this.call);
        }
    }

    lastDialed() {
        const entry = this.history.find((item) => item.direction === 'dialed');
        return entry ? entry.number : '';
    }
}

module.exports = { PhoneCalls };
