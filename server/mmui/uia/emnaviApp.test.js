const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockWs } = require('../../testing/mockWs');
const settings = require('../services/settings');
const navigationState = require('../state/navigationState');
const handleMmuiEvent = require('../dispatcher');
const emnaviApp = require('./emnaviApp');
const systemApp = require('./systemApp');

function reset() {
    emnaviApp.resetFix();
    navigationState.goBackStack = [];
    navigationState.current = { uiaId: null, ctxtId: null };
    settings.HARDWARE_CONFIG.navigationSdCard = 'On';
    settings.currentSettings.distanceUnit = 'Kilometers';
}
const fix = (ws, payload) => handleMmuiEvent(ws, 'emnavi', 'GpsFix', { payload });
const info = (ws) => ws.messages.filter((m) => m.msgId === 'CurrentLocationInfo');

test('compass points', () => {
    assert.equal(emnaviApp.compassPoint(0), 'N');
    assert.equal(emnaviApp.compassPoint(44), 'NE');
    assert.equal(emnaviApp.compassPoint(200), 'S');
    assert.equal(emnaviApp.compassPoint(359), 'N');
    assert.equal(emnaviApp.compassPoint(-90), 'W');
});

test('a fix becomes CurrentLocationInfo in the unit of the distance setting', () => {
    reset();
    const fixData = { valid: true, latitude: 52.37, longitude: 4.89, altitude: 10, heading: 92, speed: 12 };
    assert.deepEqual(emnaviApp.locationInfo(fixData), {
        isValidInfo: 1, showNeedle: true, heading: 'E', latitude: 52.37, longitude: 4.89,
        altitudeUnit: 'KM', altitude: 10
    });
    settings.currentSettings.distanceUnit = 'Miles';
    const miles = emnaviApp.locationInfo(fixData);
    assert.equal(miles.altitudeUnit, 'FT');
    assert.equal(miles.altitude, 33);
    // standing still: the heading is noise, so no needle
    assert.equal(emnaviApp.locationInfo({ ...fixData, speed: 0 }).showNeedle, false);
    assert.equal(emnaviApp.locationInfo({ valid: false }).isValidInfo, 0);
});

test('Home > Navigation opens the map screen with the last position', () => {
    reset();
    const ws = createMockWs();
    fix(ws, { latitude: 48.85, longitude: 2.35, altitude: 35, heading: 0, speed: 5 });
    assert.equal(info(ws).length, 0); // not on a navigation screen: nothing is sent
    systemApp.handleSelectNavigation(ws);
    const kinds = ws.messages.map((m) => m.msgId || m.ctxtId).filter(Boolean);
    assert.ok(kinds.indexOf('CurrentLocationInfo') < kinds.indexOf('Active'), kinds.join());
    assert.equal(info(ws)[0].params.payload.latitude, 48.85);
    const ctx = ws.messages.find((m) => m.msgType === 'ctxtChg');
    assert.equal(ctx.uiaId, 'emnavi');
    assert.equal(ctx.params.payload.ScreenType, 'Full');
});

test('fixes are forwarded while navigation is on screen; bad ones count as no signal', () => {
    reset();
    const ws = createMockWs();
    systemApp.handleSelectNavigation(ws);
    ws.messages.length = 0;
    fix(ws, { latitude: 10, longitude: 20, altitude: 1, heading: 90, speed: 3 });
    assert.equal(info(ws).at(-1).params.payload.isValidInfo, 1);
    fix(ws, { latitude: 999, longitude: 20 });
    assert.equal(info(ws).at(-1).params.payload.isValidInfo, 0);
    fix(ws, { valid: false });
    assert.equal(info(ws).at(-1).params.payload.isValidInfo, 0);
    fix(ws, undefined);
    assert.equal(info(ws).length, 3);
});

test('without the navigation SD card nothing opens', () => {
    reset();
    settings.HARDWARE_CONFIG.navigationSdCard = 'Off';
    const ws = createMockWs();
    systemApp.handleSelectNavigation(ws);
    assert.equal(ws.messages.length, 0);
});

test('SelectCompass opens the compass screen', () => {
    reset();
    const ws = createMockWs();
    handleMmuiEvent(ws, 'emnavi', 'SelectCompass');
    assert.equal(ws.messages.find((m) => m.msgType === 'ctxtChg').ctxtId, 'Compass');
});
