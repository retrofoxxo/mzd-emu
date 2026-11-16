const protocol = require('../protocol');
const sendContextChange = protocol.sendContextChange;
const navigationState = require('../state/navigationState');
const settings = require('../services/settings');
const { getWifi, SECURITY, MODE } = require('../services/wifi');
const logger = require('../../logger');

// Counterpart of libjciuianetmgmt.so: the Wi-Fi settings. The networks "in range" are the virtual
// ones of config/wifi.json (services/wifi.js); the screens and their flows are the firmware's.

const UIA_ID = 'netmgmt';
const NETWORK_LIST_CONTEXTS = ['NetworkOptions', 'NetworkOptionsStation'];

// Dialog state (what the shared Global.Yes answers, see commonApp.js). The dialog only counts
// while it is the screen, so a flag left over from leaving it by Back cannot catch a later Yes.
let invalidInputShown = false;
const dialogs = {
    get invalidInputActive() {
        const current = navigationState.current;
        return invalidInputShown && current.uiaId === UIA_ID && current.ctxtId === 'InvalidPassword';
    }
};

// The connection being made: { id, ssid, password, timer }.
let attempt = null;
let attemptCounter = 0;
// Where the password being typed belongs: a listed network ('visible') or the hidden one.
let passwordFlow = 'visible';
// The remembered network the user is about to delete.
let pendingDelete = null;

function sendMsg(ws, msgId, payload) {
    ws.send(
        JSON.stringify({ msgType: 'msg', uiaId: UIA_ID, msgId: msgId, params: { payload: payload } })
    );
    logger.debug('netmgmt', 'Sent message msgId=%s', msgId);
}

function sendWifiStatus(ws) {
    const wifi = getWifi();
    wifi.autoConnect();
    sendMsg(ws, 'WifiStatus', wifi.status());
}

function sendLists(ws) {
    const wifi = getWifi();
    sendMsg(ws, 'ScannedNetworksList', wifi.scanList());
    sendMsg(ws, 'RememberedNetworksList', wifi.rememberedList());
}

function sendWifiState(ws) {
    const wifi = getWifi();
    wifi.autoConnect();
    sendMsg(ws, 'WifiMode', { mode: settings.currentSettings.wifiMode });
    sendMsg(ws, 'WifiStatus', wifi.status());
    sendLists(ws);
}

// Shows again the newest screen of this application on the go-back stack that is one of
// `contexts`, dropping what was opened above it.
function showStacked(ws, contexts) {
    const stack = navigationState.goBackStack;
    for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i];
        if (entry.uiaId === UIA_ID && contexts.includes(entry.ctxtId)) {
            navigationState.goBackStack = stack.slice(0, i + 1);
            sendContextChange(ws, entry.uiaId, entry.ctxtId, entry.params, entry.contextSeq, true);
            return true;
        }
    }
    return false;
}

function backToNetworkList(ws) {
    if (!showStacked(ws, NETWORK_LIST_CONTEXTS)) {
        sendContextChange(ws, UIA_ID, 'NetworkOptions');
    }
}

function handleSelectNetworkManagement(ws) {
    sendWifiState(ws);
    if (settings.HARDWARE_CONFIG.appleWirelessCarPlayAvailable === 'On') {
        sendContextChange(ws, UIA_ID, 'NetworkOptionsOffAP');
    } else {
        sendContextChange(ws, UIA_ID, 'NetworkOptions');
    }
    // The screen draws its switch and list from the last messages when it opens, but only
    // updates itself from messages that arrive while it is up: so they are sent again.
    sendWifiState(ws);
}

function handleSetWifiConnection(ws, params) {
    const wifi = getWifi();
    const offOn = params && params.payload ? params.payload.offOn : 0;
    settings.currentSettings.wifiMode = offOn === 1 ? MODE.CLIENT : MODE.OFF;
    settings.saveUserSettings();
    cancelAttempt();
    if (offOn !== 1) {
        wifi.disconnectAll();
    } else {
        wifi.switchedOn();
    }
    sendWifiState(ws);
}

