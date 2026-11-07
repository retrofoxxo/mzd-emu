const audioFocus = require('../services/audioFocus');

// The transport keys of every audio source: the Now Playing buttons, the steering wheel and the
// voice control all send these, and the firmware routes them to the source that is active.
// Here that is the one holding the audio focus (services/audioFocus.js).
function onPlayer(action) {
    return () => {
        const player = audioFocus.currentPlayer();
        if (player) {
            action(player);
        }
    };
}

const events = {
    'Global.Play': onPlayer((player) => player.resume()),
    'Global.Resume': onPlayer((player) => player.resume()),
    'Global.Pause': onPlayer((player) => player.pause()),
    'Global.Next': onPlayer((player) => player.next()),
    'Global.Previous': onPlayer((player) => player.previous()),
    'Global.NextHoldStart': onPlayer((player) => player.startHold(1)),
    'Global.FastForward': onPlayer((player) => player.startHold(1)),
    'Global.NextHoldStop': onPlayer((player) => player.stopHold()),
    'Global.PreviousHoldStart': onPlayer((player) => player.startHold(-1)),
    'Global.Rewind': onPlayer((player) => player.startHold(-1)),
    'Global.PreviousHoldStop': onPlayer((player) => player.stopHold())
};

module.exports = { events: events };
