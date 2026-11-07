const protocol = require('../protocol');
const navigationState = require('../state/navigationState');

// Back from an audio source (USB, Bluetooth) to the Entertainment menu that opened it. The
// source's own screens are not on the go-back stack, so the menu is still its top entry and is
// shown again without a new entry.
function leaveToEntertainment(ws) {
    // Lazy: systemApp needs the audio sources for the menu status.
    const systemApp = require('../uia/systemApp');
    const stack = navigationState.goBackStack;
    const top = stack[stack.length - 1];
    if (top && top.uiaId === 'system' && top.ctxtId === 'Entertainment') {
        systemApp.sendEntertainmentStatus(ws);
        protocol.sendContextChange(ws, top.uiaId, top.ctxtId, top.params, top.contextSeq, true);
    } else {
        systemApp.handleSelectEntertainment(ws);
    }
}

module.exports = { leaveToEntertainment };
