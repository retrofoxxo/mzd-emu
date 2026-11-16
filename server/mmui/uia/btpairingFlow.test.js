const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockWs } = require('../../testing/mockWs');
const settings = require('../services/settings');
const audioFocus = require('../services/audioFocus');
const speaker = require('../services/speaker');
const { BtPhone, setPhone } = require('../services/btPhone');
const { UsbDrive, setDrive } = require('../services/usbDrive');
const navigationState = require('../state/navigationState');
const handleMmuiEvent = require('../dispatcher');
const btpairingApp = require('./btpairingApp');

btpairingApp.timings.step = 5;
btpairingApp.timings.pairRequest = 5;
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
    audioFocus.reset();
    speaker.attach(() => true);
    const phone = new BtPhone({ name: 'Pixel', musicDir: null, batteryLevel: 3, signalStrength: 4,
        callAnswerMs: 60000, callRingMs: 60000, contacts: [], callHistory: [] }, speaker);
    setPhone(phone);
    setDrive(new UsbDrive({ musicDir: null, deviceName: 'x' }, speaker));
    settings.currentSettings.bluetooth = 'On';
    navigationState.goBackStack = [];
    navigationState.current = { uiaId: null, ctxtId: null, params: undefined };
    const ws = createMockWs();
    handleMmuiEvent(ws, 'btpairing', 'SelectBluetooth');
    ws.messages.length = 0;
    return { ws, phone };
}
const ev = (ws, id, p) => handleMmuiEvent(ws, 'btpairing', id, p);
const screens = (ws) => ws.messages.filter((m) => m.msgType === 'ctxtChg').map((m) => m.ctxtId);
const last = (ws, id) => ws.messages.filter((m) => m.msgId === id).at(-1);

test('the list has the paired device in its slot, and is sent after the screen opens', () => {
    const { ws } = setup();
    handleMmuiEvent(ws, 'btpairing', 'SelectBluetooth');
    const kinds = ws.messages.map((m) => m.msgId || m.ctxtId).filter(Boolean);
    assert.ok(kinds.lastIndexOf('BTStatusAndList') > kinds.indexOf('BTConnectionManager'));
    const list = last(ws, 'BTStatusAndList').params.payload.pairedDeviceList;
    assert.equal(list.status, 1);
    assert.deepEqual(list.listItem.map((d) => d.itemLabel), ['', 'Pixel']);
    assert.equal(list.listItem[1].status, 1);
});

test('selecting the device shows its connection type with its name', () => {
    const { ws } = setup();
    ev(ws, 'SelectDevice', { payload: { deviceName: 'Pixel' } });
    assert.equal(screens(ws).at(-1), 'ConnectionType');
    assert.equal(last(ws, 'DeviceName').params.payload.deviceName, 'Pixel');
    assert.equal(last(ws, 'ConnectedProfile').params.payload.audiophone.phone, true);
    assert.equal(last(ws, 'ConnectionType').params.payload.audiophoneconnect.phoneSupported, true);
});

test('phone only connects without audio: Bluetooth audio goes away, calls stay', async () => {
    const { ws, phone } = setup();
    ev(ws, 'SelectDevice', { payload: { deviceName: 'Pixel' } });
    ev(ws, 'SelectPhoneOnly');
    assert.equal(screens(ws).at(-1), 'ConnectingDevice');
    await wait();
    assert.equal(phone.phoneOn(), true);
    assert.equal(phone.audioOn(), false);
    assert.equal(screens(ws).at(-1), 'BTConnectionManager');
    assert.equal(last(ws, 'SbnPhoneConnectionStatus').params.payload.SbnPhoneStatus, true);
    assert.equal(last(ws, 'StatusMenuBTAudio').params.payload.appStatus, 'Unavailable');
});

test('disconnecting stops music and hangs up a call; the entries are greyed', async () => {
    const { ws, phone } = setup();
    phone.calls.dial('123');
    ev(ws, 'SelectDevice', { payload: { deviceName: 'Pixel' } });
    ev(ws, 'SelectDisconnect');
    assert.equal(screens(ws).at(-1), 'DisconnectingDevice');
    await wait();
    assert.equal(phone.isConnected(), false);
    assert.equal(phone.calls.call, null);
    assert.equal(last(ws, 'SbnPhoneConnectionStatus').params.payload.SbnPhoneStatus, false);
    const list = last(ws, 'BTStatusAndList').params.payload.pairedDeviceList;
    assert.equal(list.listItem[1].status, 0); // still paired
});

test('Wi-Fi keeps its own Disconnect event', () => {
    const { ws } = setup();
    handleMmuiEvent(ws, 'netmgmt', 'SelectDisconnect'); // must not open the Bluetooth progress screen
    assert.equal(screens(ws).includes('DisconnectingDevice'), false);
});

test('removing the device asks first; No keeps it, Yes removes it', async () => {
    const { ws, phone } = setup();
    ev(ws, 'RemovePairedDevice');
    assert.equal(screens(ws).at(-1), 'ConfirmDelete');
    handleMmuiEvent(ws, 'Common', 'Global.No');
    assert.equal(phone.paired, true);
    ev(ws, 'RemovePairedDevice');
    handleMmuiEvent(ws, 'Common', 'Global.Yes');
    assert.equal(screens(ws).at(-1), 'DeleteDevice');
    await wait();
    assert.equal(phone.paired, false);
    assert.equal(last(ws, 'BTStatusAndList').params.payload.pairedDeviceList.listItem.length, 1);
    assert.equal(last(ws, 'StatusMenu') !== undefined, true);
});

test('adding a device: discoverable, the phone asks to pair with a code, Yes pairs and connects', async () => {
    const { ws, phone } = setup();
    phone.unpair();
    ev(ws, 'AddNewDevice');
    assert.equal(screens(ws).at(-1), 'Discoverable');
    await wait();
    assert.equal(screens(ws).at(-1), 'NumericConfirmSSP');
    const code = last(ws, 'PairDevice').params.payload.sixDigitCode.code;
    assert.ok(code >= 100000 && code <= 999999);
    handleMmuiEvent(ws, 'Common', 'Global.Yes');
    assert.equal(screens(ws).at(-1), 'PairingInProcess');
    await wait();
    assert.equal(phone.paired, true);
    assert.equal(phone.isConnected(), true);
    assert.equal(last(ws, 'SbnPairingSuccessStatus').params.payload.SbnPairingStatus, true);
});

test('cancelling the pairing, or answering No, pairs nothing', async () => {
    const { ws, phone } = setup();
    phone.unpair();
    ev(ws, 'AddNewDevice');
    handleMmuiEvent(ws, 'Common', 'Global.Cancel');
    await wait();
    assert.equal(phone.paired, false);
    ev(ws, 'AddNewDevice');
    await wait();
    handleMmuiEvent(ws, 'Common', 'Global.No');
    assert.equal(phone.paired, false);
});

test('a phone that is already paired cannot be added again', () => {
    const { ws } = setup();
    ev(ws, 'AddNewDevice');
    assert.equal(screens(ws).at(-1), 'MaxDevices');
});