function handleSelectNetworkConnection(ws) {
    const ctxtId =
        settings.HARDWARE_CONFIG.appleWirelessCarPlayAvailable === 'On' ? 'Mode2' : 'Mode3';
    sendContextChange(ws, UIA_ID, ctxtId);
}

function handleSelectWifiMode(ws, params) {
    if (params && params.payload && params.payload.wifiMode != null) {
        settings.currentSettings.wifiMode = params.payload.wifiMode;
        settings.saveUserSettings();
        cancelAttempt();
        if (params.payload.wifiMode !== MODE.CLIENT) {
            getWifi().disconnectAll();
        } else {
            getWifi().switchedOn();
        }
        sendWifiState(ws);
    }
}

// ------------------------------------------------------------------ connecting

function cancelAttempt() {
    if (attempt && attempt.timer) {
        clearTimeout(attempt.timer);
    }
    attempt = null;
}

function armAttempt(ws) {
    const current = attempt;
    current.timer = setTimeout(() => finishAttempt(ws, current), getWifi().connectDelayMs());
}

// The "Connecting" dialog, then the result: connected, wrong password, or not reachable.
function beginConnect(ws, ssid, password) {
    cancelAttempt();
    attemptCounter += 1;
    attempt = { id: attemptCounter, ssid: ssid, password: password, timer: null };
    sendContextChange(ws, UIA_ID, 'Connecting');
    armAttempt(ws);
}

function finishAttempt(ws, finished) {
    // Cancelled, or replaced by another attempt, while it was running.
    if (attempt !== finished || navigationState.current.ctxtId !== 'Connecting') {
        return;
    }
    const wifi = getWifi();
    attempt.timer = null;
    const result = wifi.check(attempt.ssid, attempt.password);
    if (result === 'ok') {
        const ssid = attempt.ssid;
        wifi.connect(ssid, attempt.password);
        attempt = null;
        logger.info('wifi', 'Connected to %s', ssid);
        sendWifiState(ws);
        backToNetworkList(ws);
        // the list is drawn from what was last sent
        sendLists(ws);
    } else if (result === 'bad-password') {
        logger.info('wifi', 'Wrong password for %s', attempt.ssid);
        invalidInputShown = true;
        sendContextChange(ws, UIA_ID, 'InvalidPassword');
    } else {
        logger.info('wifi', 'Cannot reach %s', attempt.ssid);
        sendContextChange(ws, UIA_ID, 'ConnectionError');
    }
}

function handleRetryConnection(ws) {
    if (!attempt) {
        return;
    }
    // the error dialog goes away, the connecting dialog stays
    if (showStacked(ws, ['Connecting'])) {
        armAttempt(ws);
    }
}

// SelectNetwork: a network of the list. Connected: offer to disconnect. Remembered: connect.
// Otherwise the Connect screen, where the password is entered.
function handleSelectNetwork(ws, params) {
    const wifi = getWifi();
    const chosen = params && params.payload && params.payload.wifiNetwork;
    const network = chosen ? wifi.findByBssid(chosen.bssid) || wifi.find(chosen.ssid) : null;
    if (!network) {
        return;
    }
    if (wifi.connected === network.ssid) {
        sendContextChange(ws, UIA_ID, 'Disconnect', { payload: { networkName: network.ssid } });
        return;
    }
    const known = wifi.rememberedBySsid(network.ssid);
    if (known) {
        beginConnect(ws, network.ssid, known.password);
        return;
    }
    wifi.pending = { bssid: network.bssid, password: '' };
    passwordFlow = 'visible';
    // an open network needs no password: Connect is enabled at once
    sendMsg(ws, 'NewNetworkPassword', { password: network.securityType === 0 ? ' ' : '' });
    sendContextChange(ws, UIA_ID, 'Connect', {
        payload: { networkName: network.ssid, bssid: network.bssid }
    });
}

function handleSelectVisibleNetworkConnect(ws, params) {
    const wifi = getWifi();
    const bssid = params && params.payload ? params.payload.bssid : wifi.pending.bssid;
    const network = wifi.findByBssid(bssid);
    if (network) {
        beginConnect(ws, network.ssid, network.securityType === 0 ? '' : wifi.pending.password);
    }
}

