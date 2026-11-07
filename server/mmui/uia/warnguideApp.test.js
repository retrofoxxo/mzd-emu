const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockWs } = require('../../testing/mockWs');
const vehicleWarnings = require('../services/vehicleWarnings');
const navigationState = require('../state/navigationState');
const systemApp = require('./systemApp');
const handleMmuiEvent = require('../dispatcher');

function setup() {
    vehicleWarnings.reset();
    vehicleWarnings.loadInitial([]);
    navigationState.goBackStack = [];
    navigationState.current = { uiaId: null, ctxtId: null, params: undefined };
    systemApp.dialogs.introAnimationActive = false;
    systemApp.dialogs.disclaimerActive = false;
    const ws = createMockWs();
    vehicleWarnings.attach(ws);
    return ws;
}
const msgs = (ws, id) => ws.messages.filter((m) => m.msgId === id);
const ctxts = (ws) => ws.messages.filter((m) => m.msgType === 'ctxtChg');

test('the catalog is the firmware table: numbers, priorities and English texts', () => {
    assert.equal(vehicleWarnings.catalog.length, 111);
    assert.equal(vehicleWarnings.entry(41).label, 'TPMS System Malfunction');
    assert.equal(vehicleWarnings.entry(5).priority, 'High');
    assert.ok(vehicleWarnings.entry(5).dialog.includes('Stop vehicle'));
    assert.equal(vehicleWarnings.entry(9999), null);
});

test('a low priority warning updates the counter and the list, without a pop-up', () => {
    const ws = setup();
    assert.equal(vehicleWarnings.setWarning(41, true), true);
    assert.equal(msgs(ws, 'WarningStatusCount').at(-1).params.payload.warningcount, 1);
    assert.deepEqual(msgs(ws, 'WarningStatus').at(-1).params.payload.WarningList, {
        Warning_count: 1,
        Warning_Values: [41]
    });
    assert.equal(ctxts(ws).length, 0);
    vehicleWarnings.setWarning(41, false);
    assert.equal(msgs(ws, 'WarningStatusCount').at(-1).params.payload.warningcount, 0);
    assert.equal(vehicleWarnings.setWarning(9999, true), false);
});

test('Applications > Warning Guidance sends the list, then opens it', () => {
    const ws = setup();
    vehicleWarnings.setWarning(80, true);
    ws.messages.length = 0;
    handleMmuiEvent(ws, 'system', 'SelectWarnGuide');
    const kinds = ws.messages.map((m) => m.msgId || m.ctxtId).filter(Boolean);
    assert.ok(kinds.indexOf('WarningStatus') < kinds.indexOf('WarningList'));
});

test('selecting a warning shows its detail', () => {
    const ws = setup();
    vehicleWarnings.setWarning(41, true);
    ws.messages.length = 0;
    handleMmuiEvent(ws, 'warnguide', 'SelectWarning', { payload: { WarningID: 41 } });
    assert.equal(msgs(ws, 'SelectedWarning')[0].params.payload.WarningID, 41);
    assert.equal(ctxts(ws).at(-1).ctxtId, 'WarningDetail');
    ws.messages.length = 0;
    handleMmuiEvent(ws, 'warnguide', 'SelectWarning', { payload: { WarningID: 9999 } });
    assert.equal(ws.messages.length, 0);
});

test('a high priority warning raises the pop-up, and OK returns to the interrupted screen', () => {
    const ws = setup();
    navigationState.current = { uiaId: 'usbaudio', ctxtId: 'NowPlaying', params: undefined };
    vehicleWarnings.setWarning(5, true);
    assert.equal(
        msgs(ws, 'HighAlert')[0].params.payload.HAWarningList.Warning_HA_Values,
        5
    );
    assert.equal(ctxts(ws).at(-1).ctxtId, 'HighPriorityAlert');
    ws.messages.length = 0;
    handleMmuiEvent(ws, 'common', 'Global.Yes');
    assert.equal(ctxts(ws).at(-1).uiaId, 'usbaudio');
    assert.equal(ctxts(ws).at(-1).ctxtId, 'NowPlaying');
});

test('no pop-up while the boot video or disclaimer is up; the warning stays listed', () => {
    const ws = setup();
    systemApp.dialogs.disclaimerActive = true;
    vehicleWarnings.setWarning(5, true);
    assert.equal(ctxts(ws).length, 0);
    assert.equal(msgs(ws, 'WarningStatusCount').at(-1).params.payload.warningcount, 1);
    systemApp.dialogs.disclaimerActive = false;
});

test('warnings from the config file are active at start; unknown numbers are ignored', () => {
    setup();
    vehicleWarnings.loadInitial([41, 41, 80, 9999]);
    assert.deepEqual(vehicleWarnings.activeNumbers(), [41, 80]);
});

test('clearAll switches every warning off', () => {
    const ws = setup();
    vehicleWarnings.setWarning(41, true);
    vehicleWarnings.setWarning(80, true);
    vehicleWarnings.clearAll();
    assert.deepEqual(vehicleWarnings.activeNumbers(), []);
    assert.equal(msgs(ws, 'WarningStatusCount').at(-1).params.payload.warningcount, 0);
});
