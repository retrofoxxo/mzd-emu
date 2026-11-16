const protocol = require('../protocol');
const sendContextChange = protocol.sendContextChange;
const settings = require('../services/settings');
const navigationState = require('../state/navigationState');
const logger = require('../../logger');
const { getPhone } = require('../services/btPhone');

// Counterpart of libjciuiabtpairing.so: the Bluetooth settings. The one phone that can be paired is
// the virtual phone of config/bluetooth.json (services/btPhone.js): it can be connected with the
// phone and/or the audio profile, disconnected, removed and paired again.

const UIA_ID = 'btpairing';
const LIST_CONTEXTS = ['BTConnectionManager', 'BluetoothSettings'];
// How long the steps of a connection or of the pairing take.
const timings = { step: 1200, pairRequest: 3000 };

// Dialog state (what the shared Global.Yes / Global.No answer, see commonApp.js). A dialog only
// counts while it is the screen.
function onScreen(ctxtId) {
    const current = navigationState.current;
    return current.uiaId === UIA_ID && current.ctxtId === ctxtId;
}
const dialogs = {
    get confirmDeleteActive() {
        return onScreen('ConfirmDelete');
    },
    get numericConfirmActive() {
        return onScreen('NumericConfirmSSP');
    },
    get maxDevicesActive() {
        return onScreen('MaxDevices');
    }
};

let timer = null;

function sendMsg(ws, msgId, payload) {
    ws.send(
        JSON.stringify({ msgType: 'msg', uiaId: UIA_ID, msgId: msgId, params: { payload: payload } })
    );
    logger.debug('btpairing', 'Sent message msgId=%s', msgId);
}

function clearTimer() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}

function later(action, ms) {
    clearTimer();
    timer = setTimeout(() => {
        timer = null;
        action();
    }, ms);
}

// ------------------------------------------------------------------ lists and status

// The paired devices as the GUI lists them: the slot of a device is its id (1, 2, ...), the slot
// before it stays empty.
function bluetoothStatusPayload() {
    const phone = getPhone();
    const listItem = [{ itemLabel: '' }];
    if (phone.paired) {
        listItem.push({
            itemLabel: phone.name(),
            status: phone.isConnected() ? 1 : 0,
            connect_disconnect_Success: 1,
            isDeviceConnectedToCarPlay: false,
            isDeviceConnectedToAndroidAuto: false
        });
    }
    return {
        pairedDeviceList: {
            status: phone.bluetoothOn() ? 1 : 0,
            listItem: listItem
        }
    };
}

function sendDeviceList(ws) {
    sendMsg(ws, 'BTStatusAndList', bluetoothStatusPayload());
}

function sendBluetoothState(ws) {
    sendDeviceList(ws);
    sendMsg(ws, 'DeviceInfo', {
        DeviceInfoMsg: {
            deviceName: 'Mazda',
            deviceAddress: '00:00:00:00:00:00',
            pairCode: '0000'
        }
    });
    sendMsg(ws, 'CarPlayConnectionStatus', { isCarPlayConnected: 0 });
    sendMsg(ws, 'AndroidAutoConnectionStatus', { isAndroidAutoConnected: false });
}

// The phone symbols of the status bar.
function sendPhoneConnectedStatus(ws) {
    const phone = getPhone();
    const on = phone.isConnected();
    sendDeviceList(ws);
    sendMsg(ws, 'SignalStrengthStatus', { signalStrengthValue: on ? phone.config.signalStrength : -1 });
    sendMsg(ws, 'BatteryStatus', {
        currValue: on ? phone.config.batteryLevel : 0,
        PhoneBatteryStatusAvailable: on
    });
}

// The device options screen: which profile is connected.
function sendConnectionType(ws) {
    const phone = getPhone();
    sendMsg(ws, 'DeviceName', { deviceName: phone.name() });
    sendMsg(ws, 'CurrentDisplayedDevice', { CurrentDeviceId: 1 });
    sendMsg(ws, 'ConnectionType', {
        audiophoneconnect: {
            connectionDeviceId: 1,
            connected: phone.isConnected(),
            phoneSupported: true,
            audioSupported: true
        }
    });
    sendMsg(ws, 'ConnectedProfile', {
        audiophone: {
            connectionDeviceId: 1,
            phone: phone.profiles.phone,
            audio: phone.profiles.audio
        }
    });
}

