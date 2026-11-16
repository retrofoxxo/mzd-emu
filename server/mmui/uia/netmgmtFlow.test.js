const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockWs } = require('../../testing/mockWs');
const settings = require('../services/settings');
const { WifiService, setWifi } = require('../services/wifi');
const navigationState = require('../state/navigationState');
const handleMmuiEvent = require('../dispatcher');

const CONFIG = {
    networks: [
        { ssid: 'Home', security: 'WPA2', password: 'homepassword', signal: 80 },
        { ssid: 'Cafe', security: 'None', signal: 60 },
        { ssid: 'Secret', security: 'WPA2', password: 'secretpass1', signal: 70, hidden: true }
    ],
    remembered: ['Home'],
    connectMs: 0
};
const wait = () => new Promise((resolve) => setTimeout(resolve, 15));

function setup() {
    const originalSave = settings.saveUserSettings;
    settings.saveUserSettings = () => {};
    settings.currentSettings.wifiMode = 1;
    const wifi = new WifiService(CONFIG);
    setWifi(wifi);
    navigationState.goBackStack = [];
    navigationState.current = { uiaId: null, ctxtId: null, params: undefined };
    const ws = createMockWs();
    handleMmuiEvent(ws, 'system', 'SelectNetworkManagement');
    ws.messages.length = 0;
    return { ws, wifi, restore: () => (settings.saveUserSettings = originalSave) };
}
const ev = (ws, id, params) => handleMmuiEvent(ws, 'netmgmt', id, params);
const last = (ws, id) => ws.messages.filter((m) => m.msgId === id).at(-1);
const screens = (ws) => ws.messages.filter((m) => m.msgType === 'ctxtChg').map((m) => m.ctxtId);
const pickNetwork = (wifi, ssid) => {
    const n = wifi.find(ssid);
    return { payload: { wifiNetwork: { ssid: n.ssid, bssid: n.bssid, netId: -1, connState: 0, secType: n.securityType, stateFlags: 0 } } };
};

test('the scan list shows visible networks only, with the remembered one connected at start', () => {
    const { wifi, restore } = setup();
    wifi.autoConnect();
    const scan = wifi.scanList();
    assert.deepEqual(scan.list.map((n) => n.name), ['Home', 'Cafe']);
    assert.equal(scan.list[0].connectionState, 1);
    assert.equal(scan.list[0].securityType, 8);
    assert.equal(wifi.status().connectedState, 3);
    settings.currentSettings.wifiMode = 0;
    assert.equal(wifi.scanList().size, 0);
    restore();
});

test('an open network connects through the Connect screen and is remembered', async () => {
    const { ws, wifi, restore } = setup();
    ev(ws, 'SelectNetwork', pickNetwork(wifi, 'Cafe'));
    assert.deepEqual(screens(ws), ['Connect']);
    assert.equal(last(ws, 'NewNetworkPassword').params.payload.password.length > 0, true); // Connect enabled
    ev(ws, 'SelectVisibleNetworkConnect', { payload: { bssid: wifi.find('Cafe').bssid } });
    assert.equal(screens(ws).at(-1), 'Connecting');
    await wait();
    assert.equal(screens(ws).at(-1), 'NetworkOptions');
    assert.equal(wifi.connected, 'Cafe');
    assert.ok(wifi.rememberedBySsid('Cafe'));
    restore();
});

test('a wrong password shows the invalid password dialog; OK returns to Connect; the right one connects', async () => {
    const { ws, wifi, restore } = setup();
    wifi.forget(wifi.rememberedBySsid('Home').id);
    ev(ws, 'SelectNetwork', pickNetwork(wifi, 'Home'));
    assert.equal(last(ws, 'NewNetworkPassword').params.payload.password, ''); // Connect disabled
    ev(ws, 'SelectPassword', { payload: { bssid: wifi.find('Home').bssid } });
    assert.equal(screens(ws).at(-1), 'KeyboardInput');
    ev(ws, 'SubmitKeyboardInput', { payload: { input: 'wrongpassword', type: 'pass', isValid: true } });
    assert.equal(screens(ws).at(-1), 'Connect');
    ev(ws, 'SelectVisibleNetworkConnect', { payload: { bssid: wifi.find('Home').bssid } });
    await wait();
    assert.equal(screens(ws).at(-1), 'InvalidPassword');
    assert.equal(wifi.connected, null);
    handleMmuiEvent(ws, 'Common', 'Global.Yes');
    assert.equal(screens(ws).at(-1), 'Connect');

    ev(ws, 'SubmitKeyboardInput', { payload: { input: 'homepassword', type: 'pass', isValid: true } });
    ev(ws, 'SelectVisibleNetworkConnect', { payload: { bssid: wifi.find('Home').bssid } });
    await wait();
    assert.equal(wifi.connected, 'Home');
    restore();
});

