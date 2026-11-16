const protocol = require('../protocol');
const navigationState = require('../state/navigationState');
const logger = require('../../logger');
const { getPhone } = require('../services/btPhone');
const audioFocus = require('../services/audioFocus');
const speaker = require('../services/speaker');

// Counterpart of libjciuiamobile911.so: Mobile 911 (emergency call assist). The call itself is
// the state machine of services/emergencyCall.js; this application shows its screens, plays the
// firmware's voice prompts and reports the call to the GUI.

const UIA_ID = 'mobile911';
const EMERGENCY_NUMBER = '911';
const PROMPTS = '/jci/bteca/prompts/English/';
const SCREENS = {
    countdown: 'CollisionDetectedDialog',
    searching: 'SearchingFor911Phone',
    noPhone: 'PhoneNotFound',
    noConnection: 'NoConnectionUsePhoneAlert',
    connecting: 'Active911CallConnecting',
    connected: 'Active911CallConnected',
    handset: 'CallOnMobileDevice'
};

const clients = new Set();
const subscribed = new WeakSet();
// The screen the emergency call interrupted; it comes back when the call ends.
let interrupted = null;
let connectedAt = null;
let promptTimer = null;

function sendMsg(ws, msgId, payload) {
    ws.send(
        JSON.stringify({ msgType: 'msg', uiaId: UIA_ID, msgId: msgId, params: { payload: payload } })
    );
    logger.debug('mobile911', 'Sent message msgId=%s', msgId);
}

function prompt(name) {
    speaker.send({ cmd: 'sound', id: 'eca', url: PROMPTS + name + '.wav', loop: false, gapMs: 0 });
}

function stopPrompt() {
    clearTimeout(promptTimer);
    promptTimer = null;
    speaker.send({ cmd: 'soundStop', id: 'eca' });
}

function onScreen() {
    const current = navigationState.current;
    return current.uiaId === UIA_ID;
}

function show(ws, state) {
    protocol.sendContextChange(ws, UIA_ID, SCREENS[state], undefined, undefined, true);
}

function onState(emergency, { state, reason }) {
    if (state === 'countdown' || (state === 'searching' && reason === 'sos' && !interrupted && !onScreen())) {
        // the call takes the speakers and the screen
        getPhone().calls.hangup();
        audioFocus.suspendForCall();
        const current = navigationState.current;
        interrupted = current && current.uiaId && current.uiaId !== UIA_ID ? Object.assign({}, current) : null;
    }
    clients.forEach((ws) => {
        switch (state) {
            case 'connecting':
                sendMsg(ws, 'StartElapsedTimeCount', {});
                sendMsg(ws, 'DisableTransfer', { disabled: 'Off' });
                break;
            case 'connected':
                sendMsg(ws, 'ShowPSAPInfoInscription', { showPSAPInfo: 'Show' });
                break;
            default:
                break;
        }
        show(ws, state);
        if (state === 'countdown') {
            // The dialog takes the countdown only while it is on screen, and counts down itself.
            sendMsg(ws, 'TimeIn', { Duration: String(emergency.countdownS) });
        }
    });
    // the voice of the unit
    stopPrompt();
    if (state === 'countdown') prompt('CancelTimer');
    else if (state === 'searching' && reason === 'sos') prompt('Call911');
    else if (state === 'noPhone') prompt('NoDevice');
    else if (state === 'noConnection') prompt('CallFailure');
    else if (state === 'connected') {
        connectedAt = Date.now();
        prompt('CallConnected');
        promptTimer = setTimeout(() => prompt('ProvideInfo'), 2500);
    }
}

function onEnded(_emergency, { placed }) {
    stopPrompt();
    const back = interrupted;
    interrupted = null;
    if (placed) {
        const seconds = connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : 0;
        getPhone().calls.record(EMERGENCY_NUMBER, 'dialed', seconds);
    }
    connectedAt = null;
    // decided once, not per client: switching one client's screen changes what "on screen" says
    const showing = onScreen();
    clients.forEach((ws) => {
        sendMsg(ws, 'EndElapsedTimeCount', {});
        if (showing) {
            if (back) {
                protocol.sendContextChange(ws, back.uiaId, back.ctxtId, back.params, undefined, true);
            } else {
                protocol.sendContextChange(ws, 'system', 'HomeScreen');
            }
        }
    });
    audioFocus.resumeAfterCall();
}

function subscribe(emergency) {
    if (subscribed.has(emergency)) {
        return;
    }
    subscribed.add(emergency);
    emergency.on('state', (change) => onState(emergency, change));
    emergency.on('ended', (result) => onEnded(emergency, result));
}

// A connected GUI hears about the emergency call until it disconnects.
function attach(ws) {
    subscribe(getPhone().emergency);
    clients.add(ws);
    if (typeof ws.once === 'function') {
        ws.once('close', () => clients.delete(ws));
    }
}

// Global.Cancel on the "searching" dialog and Global.GoBack on the "no connection" alert end the
// emergency call. Returns false when neither is on screen.
function handleDismiss(_ws) {
    const current = navigationState.current;
    if (current.uiaId !== UIA_ID || !['SearchingFor911Phone', 'NoConnectionUsePhoneAlert'].includes(current.ctxtId)) {
        return false;
    }
    getPhone().emergency.hangup();
    return true;
}

const emergency = () => getPhone().emergency;

const events = {
    HangUp: () => emergency().hangup(),
    SelectRetry: () => emergency().retry(),
    TransferToHandset: () => emergency().transferToHandset(),
    TransferFromHandset: () => emergency().transferFromHandset(),
    BargeIntoCall: () => {}
};

module.exports = {
    events: events,
    attach: attach,
    clients: clients,
    handleDismiss: handleDismiss
};