function handleSelectDisconnect(ws) {
    getWifi().disconnect();
    sendWifiState(ws);
    backToNetworkList(ws);
    sendLists(ws);
}

// ------------------------------------------------------------------ password and names

// SelectPassword: the keyboard for a password (the WEP one takes hexadecimal keys only).
function handleSelectPassword(ws, params) {
    const wifi = getWifi();
    const bssid = params && params.payload ? params.payload.bssid : null;
    passwordFlow = bssid ? 'visible' : 'hidden';
    const securityType = bssid
        ? (wifi.findByBssid(bssid) || {}).securityType
        : wifi.hidden.securityType;
    if (securityType === SECURITY.WEP) {
        sendContextChange(ws, UIA_ID, 'WEPKeyboard');
    } else {
        sendContextChange(ws, UIA_ID, 'KeyboardInput', { payload: { isPassword: true } });
    }
}

function handleSelectNameSSID(ws) {
    sendContextChange(ws, UIA_ID, 'KeyboardInput', { payload: { isPassword: false } });
}

function sendHidden(ws) {
    sendMsg(ws, 'HiddenNetworkInfo', Object.assign({}, getWifi().hidden));
}

// SubmitKeyboardInput: the text typed, and whether the keyboard found it valid.
function handleSubmitKeyboardInput(ws, params) {
    const wifi = getWifi();
    const input = params && params.payload ? params.payload : null;
    if (!input) {
        return;
    }
    if (!input.isValid) {
        // a password of the wrong length or kind: said in the dialog, then the keyboard again
        invalidInputShown = true;
        sendContextChange(ws, UIA_ID, 'InvalidPassword');
        return;
    }
    if (input.type === 'name') {
        wifi.hidden.networkName = input.input;
        sendHidden(ws);
        showStacked(ws, ['OtherNetwork']);
    } else if (passwordFlow === 'hidden') {
        wifi.hidden.password = input.input;
        sendHidden(ws);
        showStacked(ws, ['OtherNetwork']);
    } else {
        wifi.pending.password = input.input;
        sendMsg(ws, 'NewNetworkPassword', { password: input.input });
        showStacked(ws, ['Connect']);
    }
}

// OK on the "invalid password" dialog: back to where the password is typed or the connection
// is set up.
function dismissInvalidInput(ws) {
    invalidInputShown = false;
    const wasAttempt = attempt !== null;
    attempt = null;
    if (wasAttempt) {
        // wrong password after connecting: back to the screen that started it
        if (!showStacked(ws, ['Connect', 'OtherNetwork', 'NetworkOptions', 'NetworkOptionsStation'])) {
            backToNetworkList(ws);
        }
    } else {
        showStacked(ws, ['KeyboardInput', 'WEPKeyboard']);
    }
}

// ------------------------------------------------------------------ a network that is not listed

function handleSelectOtherNetwork(ws) {
    getWifi().resetHidden();
    sendHidden(ws);
    sendContextChange(ws, UIA_ID, 'OtherNetwork');
}

function handleSelectSecurity(ws) {
    sendContextChange(ws, UIA_ID, 'SecurityOptions', {
        payload: { currentSecurityType: getWifi().hidden.securityType }
    });
}

function handleSelectSecurityType(ws, params) {
    const wifi = getWifi();
    if (params && params.payload && params.payload.securityType != null) {
        wifi.hidden.securityType = params.payload.securityType;
        if (params.payload.securityType === SECURITY.None) {
            wifi.hidden.password = '';
        }
        sendHidden(ws);
        showStacked(ws, ['OtherNetwork']);
    }
}

// SelectConnect: connect to the network typed by name. The access point only accepts the
// security it really uses.
function handleSelectConnect(ws) {
    const wifi = getWifi();
    const entered = wifi.hidden;
    const network = wifi.find(entered.networkName);
    const wrongSecurity = network && Number(entered.securityType || 0) !== network.securityType;
    beginConnect(ws, wrongSecurity ? '' : entered.networkName, entered.password);
}

