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
const phoneApp = require('./phoneApp');

function setup() {
    audioFocus.reset();
    phoneApp.clients.clear();
    const sent = [];
    speaker.attach((c) => (sent.push(c), true));
    const phone = new BtPhone({
        name: 'Pixel', musicDir: null, batteryLevel: 3, signalStrength: 3,
        callAnswerMs: 60000, callRingMs: 60000,
        contacts: [
            { firstName: 'Anna', lastName: 'Vries', numbers: [{ category: 'Mobile', number: '+31611' }, { category: 'Work', number: '+31622' }] },
            { firstName: 'Ben', lastName: 'Jansen', numbers: [{ category: 'Mobile', number: '+31633' }] }
        ],
        callHistory: []
    }, speaker);
    setPhone(phone);
    setDrive(new UsbDrive({ musicDir: null, deviceName: 'x' }, speaker));
    settings.currentSettings.bluetooth = 'On';
    navigationState.goBackStack = [];
    navigationState.current = { uiaId: 'system', ctxtId: 'Communication', params: undefined };
    const ws = createMockWs();
    return { ws, phone, sent, stop: () => phone.calls.clearTimer() };
}
const ev = (ws, id, params) => handleMmuiEvent(ws, 'phone', id, params);
const screens = (ws) => ws.messages.filter((m) => m.msgType === 'ctxtChg').map((m) => m.uiaId + '/' + m.ctxtId);
const msg = (ws, id) => ws.messages.filter((m) => m.msgId === id).at(-1);

test('the Communication menu entries are enabled while the phone is connected', () => {
    const { ws, stop } = setup();
    require('./systemApp').sendCommunicationStatus(ws);
    const statuses = ws.messages.filter((m) => m.msgId === 'StatusMenu').map((m) => m.params.payload);
    assert.ok(statuses.length >= 3);
    assert.equal(msg(ws, 'PbConnectStatus').params.payload.connStatus, 'connected');
    assert.equal(msg(ws, 'DbGreyOut').params.payload.CallHistoryDb, false);
    stop();
});

test('Dial Phone opens the dial pad; the number typed is dialled and the call screen opens', () => {
    const { ws, phone, sent, stop } = setup();
    ev(ws, 'SelectPhone');
    assert.deepEqual(screens(ws), ['phone/DialPad']);
    ev(ws, 'DialpadUpdateNumericField', { payload: { phoneNumber: '253' } });
    ev(ws, 'CallDialpadNumber');
    assert.equal(msg(ws, 'CallIdInfo').params.payload.callIdInfoMsg.phoneNumber, '253');
    assert.equal(msg(ws, 'ActiveCallInfo').params.payload.activeCallInfoMsg.type, 'Connecting');
    assert.equal(screens(ws).at(-1), 'phone/ActiveCall');
    assert.ok(sent.some((c) => c.cmd === 'sound' && c.id === 'ringback' && c.loop));
    phone.calls.connect();
    assert.equal(msg(ws, 'ActiveCallInfo').params.payload.activeCallInfoMsg.type, 'ActiveCall');
    assert.equal(msg(ws, 'StatusPhoneCall').params.payload.phoneCallStatus, 'ActiveCall');
    ev(ws, 'SelectMuteCall');
    assert.equal(msg(ws, 'MuteStatus').params.payload.mute, 'on');
    ws.messages.length = 0;
    ev(ws, 'SelectEndCall');
    assert.equal(msg(ws, 'NoCallState') !== undefined, true);
    assert.equal(screens(ws).at(-1), 'phone/DialPad'); // the screen the call interrupted
    assert.ok(sent.some((c) => c.cmd === 'soundStop' && c.id === 'ringback'));
    stop();
});

test('an incoming call opens its screen over what is showing and returns there', () => {
    const { ws, phone, sent, stop } = setup();
    phoneApp.attach(ws);
    phone.calls.incoming('+31611');
    assert.equal(screens(ws).at(-1), 'phone/IncomingCall');
    assert.ok(sent.some((c) => c.cmd === 'sound' && c.id === 'ring' && c.url.endsWith('.wav')));
    ev(ws, 'SelectAnswer');
    assert.equal(screens(ws).at(-1), 'phone/ActiveCall');
    ev(ws, 'SelectEndCall');
    assert.equal(screens(ws).at(-1), 'system/Communication');
    stop();
});