// What changes for the rest of the unit when the phone connects or goes: the Communication and
// Entertainment menus, the status bar.
function refreshStatus(ws) {
    const systemApp = require('./systemApp');
    getPhone().applyProfiles();
    systemApp.sendCommunicationStatus(ws);
    systemApp.sendEntertainmentStatus(ws);
    sendPhoneConnectedStatus(ws);
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

function backToList(ws) {
    if (!showStacked(ws, LIST_CONTEXTS)) {
        sendContextChange(ws, UIA_ID, 'BTConnectionManager');
    }
    // the list is drawn from what was sent last: after the screen is shown
    sendDeviceList(ws);
}

// ------------------------------------------------------------------ screens

function openListScreen(ws, ctxtId) {
    sendBluetoothState(ws);
    sendContextChange(ws, UIA_ID, ctxtId);
    // The screen draws the list from the last message when it opens, but only follows the
    // messages that arrive while it is up: so the list is sent again.
    sendDeviceList(ws);
}

function handleSelectBluetooth(ws) {
    openListScreen(ws, 'BTConnectionManager');
}

function handleSelectBluetoothSettings(ws) {
    openListScreen(ws, 'BluetoothSettings');
}

function handleToggleBluetooth(ws, enabled) {
    settings.currentSettings.bluetooth = enabled ? 'On' : 'Off';
    settings.saveUserSettings();
    sendBluetoothState(ws);
    refreshStatus(ws);
}

// A device of the list: how it is connected, and the options.
function handleSelectDevice(ws) {
    if (!getPhone().paired) {
        return;
    }
    sendConnectionType(ws);
    sendContextChange(ws, UIA_ID, 'ConnectionType');
    sendConnectionType(ws);
}

// The device connected with one or both profiles, or disconnected: a progress dialog, then the
// list again with a notice.
function runConnection(ws, progressCtxt, change, notice) {
    sendContextChange(ws, UIA_ID, progressCtxt);
    later(() => {
        change();
        refreshStatus(ws);
        notice(ws);
        backToList(ws);
    }, timings.step);
}

function handleSelectProfile(kind) {
    return (ws) => {
        const phone = getPhone();
        runConnection(
            ws,
            'ConnectingDevice',
            () => phone.connectProfiles(kind),
            (client) => {
                if (phone.profiles.phone) sendMsg(client, 'SbnPhoneConnectionStatus', { SbnPhoneStatus: true });
                if (phone.profiles.audio) sendMsg(client, 'SbnAudioConnectionStatus', { SbnAudioStatus: true });
            }
        );
    };
}

function handleSelectDisconnect(ws) {
    const phone = getPhone();
    const wasPhone = phone.profiles.phone;
    const wasAudio = phone.profiles.audio;
    runConnection(
        ws,
        'DisconnectingDevice',
        () => phone.disconnectProfiles(),
        (client) => {
            if (wasPhone) sendMsg(client, 'SbnPhoneConnectionStatus', { SbnPhoneStatus: false });
            if (wasAudio) sendMsg(client, 'SbnAudioConnectionStatus', { SbnAudioStatus: false });
        }
    );
}

// RemovePairedDevice: ask first.
function handleRemovePairedDevice(ws) {
    sendContextChange(ws, UIA_ID, 'ConfirmDelete');
}

function confirmDelete(ws) {
    const phone = getPhone();
    sendContextChange(ws, UIA_ID, 'DeleteDevice');
    later(() => {
        phone.unpair();
        logger.info('bluetooth', 'Removed paired device %s', phone.name());
        refreshStatus(ws);
        backToList(ws);
    }, timings.step);
}

// Add New Device: the unit becomes discoverable; the virtual phone then asks to pair, showing the
// code to confirm. The one phone can only be paired once.
function handleAddNewDevice(ws) {
    sendBluetoothState(ws);
    if (getPhone().paired) {
        sendContextChange(ws, UIA_ID, 'MaxDevices');
        return;
    }
    sendContextChange(ws, UIA_ID, 'Discoverable');
    later(() => {
        if (!onScreen('Discoverable')) {
            return;
        }
        const code = String(Math.floor(100000 + Math.random() * 900000));
        sendMsg(ws, 'PairDevice', { sixDigitCode: { code: Number(code) } });
        sendMsg(ws, 'DeviceName', { deviceName: getPhone().name(), sixDigitCode: { code: Number(code) } });
        sendContextChange(ws, UIA_ID, 'NumericConfirmSSP');
    }, timings.pairRequest);
}

function acceptPairing(ws) {
    const phone = getPhone();
    sendContextChange(ws, UIA_ID, 'PairingInProcess');
    later(() => {
        phone.connectProfiles('phoneAndAudio');
        logger.info('bluetooth', 'Paired %s', phone.name());
        sendMsg(ws, 'SbnPairingSuccessStatus', { SbnPairingStatus: true });
        refreshStatus(ws);
        sendMsg(ws, 'SbnPhoneConnectionStatus', { SbnPhoneStatus: true });
        sendMsg(ws, 'SbnAudioConnectionStatus', { SbnAudioStatus: true });
        backToList(ws);
    }, timings.step);
}

function rejectPairing(ws) {
    clearTimer();
    backToList(ws);
}

// Global.Cancel while discoverable or on the confirmation code: back to the list.
function handleCancel(ws) {
    const currentContext = navigationState.goBackStack[navigationState.goBackStack.length - 1];
    if (
        !currentContext ||
        currentContext.uiaId !== UIA_ID ||
        !['Discoverable', 'NumericConfirmSSP'].includes(currentContext.ctxtId) ||
        navigationState.goBackStack.length < 2
    ) {
        return false;
    }
    clearTimer();
    navigationState.goBackStack.pop();
    const previousContext = navigationState.goBackStack[navigationState.goBackStack.length - 1];
    sendContextChange(
        ws,
        previousContext.uiaId,
        previousContext.ctxtId,
        previousContext.params,
        previousContext.contextSeq,
        true
    );
    logger.info('btpairing', 'Cancelled pairing');
    return true;
}

// Events of this application (see docs/NATIVE_MAP.md), dispatched by eventId.
const events = {
    SelectBluetooth: (ws) => handleSelectBluetooth(ws),
    SelectBluetoothSettings: (ws) => handleSelectBluetoothSettings(ws),
    ToggleBluetoothOn: (ws) => handleToggleBluetooth(ws, true),
    ToggleBluetoothOff: (ws) => handleToggleBluetooth(ws, false),
    AddNewDevice: (ws) => handleAddNewDevice(ws),
    SelectDevice: handleSelectDevice,
    SelectPhoneAndAudio: handleSelectProfile('phoneAndAudio'),
    SelectPhoneOnly: handleSelectProfile('phoneOnly'),
    SelectAudioOnly: handleSelectProfile('audioOnly'),
    // The Wi-Fi settings send the same event: it goes to the application that sent it.
    SelectDisconnect: (ws, params, uiaId) =>
        uiaId === 'netmgmt'
            ? require('./netmgmtApp').handleSelectDisconnect(ws)
            : handleSelectDisconnect(ws),
    RemovePairedDevice: handleRemovePairedDevice
};

// Dialogs this application answers for the shared Global.Yes / Global.No, as [flag, handler].
const dialogAnswers = {
    yes: [
        ['confirmDeleteActive', confirmDelete],
        ['numericConfirmActive', acceptPairing],
        ['maxDevicesActive', backToList]
    ],
    no: [
        ['confirmDeleteActive', (ws) => showStacked(ws, ['ConnectionType', ...LIST_CONTEXTS])],
        ['numericConfirmActive', rejectPairing]
    ]
};

module.exports = {
    events: events,
    dialogs: dialogs,
    dialogAnswers: dialogAnswers,
    sendPhoneConnectedStatus: sendPhoneConnectedStatus,
    sendBluetoothState: sendBluetoothState,
    handleSelectBluetooth: handleSelectBluetooth,
    handleSelectBluetoothSettings: handleSelectBluetoothSettings,
    handleToggleBluetooth: handleToggleBluetooth,
    handleAddNewDevice: handleAddNewDevice,
    handleCancel: handleCancel,
    timings: timings
};
