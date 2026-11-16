const protocol = require('../protocol');
const navigationState = require('../state/navigationState');
const logger = require('../../logger');
const { getPhone } = require('../services/btPhone');
const audioFocus = require('../services/audioFocus');
const speaker = require('../services/speaker');

// Counterpart of libjciuiaphone.so: the dial pad, the call screens and the phone sounds, for the
// calls of the virtual phone (services/phoneCalls.js).

const UIA_ID = 'phone';
const CALL_SCREENS = ['DialPad', 'IncomingCall', 'ActiveCall', 'ActiveCallDTMF'];

// The firmware's own phone sounds (jci/bthf/prompts), played by the browser.
const SOUNDS = {
    ring: { url: '/jci/bthf/prompts/IncomingCall_englishUS.wav', gapMs: 1200 },
    ringback: { url: '/jci/bthf/prompts/beep3.wav', gapMs: 2600 },
    chime: { url: '/jci/bthf/prompts/beep3.wav' }
};

const clients = new Set();
const subscribed = new WeakSet();
// The screen a call interrupted: it comes back when the call ends.
let interrupted = null;

function sendMsg(ws, uiaId, msgId, payload) {
    ws.send(
        JSON.stringify({ msgType: 'msg', uiaId: uiaId, msgId: msgId, params: { payload: payload } })
    );
    logger.debug('phone', 'Sent message uiaId=%s msgId=%s', uiaId, msgId);
}

const sendPhone = (ws, msgId, payload) => sendMsg(ws, UIA_ID, msgId, payload);

function playSound(name, loop) {
    const sound = SOUNDS[name];
    speaker.send({ cmd: 'sound', id: name, url: sound.url, loop: loop === true, gapMs: sound.gapMs || 0 });
}

function stopSound(name) {
    speaker.send({ cmd: 'soundStop', id: name });
}

// ------------------------------------------------------------------ messages for a call

function callIdInfo(call) {
    return {
        callIdInfoMsg: {
            callId: String(call.id),
            cmuorphone: call.audio,
            phoneNumber: call.number,
            deviceName: getPhone().name()
        }
    };
}

function activeCallInfo(call, type) {
    return {
        activeCallInfoMsg: {
            type: type,
            callId: String(call.id),
            cmuorphone: call.audio,
            mute: call.muted ? 'Mute' : 'Unmute',
            phoneNumber: call.number
        }
    };
}

function sendCallStatus(ws, status) {
    sendMsg(ws, 'system', 'StatusPhoneCall', { phoneCallStatus: status });
}

// Remembers the screen a call is breaking into.
function rememberScreen() {
    const current = navigationState.current;
    if (!current || !current.uiaId) {
        interrupted = null;
    } else if (!(current.uiaId === UIA_ID && CALL_SCREENS.includes(current.ctxtId) && current.ctxtId !== 'DialPad')) {
        interrupted = Object.assign({}, current);
    }
}

function showScreen(ws, ctxtId) {
    protocol.sendContextChange(ws, UIA_ID, ctxtId, undefined, undefined, true);
}

function onDialing(call) {
    audioFocus.suspendForCall();
    rememberScreen();
    clients.forEach((ws) => {
        sendPhone(ws, 'CallIdInfo', callIdInfo(call));
        sendPhone(ws, 'ActiveCallInfo', activeCallInfo(call, 'Connecting'));
        sendCallStatus(ws, 'Connecting');
        showScreen(ws, 'ActiveCall');
    });
    playSound('ringback', true);
}

function onIncoming(call) {
    audioFocus.suspendForCall();
    rememberScreen();
    clients.forEach((ws) => {
        sendPhone(ws, 'CallIdInfo', callIdInfo(call));
        showScreen(ws, 'IncomingCall');
    });
    playSound('ring', true);
}

function onActive(call) {
    stopSound('ring');
    stopSound('ringback');
    playSound('chime', false);
    clients.forEach((ws) => {
        sendPhone(ws, 'CallIdInfo', callIdInfo(call));
        sendPhone(ws, 'ActiveCallInfo', activeCallInfo(call, 'ActiveCall'));
        sendCallStatus(ws, 'ActiveCall');
        showScreen(ws, 'ActiveCall');
    });
}

function onEnded({ call }) {
    stopSound('ring');
    stopSound('ringback');
    playSound('chime', false);
    const back = interrupted;
    interrupted = null;
    // decided once, not per client: switching one client's screen changes what is "on screen"
    const current = navigationState.current;
    const showingCall =
        current.uiaId === UIA_ID && ['IncomingCall', 'ActiveCall', 'ActiveCallDTMF'].includes(current.ctxtId);
    clients.forEach((ws) => {
        sendPhone(ws, 'ShowCallEndSbn', { callId: String(call.id) });
        sendPhone(ws, 'NoCallState', { callState: 'NoCall' });
        sendCallStatus(ws, 'NoCall');
        if (showingCall) {
            if (back) {
                protocol.sendContextChange(ws, back.uiaId, back.ctxtId, back.params, undefined, true);
            } else {
                protocol.sendContextChange(ws, 'system', 'HomeScreen');
            }
        }
    });
    audioFocus.resumeAfterCall();
}

function subscribe(calls) {
    if (subscribed.has(calls)) {
        return;
    }
    subscribed.add(calls);
    calls.on('dialing', onDialing);
    calls.on('incoming', onIncoming);
    calls.on('active', onActive);
    calls.on('ended', onEnded);
    calls.on('mute', (call) =>
        clients.forEach((ws) => {
            sendPhone(ws, 'MuteStatus', { mute: call.muted ? 'on' : 'off' });
            sendPhone(ws, 'ActiveCallInfo', activeCallInfo(call, 'ActiveCall'));
        })
    );
    calls.on('audio', (call) =>
        clients.forEach((ws) => sendPhone(ws, 'ActiveCallInfo', activeCallInfo(call, 'ActiveCall')))
    );
}