test('a remembered network connects at once; a connected one offers to disconnect', async () => {
    const { ws, wifi, restore } = setup();
    wifi.disconnect(); // Home was connected when the screen opened
    ev(ws, 'SelectNetwork', pickNetwork(wifi, 'Home'));
    assert.equal(screens(ws).at(-1), 'Connecting');
    await wait();
    assert.equal(wifi.connected, 'Home');
    const connected = { payload: { wifiNetwork: { ssid: 'Home', bssid: wifi.find('Home').bssid, netId: 1, connState: 1, secType: 8, stateFlags: 1 } } };
    ev(ws, 'SelectNetwork', connected);
    assert.equal(screens(ws).at(-1), 'Disconnect');
    ev(ws, 'SelectDisconnect');
    assert.equal(wifi.connected, null);
    assert.equal(screens(ws).at(-1), 'NetworkOptions');
    restore();
});

test('deleting a remembered network asks first, then forgets it', () => {
    const { ws, wifi, restore } = setup();
    const id = wifi.rememberedBySsid('Home').id;
    ev(ws, 'SelectDeleteWiFiNetwork');
    assert.equal(last(ws, 'RememberedNetworksList').params.payload.size, 1);
    ev(ws, 'SelectRememberedNetwork', { payload: { netId: id, name: 'Home' } });
    assert.equal(screens(ws).at(-1), 'DeleteConfirmation');
    ev(ws, 'SelectDelete');
    assert.equal(wifi.rememberedBySsid('Home'), null);
    assert.equal(screens(ws).at(-1), 'DeleteNetwork');
    restore();
});

test('a hidden network connects by name with the right security, and fails with the wrong one', async () => {
    const { ws, wifi, restore } = setup();
    ev(ws, 'SelectOtherNetwork');
    ev(ws, 'SubmitKeyboardInput', { payload: { input: 'Secret', type: 'name', isValid: true } });
    ev(ws, 'SelectSecurityType', { payload: { securityType: 0 } });
    ev(ws, 'SelectConnect');
    await wait();
    assert.equal(screens(ws).at(-1), 'ConnectionError'); // it is a WPA2 network
    ev(ws, 'SelectSecurityType', { payload: { securityType: 8 } });
    ev(ws, 'SelectPassword');
    ev(ws, 'SubmitKeyboardInput', { payload: { input: 'secretpass1', type: 'pass', isValid: true } });
    assert.equal(last(ws, 'HiddenNetworkInfo').params.payload.password, 'secretpass1');
    ev(ws, 'SelectConnect');
    await wait();
    assert.equal(wifi.connected, 'Secret');
    restore();
});

test('Cancel on the connecting dialog stops the attempt', async () => {
    const { ws, wifi, restore } = setup();
    wifi.config.connectMs = 30;
    wifi.disconnect();
    ev(ws, 'SelectNetwork', pickNetwork(wifi, 'Home'));
    assert.equal(screens(ws).at(-1), 'Connecting');
    handleMmuiEvent(ws, 'Common', 'Global.Cancel');
    assert.equal(screens(ws).at(-1), 'NetworkOptions');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(wifi.connected, null);
    restore();
});

test('switching Wi-Fi off disconnects; on again reconnects the remembered network', () => {
    const { ws, wifi, restore } = setup();
    ev(ws, 'SetWifiConnection', { payload: { offOn: 1 } });
    assert.equal(wifi.connected, 'Home');
    ev(ws, 'SetWifiConnection', { payload: { offOn: 0 } });
    assert.equal(wifi.connected, null);
    assert.equal(last(ws, 'ScannedNetworksList').params.payload.size, 0);
    restore();
});
