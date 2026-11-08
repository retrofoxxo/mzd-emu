const protocol = require('../protocol');
const navigationState = require('../state/navigationState');
const speaker = require('./speaker');
const logger = require('../../logger');

// The head unit's display: Settings > Display > "Turn display off" and "Turn display off and
// show clock". The GUI has one DisplayOff screen (it shows the clock, and any touch or key
// press on it ends it); the backlight is hardware, so it is switched through the browser
// (client/ui-usb-audio.js dims the page) with the same socket that carries the sound.
//
// mode: 'on' (normal), 'off' (backlight off), 'clock' (only the clock is lit).
const state = { mode: 'on', interrupted: null, notification: false };

function setBacklight(on) {
    speaker.send({ cmd: 'backlight', on: on });
}

function show(ws, mode) {
    if (state.mode === 'on') {
        const current = navigationState.current;
        state.interrupted = current && current.uiaId ? Object.assign({}, current) : null;
    }
    state.mode = mode;
    state.notification = false;
    setBacklight(mode === 'clock');
    logger.info('display', mode === 'clock' ? 'Display off, clock shown' : 'Display off');
    // transient: the screen that was showing stays on the go-back stack
    protocol.sendContextChange(ws, 'system', 'DisplayOff', undefined, undefined, true);
}

function turnOff(ws) {
    show(ws, 'off');
}

function showClock(ws) {
    show(ws, 'clock');
}

// Any touch or key press on the off screen: the display comes back on the screen it left.
function wake(ws) {
    if (state.mode === 'on') {
        return;
    }
    state.mode = 'on';
    state.notification = false;
    setBacklight(true);
    const previous = state.interrupted;
    state.interrupted = null;
    if (previous && !(previous.uiaId === 'system' && previous.ctxtId === 'DisplayOff')) {
        protocol.sendContextChange(ws, previous.uiaId, previous.ctxtId, previous.params, undefined, true);
    } else {
        navigationState.goBackStack = [];
        protocol.sendContextChange(ws, 'system', 'HomeScreen');
    }
}

// The GUI shows a notification while the display is off: it asks for the display to be lit for
// as long as the notification is up.
function notificationActive(active) {
    if (state.mode !== 'off' && state.mode !== 'clock') {
        return;
    }
    state.notification = Boolean(active);
    setBacklight(state.notification || state.mode === 'clock');
}

module.exports = {
    turnOff: turnOff,
    showClock: showClock,
    wake: wake,
    notificationActive: notificationActive,
    mode: () => state.mode,
    reset: () => {
        state.mode = 'on';
        state.interrupted = null;
        state.notification = false;
    }
};
