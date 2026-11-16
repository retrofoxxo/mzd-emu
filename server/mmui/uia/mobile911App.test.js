const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockWs } = require('../../testing/mockWs');
const settings = require('../services/settings');
const audioFocus = require('../services/audioFocus');
const speaker = require('../services/speaker');
const { EmergencyCall } = require('../services/emergencyCall');
const { BtPhone, setPhone } = require('../services/btPhone');
const { UsbDrive, setDrive } = require('../services/usbDrive');
const navigationState = require('../state/navigationState');
const handleMmuiEvent = require('../dispatcher');
const mobile911App = require('./mobile911App');

function fakeClock() {
    let time = 0;
    const timers = [];
    return {
        setTimeoutFn: (fn, ms) => { const t = { fn, at: time + ms }; timers.push(t); return t; },
        clearTimeoutFn: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
        advance(ms) {
            time += ms;
            timers.filter((t) => t.at <= time).forEach((t) => { timers.splice(timers.indexOf(t), 1); t.fn(); });
        }
    };
}

function modelWith(phoneOn = true, signal = 3) {
    const clock = fakeClock();
    const phone = { phoneOn: () => phoneOn, config: { signalStrength: signal } };
    return { clock, emergency: new EmergencyCall({ phone, countdownS: 10, searchMs: 2000, connectMs: 4000, ...clock }) };
}

test('SOS goes straight to searching and connects; hanging up reports a placed call', () => {
    const { clock, emergency } = modelWith();
    const states = [];
    emergency.on('state', ({ state }) => states.push(state));
    let ended = null;
    emergency.on('ended', (result) => (ended = result));
    assert.equal(emergency.trigger('sos'), true);
    assert.equal(emergency.trigger('sos'), false); // already going on
    clock.advance(2000);
    clock.advance(4000);
    assert.deepEqual(states, ['searching', 'connecting', 'connected']);
    emergency.transferToHandset();
    emergency.transferFromHandset();
    emergency.hangup();
    assert.deepEqual(ended, { reason: 'sos', placed: true });
    assert.equal(emergency.isActive(), false);
});

test('a collision counts down first, and cancelling in time places no call', () => {
    const { clock, emergency } = modelWith();
    const states = [];
    emergency.on('state', ({ state }) => states.push(state));
    emergency.trigger('collision');
    clock.advance(9000);
    assert.deepEqual(states, ['countdown']);
    let ended = null;
    emergency.on('ended', (result) => (ended = result));
    emergency.hangup();
    clock.advance(20000);
    assert.deepEqual(states, ['countdown']);
    assert.deepEqual(ended, { reason: 'collision', placed: false });
});

test('without a connected phone there is no call; with no network it can be retried', () => {
    const none = modelWith(false);
    none.emergency.trigger('sos');
    none.clock.advance(2000);
    assert.equal(none.emergency.state, 'noPhone');

    const weak = modelWith(true, 0);
    weak.emergency.trigger('sos');
    weak.clock.advance(2000);
    assert.equal(weak.emergency.state, 'noConnection');
    weak.emergency.retry();
    assert.equal(weak.emergency.state, 'searching');
});

function setup() {
    audioFocus.reset();
    const sent = [];
    speaker.attach((c) => (sent.push(c), true));
    const phone = new BtPhone({ name: 'Pixel', musicDir: null, batteryLevel: 3, signalStrength: 3,
        callAnswerMs: 60000, callRingMs: 60000, contacts: [], callHistory: [],
        emergency: { countdownS: 10, searchMs: 60000, connectMs: 60000 } }, speaker);
    setPhone(phone);
    setDrive(new UsbDrive({ musicDir: null, deviceName: 'x' }, speaker));
    settings.currentSettings.bluetooth = 'On';
    navigationState.goBackStack = [];
    navigationState.current = { uiaId: 'system', ctxtId: 'Communication', params: undefined };
    const ws = createMockWs();
    mobile911App.attach(ws);
    return { ws, phone, sent };
}
const screens = (ws) => ws.messages.filter((m) => m.msgType === 'ctxtChg').map((m) => m.uiaId + '/' + m.ctxtId);
const msg = (ws, id) => ws.messages.filter((m) => m.msgId === id).at(-1);

test('an accident shows the countdown dialog, plays the warning prompt and sends the duration after the dialog', () => {
    const { ws, phone, sent } = setup();
    phone.emergency.trigger('collision');
    assert.equal(screens(ws).at(-1), 'mobile911/CollisionDetectedDialog');
    const kinds = ws.messages.map((m) => m.msgId || m.ctxtId).filter(Boolean);
    assert.ok(kinds.indexOf('TimeIn') > kinds.indexOf('CollisionDetectedDialog'));
    assert.equal(msg(ws, 'TimeIn').params.payload.Duration, '10');
    assert.ok(sent.some((c) => c.cmd === 'sound' && c.url.endsWith('/English/CancelTimer.wav')));
    // Cancel button of the dialog
    handleMmuiEvent(ws, 'mobile911', 'HangUp');
    assert.equal(screens(ws).at(-1), 'system/Communication');
    assert.ok(sent.some((c) => c.cmd === 'soundStop'));
    assert.equal(phone.calls.history.length, 0);
});

test('the call screens follow the call; it ends in the history, music resumes, the screen comes back', () => {
    const { ws, phone } = setup();
    const player = phone.player;
    player.start([{ id: 1, name: 'a.mp3', relPath: 'a.mp3', absPath: '/nope/a.mp3' }], 0, null);
    phone.emergency.trigger('sos');
    assert.equal(player.snapshot().state, 'PAUSE');
    assert.equal(screens(ws).at(-1), 'mobile911/SearchingFor911Phone');
    phone.emergency.connecting();
    assert.equal(screens(ws).at(-1), 'mobile911/Active911CallConnecting');
    assert.ok(msg(ws, 'StartElapsedTimeCount'));
    phone.emergency.setState('connected');
    assert.equal(screens(ws).at(-1), 'mobile911/Active911CallConnected');
    assert.equal(msg(ws, 'ShowPSAPInfoInscription').params.payload.showPSAPInfo, 'Show');
    handleMmuiEvent(ws, 'mobile911', 'TransferToHandset');
    assert.equal(screens(ws).at(-1), 'mobile911/CallOnMobileDevice');
    handleMmuiEvent(ws, 'mobile911', 'TransferFromHandset');
    handleMmuiEvent(ws, 'mobile911', 'HangUp');
    assert.ok(msg(ws, 'EndElapsedTimeCount'));
    assert.equal(screens(ws).at(-1), 'system/Communication');
    assert.equal(phone.calls.history[0].number, '911');
    assert.equal(player.snapshot().state, 'PLAY');
});

test('Cancel on the searching dialog and Back on the no-connection alert end the call', () => {
    const { ws, phone } = setup();
    phone.emergency.trigger('sos');
    handleMmuiEvent(ws, 'Common', 'Global.Cancel');
    assert.equal(phone.emergency.isActive(), false);
    phone.config.signalStrength = 0;
    phone.emergency.trigger('sos');
    phone.emergency.search();
    phone.emergency.clearTimer();
    phone.emergency.setState('noConnection');
    assert.equal(screens(ws).at(-1), 'mobile911/NoConnectionUsePhoneAlert');
    handleMmuiEvent(ws, 'Common', 'Global.GoBack');
    assert.equal(phone.emergency.isActive(), false);
});

test('an emergency call ends an ordinary call that was going on', () => {
    const { phone } = setup();
    phone.calls.dial('123');
    phone.emergency.trigger('sos');
    assert.equal(phone.calls.call, null);
});