// A connected GUI hears about every call until it disconnects.
function attach(ws) {
    subscribe(getPhone().calls);
    clients.add(ws);
    if (typeof ws.once === 'function') {
        ws.once('close', () => clients.delete(ws));
    }
}

// ------------------------------------------------------------------ the GUI's events

function connectedCalls() {
    const phone = getPhone();
    return phone.phoneOn() ? phone.calls : null;
}

// Communication > Dial Phone.
function handleSelectPhone(ws) {
    const calls = connectedCalls();
    if (!calls) {
        return;
    }
    attach(ws);
    if (calls.call) {
        showScreen(ws, calls.call.phase === 'ringing' ? 'IncomingCall' : 'ActiveCall');
        return;
    }
    sendPhone(ws, 'DialpadNumber', { phoneNumber: calls.dialNumber });
    protocol.sendContextChange(ws, UIA_ID, 'DialPad');
}

// The phone book and call history are available while the phone is connected (the GUI reads
// them through the DB API socket, see services/dbapiService.js).
function sendConnectStatus(ws) {
    const connected = getPhone().phoneOn();
    sendPhone(ws, 'PbConnectStatus', {
        connStatus: connected ? 'connected' : 'noDevice',
        deviceId: 1
    });
    // The lists are greyed out (and "Loading") until the phone book and the call history are
    // said to be downloaded; the virtual phone has them at once.
    sendPhone(ws, 'DbGreyOut', { ContactsDb: !connected, CallHistoryDb: !connected });
    sendPhone(ws, 'CHAutoStatus', { status: false });
}

function openList(ws, ctxtId) {
    if (!connectedCalls()) {
        return;
    }
    attach(ws);
    sendConnectStatus(ws);
    protocol.sendContextChange(ws, UIA_ID, ctxtId);
}

function dialFrom(ws, number) {
    const calls = connectedCalls();
    if (calls && number) {
        attach(ws);
        calls.dial(String(number));
    }
}

// A contact of the list: one number is called, several are offered to choose from.
function handleSelectContactName(ws, params) {
    const payload = params && params.payload;
    const calls = connectedCalls();
    const contact = payload ? getPhone().phonebook.byId(payload.contactId) : null;
    if (!calls || !contact) {
        return;
    }
    if (contact.numbers.length <= 1) {
        dialFrom(ws, contact.numbers[0] && contact.numbers[0].number);
        return;
    }
    // Several numbers: by type when the types differ (mobile, work, ...), else by number.
    const types = new Set(contact.numbers.map((entry) => entry.category));
    const ctxtId = types.size > 1 ? 'TypeDisambiguation' : 'NumberDisambiguation';
    sendPhone(ws, ctxtId, { contactId: contact.contactId, contactType: 'All' });
    protocol.sendContextChange(ws, UIA_ID, ctxtId);
}

const events = {
    SelectPhone: handleSelectPhone,
    SelectDialPad: handleSelectPhone,
    SelectContacts: (ws) => openList(ws, 'ChoosePhoneContact'),
    SelectCallHistory: (ws) => openList(ws, 'RecentCalls'),
    SelectRecentCalls: (ws) => openList(ws, 'RecentCalls'),
    SelectComMenu: (ws) => protocol.sendContextChange(ws, 'system', 'Communication'),
    SelectContactName: handleSelectContactName,
    SelectPhoneNumber: (ws, params) => dialFrom(ws, params && params.payload && params.payload.phoneNumber),
    CallRecentByLine: (ws, params) => dialFrom(ws, params && params.payload && params.payload.phoneNumber),
    // the dial pad keeps the number; the GUI reports it with every key
    DialpadUpdateNumericField: (_ws, params) => {
        const calls = connectedCalls();
        if (calls && params && params.payload) {
            calls.dialNumber = String(params.payload.phoneNumber || '');
        }
    },
    CallDialpadNumber: (ws) => {
        const calls = connectedCalls();
        if (calls) {
            attach(ws);
            calls.dial(calls.dialNumber);
        }
    },
    SystemRedial: (ws) => {
        const calls = connectedCalls();
        if (calls) {
            attach(ws);
            calls.dial(calls.lastDialed());
        }
    },
    SelectAnswer: () => {
        const calls = connectedCalls();
        if (calls) calls.answer();
    },
    SelectIgnore: () => {
        const calls = connectedCalls();
        if (calls) calls.reject();
    },
    SelectEndCall: () => {
        const calls = connectedCalls();
        if (calls) calls.hangup();
    },
    SelectMuteCall: () => {
        const calls = connectedCalls();
        if (calls) calls.toggleMute();
    },
    // the audio of the call through the car or through the phone
    SelectCMUAudio: () => {
        const calls = connectedCalls();
        if (calls) calls.toggleAudio();
    },
    SelectDtmfShow: (ws) => showScreen(ws, 'ActiveCallDTMF'),
    SelectDtmfHide: (ws) => showScreen(ws, 'ActiveCall'),
    SelectKeypadDigit: (ws, params) => {
        if (params && params.payload && params.payload.digit != null) {
            sendPhone(ws, 'ShowDtmfDigit', { digit: params.payload.digit });
        }
    }
};

module.exports = {
    events: events,
    attach: attach,
    sendConnectStatus: sendConnectStatus,
    clients: clients,
    handleSelectPhone: handleSelectPhone
};
