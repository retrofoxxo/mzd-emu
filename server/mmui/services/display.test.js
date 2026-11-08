const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockWs } = require('../../testing/mockWs');
const speaker = require('./speaker');
const settings = require('./settings');
const display = require('./display');
const navigationState = require('../state/navigationState');
const handleMmuiEvent = require('../dispatcher');

function setup() {
    const sent = [];
    speaker.attach((command) => (sent.push(command), true));
    display.reset();
    navigationState.goBackStack = [];
    navigationState.current = { uiaId: 'syssettings', ctxtId: 'DisplayTab', params: undefined };
    return { ws: createMockWs(), sent };
}
const ctxts = (ws) => ws.messages.filter((m) => m.msgType === 'ctxtChg');

test('Turn display off: backlight out, off screen; a touch brings back the screen it left', () => {
    const { ws, sent } = setup();
    handleMmuiEvent(ws, 'syssettings', 'SelectDisplayOff');
    assert.equal(ctxts(ws).at(-1).ctxtId, 'DisplayOff');
    assert.deepEqual(sent.at(-1), { cmd: 'backlight', on: false });
    assert.equal(display.mode(), 'off');

    ws.messages.length = 0;
    handleMmuiEvent(ws, 'system', 'DisplayOffGUIActivity');
    assert.deepEqual(sent.at(-1), { cmd: 'backlight', on: true });
    assert.equal(ctxts(ws).at(-1).uiaId, 'syssettings');
    assert.equal(ctxts(ws).at(-1).ctxtId, 'DisplayTab');
    assert.equal(display.mode(), 'on');
});

test('Turn display off and show clock keeps the backlight on', () => {
    const { ws, sent } = setup();
    handleMmuiEvent(ws, 'syssettings', 'SelectDisplayClock');
    assert.deepEqual(sent.at(-1), { cmd: 'backlight', on: true });
    assert.equal(display.mode(), 'clock');
});

test('a notification lights the display while it is up, then it goes dark again', () => {
    const { ws, sent } = setup();
    handleMmuiEvent(ws, 'syssettings', 'SelectDisplayOff');
    handleMmuiEvent(ws, 'system', 'DisplayOffNotificationEvent', { payload: { notificationActive: 1 } });
    assert.deepEqual(sent.at(-1), { cmd: 'backlight', on: true });
    handleMmuiEvent(ws, 'system', 'DisplayOffNotificationEvent', { payload: { notificationActive: 0 } });
    assert.deepEqual(sent.at(-1), { cmd: 'backlight', on: false });
});

test('waking while the display is on does nothing; off twice remembers the first screen', () => {
    const { ws } = setup();
    handleMmuiEvent(ws, 'system', 'DisplayOffGUIActivity');
    assert.equal(ctxts(ws).length, 0);
    handleMmuiEvent(ws, 'syssettings', 'SelectDisplayOff');
    handleMmuiEvent(ws, 'syssettings', 'SelectDisplayClock');
    ws.messages.length = 0;
    handleMmuiEvent(ws, 'system', 'DisplayOffGUIActivity');
    assert.equal(ctxts(ws).at(-1).ctxtId, 'DisplayTab');
});

test('system beeps go to the browser, as short or long, only when the Beep setting is on', () => {
    const { ws, sent } = setup();
    settings.currentSettings.soundBeep = 'On';
    handleMmuiEvent(ws, 'system', 'PlayAudioBeep', { payload: { pressType: 'Short', eventCause: 'Touch' } });
    handleMmuiEvent(ws, 'system', 'PlayAudioBeep', { payload: { pressType: 'Long', eventCause: 'Hardkey' } });
    assert.deepEqual(sent, [{ cmd: 'beep', pressType: 'Short' }, { cmd: 'beep', pressType: 'Long' }]);
    sent.length = 0;
    settings.currentSettings.soundBeep = 'Off';
    handleMmuiEvent(ws, 'system', 'PlayAudioBeep', { payload: { pressType: 'Short', eventCause: 'Touch' } });
    assert.equal(sent.length, 0);
    settings.currentSettings.soundBeep = 'On';
});
