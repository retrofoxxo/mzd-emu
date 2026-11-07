const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockWs } = require('../../testing/mockWs');
const settings = require('../services/settings');
const audioFocus = require('../services/audioFocus');
const { UsbDrive, setDrive } = require('../services/usbDrive');
const { BtPhone, setPhone } = require('../services/btPhone');
const navigationState = require('../state/navigationState');
const handleMmuiEvent = require('../dispatcher');

function setup() {
    audioFocus.reset();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    for (const rel of ['x.mp3', 'y.mp3']) fs.writeFileSync(path.join(root, rel), 'x');
    const sent = [];
    const speaker = { send: (c) => (sent.push(c), true) };
    const phone = new BtPhone({ name: 'Pixel', musicDir: root, batteryLevel: 3, signalStrength: 2 }, speaker);
    const drive = new UsbDrive({ musicDir: root, deviceName: 'STICK' }, speaker);
    setPhone(phone);
    setDrive(drive);
    settings.currentSettings.bluetooth = 'On';
    navigationState.goBackStack = [];
    navigationState.current = { uiaId: null, ctxtId: null };
    return { ws: createMockWs(), phone, drive, sent };
}
const send = (ws, uia, event, params) => handleMmuiEvent(ws, uia, event, params);
const lastCtx = (ws) => ws.messages.filter((m) => m.msgType === 'ctxtChg').at(-1);
const msgs = (ws, id) => ws.messages.filter((m) => m.msgId === id);

test('Entertainment > Bluetooth announces the phone and opens Now Playing', () => {
    const { ws, sent } = setup();
    send(ws, 'system', 'SelectBTAudio');
    assert.equal(msgs(ws, 'StatusMenuBTAudio')[0].params.payload.deviceName, 'Pixel');
    assert.equal(msgs(ws, 'DeviceInfo')[0].params.payload.connected, true);
    const kinds = ws.messages.map((m) => m.msgId || m.ctxtId).filter(Boolean);
    // settings are read before the capabilities, and everything before the screen opens
    assert.ok(kinds.indexOf('SettingsSupported') < kinds.indexOf('DeviceCapability'));
    assert.ok(kinds.indexOf('ObjectInfo') < kinds.indexOf('NowPlayingAVRCP13'));
    assert.equal(lastCtx(ws).uiaId, 'btaudio');
    assert.equal(msgs(ws, 'ObjectInfo')[0].params.payload.songDetails.titleInfo, 'x');
    assert.equal(msgs(ws, 'PlayerState').at(-1).params.payload.playerState, 'PLAYING');
    assert.equal(sent[0].cmd, 'load');
});

test('progress is reported in milliseconds and the duration reaches ObjectInfo', () => {
    const { ws, phone } = setup();
    send(ws, 'system', 'SelectBTAudio');
    phone.player.handleSpeakerEvent({ evt: 'loaded', duration: 200 });
    phone.player.handleSpeakerEvent({ evt: 'time', time: 5.2 });
    assert.equal(msgs(ws, 'ElapsedTime').at(-1).params.payload.time, 5000);
    const info = msgs(ws, 'ObjectInfo').at(-1).params.payload.songDetails;
    assert.equal(info.trackDuration, 200000);
});

test('transport keys follow the audio focus; Bluetooth takes over from USB', () => {
    const { ws, phone, drive, sent } = setup();
    send(ws, 'usbaudio', 'SelectUSBA');
    assert.equal(audioFocus.currentName(), 'usb');
    send(ws, 'common', 'Global.Next');
    assert.equal(drive.player.snapshot().index, 1);
    assert.equal(phone.player.snapshot().index, 0);

    sent.length = 0;
    send(ws, 'system', 'SelectBTAudio');
    assert.equal(audioFocus.currentName(), 'bt');
    assert.equal(drive.player.snapshot().state, 'PAUSE'); // USB gave way
    assert.equal(sent[0].cmd, 'pause');
    send(ws, 'common', 'Global.Next');
    assert.equal(phone.player.snapshot().index, 1);
    assert.equal(drive.player.snapshot().index, 1); // untouched

    send(ws, 'btaudio', 'ToggleShuffle');
    assert.equal(msgs(ws, 'ShuffleState').at(-1).params.payload.shuffle, 'All');
    send(ws, 'btaudio', 'ToggleRepeat');
    assert.equal(msgs(ws, 'RepeatState').at(-1).params.payload.repeat, 'All');
});

test('speaker events go to the source that has the focus', () => {
    const { ws, phone, drive } = setup();
    send(ws, 'system', 'SelectBTAudio');
    audioFocus.dispatch({ evt: 'loaded', duration: 90 });
    assert.equal(phone.player.snapshot().duration, 90);
    assert.equal(drive.player.snapshot().duration, 0);
});

test('Bluetooth off: the source shows the disconnected dialog; GoBack returns to Entertainment', () => {
    const { ws } = setup();
    settings.currentSettings.bluetooth = 'Off';
    send(ws, 'system', 'SelectBTAudio');
    assert.equal(lastCtx(ws).ctxtId, 'Disconnect');
    assert.equal(msgs(ws, 'StatusMenuBTAudio')[0].params.payload.appStatus, 'Unavailable');

    settings.currentSettings.bluetooth = 'On';
    navigationState.goBackStack = [{ uiaId: 'system', ctxtId: 'Entertainment', contextSeq: 2 }];
    ws.messages.length = 0;
    send(ws, 'system', 'SelectBTAudio');
    ws.messages.length = 0;
    send(ws, 'common', 'Global.GoBack');
    assert.equal(lastCtx(ws).ctxtId, 'Entertainment');
    assert.equal(navigationState.goBackStack.length, 1);
});