// ------------------------------------------------------------------ delete

function handleSelectDeleteWiFiNetwork(ws) {
    sendMsg(ws, 'RememberedNetworksList', getWifi().rememberedList());
    sendContextChange(ws, UIA_ID, 'DeleteNetwork');
}

function handleSelectRememberedNetwork(ws, params) {
    const payload = params && params.payload;
    if (!payload) {
        return;
    }
    pendingDelete = payload.netId;
    sendContextChange(ws, UIA_ID, 'DeleteConfirmation', { payload: { networkName: payload.name } });
}

function handleSelectDelete(ws) {
    const wifi = getWifi();
    const entry = wifi.forget(pendingDelete);
    pendingDelete = null;
    if (entry) {
        logger.info('wifi', 'Deleted %s', entry.ssid);
    }
    sendWifiState(ws);
    showStacked(ws, ['DeleteNetwork']);
    sendMsg(ws, 'RememberedNetworksList', wifi.rememberedList());
}

// ------------------------------------------------------------------ Global.Cancel

const CANCELLABLE = [
    'Connecting',
    'KeyboardInput',
    'WEPKeyboard',
    'ConnectionError',
    'ConnectionRequired',
    'DeleteConfirmation',
    'MaxNetwork'
];

// Global.Cancel while one of this application's dialogs or keyboards is up: stop what is going
// on and show the screen below it. Returns false when none is.
function handleCancel(ws) {
    const current = navigationState.current;
    if (!current || current.uiaId !== UIA_ID || !CANCELLABLE.includes(current.ctxtId)) {
        return false;
    }
    cancelAttempt();
    pendingDelete = null;
    const stack = navigationState.goBackStack;
    if (stack.length > 1) {
        stack.pop();
        const below = stack[stack.length - 1];
        sendContextChange(ws, below.uiaId, below.ctxtId, below.params, below.contextSeq, true);
    }
    return true;
}

// Events of this application (see docs/NATIVE_MAP.md), dispatched by eventId.
const events = {
    SelectNetworkManagement: (ws) => handleSelectNetworkManagement(ws),
    SetWifiConnection: (ws, params) => handleSetWifiConnection(ws, params),
    SelectNetworkConnection: (ws) => handleSelectNetworkConnection(ws),
    SelectWifiMode: (ws, params) => handleSelectWifiMode(ws, params),
    SelectNetwork: handleSelectNetwork,
    SelectVisibleNetworkConnect: handleSelectVisibleNetworkConnect,
    SelectPassword: handleSelectPassword,
    SelectNameSSID: handleSelectNameSSID,
    SubmitKeyboardInput: handleSubmitKeyboardInput,
    SelectOtherNetwork: handleSelectOtherNetwork,
    SelectSecurity: handleSelectSecurity,
    SelectSecurityType: handleSelectSecurityType,
    SelectConnect: handleSelectConnect,
    RetryConnection: handleRetryConnection,
    ConnectionSetup: () => {},
    SelectDeleteWiFiNetwork: handleSelectDeleteWiFiNetwork,
    SelectRememberedNetwork: handleSelectRememberedNetwork,
    SelectDelete: handleSelectDelete
};

// Dialogs this application answers for the shared Global.Yes / Global.No, as [flag, handler].
const dialogAnswers = {
    yes: [['invalidInputActive', dismissInvalidInput]],
    no: []
};

module.exports = {
    events: events,
    dialogs: dialogs,
    dialogAnswers: dialogAnswers,
    handleCancel: handleCancel,
    handleSelectDisconnect: handleSelectDisconnect,
    sendWifiState: sendWifiState,
    sendWifiStatus: sendWifiStatus,
    handleSelectNetworkManagement: handleSelectNetworkManagement,
    handleSetWifiConnection: handleSetWifiConnection,
    handleSelectNetworkConnection: handleSelectNetworkConnection,
    handleSelectWifiMode: handleSelectWifiMode
};
