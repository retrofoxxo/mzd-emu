// The head unit has one loudspeaker, so one audio source plays at a time (USB, Bluetooth). A
// source registers its player under a name and calls acquire() before it makes sound; that
// pauses the source that played before. The transport keys (Global.Play, Global.Next, ...) and
// the state reports of the browser's audio element go to the source that holds the focus.
const players = new Map();
let current = null;

module.exports = {
    register(name, player) {
        players.set(name, player);
    },
    acquire(name) {
        if (current === name) {
            return;
        }
        players.forEach((player, other) => {
            if (other !== name && player.snapshot().state === 'PLAY') {
                player.pause();
            }
        });
        current = name;
    },
    currentName() {
        return current;
    },
    currentPlayer() {
        return current ? players.get(current) || null : null;
    },
    // An event of the browser's audio element.
    dispatch(event) {
        const player = this.currentPlayer();
        if (player) {
            player.handleSpeakerEvent(event);
        }
    },
    // The browser (re)connected: it must continue what plays now.
    resync() {
        const player = this.currentPlayer();
        if (player) {
            player.resyncSpeaker();
        }
    },
    reset() {
        players.clear();
        current = null;
    }
};
