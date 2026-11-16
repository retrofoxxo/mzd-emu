const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockWs } = require('../../testing/mockWs');
const settingsTabs = require('../services/settingsTabs');
const navigationState = require('../state/navigationState');
const handleMmuiEvent = require('../dispatcher');

function setup() {
    settingsTabs.reset();
    navigationState.goBackStack = [];
    navigationState.current = { uiaId: null, ctxtId: null, params: undefined };
    const ws = createMockWs();
    handleMmuiEvent(ws, 'system', 'Global.IntentHome');
    ws.messages.length = 0;
    return ws;
}
const screens = (ws) => ws.messages.filter((m) => m.msgType === 'ctxtChg').map((m) => m.uiaId + '/' + m.ctxtId);
const press = (ws, from) => handleMmuiEvent(ws, from, 'SelectSettings');
const tab = (ws, name) => handleMmuiEvent(ws, 'system', 'Global.IntentSettingsTab', { payload: { settingsTab: name } });

test('Settings opens the first tab at first, then the tab used last', () => {
    const ws = setup();
    press(ws, 'system');
    const first = screens(ws).at(-1);
    assert.match(first, /^(vehsettings\/HUDTab|syssettings\/DisplayTab)/);
    tab(ws, 'Sound');
    tab(ws, 'Clock');
    handleMmuiEvent(ws, 'system', 'Global.IntentHome');
    ws.messages.length = 0;
    press(ws, 'system');
    assert.deepEqual(screens(ws), ['syssettings/ClockTab']);
    // another visit, another tab
    tab(ws, 'Safety');
    handleMmuiEvent(ws, 'system', 'Global.IntentHome');
    ws.messages.length = 0;
    press(ws, 'system');
    assert.deepEqual(screens(ws), ['vehsettings/SafetyTab']);
});

test('the Settings button of a player opens the sound settings, and Back returns to the player', () => {
    const ws = setup();
    handleMmuiEvent(ws, 'system', 'Global.IntentHome');
    navigationState.current = { uiaId: 'usbaudio', ctxtId: 'NowPlaying', params: undefined };
    ws.messages.length = 0;
    press(ws, 'usbaudio');
    assert.deepEqual(screens(ws), ['audiosettings/SoundTab']);
    ws.messages.length = 0;
    handleMmuiEvent(ws, 'Common', 'Global.GoBack');
    assert.deepEqual(screens(ws), ['usbaudio/NowPlaying']);
});

test('the Settings entry of the Communication menu opens the Devices tab', () => {
    const ws = setup();
    handleMmuiEvent(ws, 'system', 'SelectCommunication');
    ws.messages.length = 0;
    press(ws, 'system');
    assert.deepEqual(screens(ws), ['syssettings/DevicesTab']);
    ws.messages.length = 0;
    handleMmuiEvent(ws, 'Common', 'Global.GoBack');
    assert.deepEqual(screens(ws), ['system/Communication']);
});

test('the Settings button of the phone screens opens the Devices tab too', () => {
    const ws = setup();
    handleMmuiEvent(ws, 'system', 'SelectCommunication');
    navigationState.current = { uiaId: 'phone', ctxtId: 'DialPad', params: undefined };
    ws.messages.length = 0;
    press(ws, 'phone');
    assert.deepEqual(screens(ws), ['syssettings/DevicesTab']);
});

test('a tab this vehicle does not have is never opened', () => {
    settingsTabs.reset();
    assert.equal(settingsTabs.tabOf('syssettings', 'DisplayTab'), 'Display');
    assert.equal(settingsTabs.tabOf('system', 'HomeScreen'), null);
    assert.equal(settingsTabs.tabScreen('Nonsense'), null);
});