test('ignoring an incoming call returns to the screen and counts as missed', () => {
    const { ws, phone, stop } = setup();
    phoneApp.attach(ws);
    phone.calls.incoming('+31999');
    ev(ws, 'SelectIgnore');
    assert.equal(screens(ws).at(-1), 'system/Communication');
    assert.equal(phone.calls.history[0].direction, 'missed');
    stop();
});

test('music pauses for a call and resumes after it', () => {
    const { ws, phone, stop } = setup();
    const player = phone.player;
    player.queue = [{ id: 1, name: 'a.mp3', relPath: 'a.mp3', absPath: '/nope/a.mp3' }];
    player.start(player.queue, 0, null);
    assert.equal(player.snapshot().state, 'PLAY');
    phoneApp.attach(ws);
    phone.calls.incoming('1');
    assert.equal(player.snapshot().state, 'PAUSE');
    phone.calls.reject();
    assert.equal(player.snapshot().state, 'PLAY');
    stop();
});

test('a contact with one number is called; one with several offers the numbers first', () => {
    const { ws, phone, stop } = setup();
    ev(ws, 'SelectContacts');
    assert.equal(screens(ws).at(-1), 'phone/ChoosePhoneContact');
    ev(ws, 'SelectContactName', { payload: { contactId: 2, numberCount: 1, phoneNumber: '+31633' } });
    assert.equal(phone.calls.call.number, '+31633');
    phone.calls.hangup();
    ws.messages.length = 0;
    ev(ws, 'SelectContactName', { payload: { contactId: 1, numberCount: 2 } });
    assert.equal(screens(ws).at(-1), 'phone/TypeDisambiguation');
    assert.equal(msg(ws, 'TypeDisambiguation').params.payload.contactType, 'All');
    ev(ws, 'SelectPhoneNumber', { payload: { phoneNumber: '+31622', contactId: 1, contactType: 'WorkPhone' } });
    assert.equal(phone.calls.call.number, '+31622');
    stop();
});

test('nothing opens while Bluetooth is off', () => {
    const { ws, phone, stop } = setup();
    settings.currentSettings.bluetooth = 'Off';
    ev(ws, 'SelectPhone');
    ev(ws, 'SelectContacts');
    ev(ws, 'CallDialpadNumber');
    assert.equal(ws.messages.length, 0);
    assert.equal(phone.calls.call, null);
    settings.currentSettings.bluetooth = 'On';
    stop();
});

test('Back from Contacts, Call History and the dial pad returns to the Communication menu', () => {
    const { ws, stop } = setup();
    navigationState.goBackStack = [];
    handleMmuiEvent(ws, 'system', 'Global.IntentHome');
    handleMmuiEvent(ws, 'system', 'SelectCommunication');
    for (const open of ['SelectContacts', 'SelectCallHistory', 'SelectPhone']) {
        ws.messages.length = 0;
        ev(ws, open);
        ws.messages.length = 0;
        handleMmuiEvent(ws, 'Common', 'Global.GoBack');
        assert.deepEqual(screens(ws), ['system/Communication'], open);
    }
    ws.messages.length = 0;
    handleMmuiEvent(ws, 'Common', 'Global.GoBack');
    assert.deepEqual(screens(ws), ['system/HomeScreen']);
    stop();
});

test('Back from the contact number list returns to the contact list, then to Communication', () => {
    const { ws, stop } = setup();
    navigationState.goBackStack = [];
    handleMmuiEvent(ws, 'system', 'Global.IntentHome');
    handleMmuiEvent(ws, 'system', 'SelectCommunication');
    ev(ws, 'SelectContacts');
    ev(ws, 'SelectContactName', { payload: { contactId: 1, numberCount: 2 } });
    ws.messages.length = 0;
    handleMmuiEvent(ws, 'Common', 'Global.GoBack');
    assert.deepEqual(screens(ws), ['phone/ChoosePhoneContact']);
    ws.messages.length = 0;
    handleMmuiEvent(ws, 'Common', 'Global.GoBack');
    assert.deepEqual(screens(ws), ['system/Communication']);
    stop();
});
