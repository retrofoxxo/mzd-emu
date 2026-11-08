const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockWs } = require('../../testing/mockWs');
const { UsbDrive, setDrive } = require('../services/usbDrive');
const { UsbPlayer } = require('../services/usbPlayer');
const usbms = require('../services/usbmsService');
const navigationState = require('../state/navigationState');
const handleMmuiEvent = require('../dispatcher');

function makeSpeaker() {
    const sent = [];
    return { sent, send: (c) => (sent.push(c), true) };
}

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usbapp-'));
    for (const rel of ['a.mp3', 'b.mp3', 'Rock/c.mp3', 'Rock/d.mp3']) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), 'x');
    }
    const speaker = makeSpeaker();
    const drive = new UsbDrive({ musicDir: root, deviceName: 'MY STICK' }, speaker);
    setDrive(drive);
    navigationState.goBackStack = [];
    navigationState.current = { uiaId: null, ctxtId: null };
    return { drive, speaker, ws: createMockWs() };
}

const send = (ws, eventId, params) => handleMmuiEvent(ws, 'usbaudio', eventId, params);
const lastCtx = (ws) => ws.messages.filter((m) => m.msgType === 'ctxtChg').at(-1);
const ids = (ws) => ws.messages.map((m) => m.msgId || m.ctxtId);

test('SelectUSBA announces the device, starts the first file and opens Now Playing', () => {
    const { ws, speaker } = setup();
    send(ws, 'SelectUSBA');
    const msgIds = ids(ws);
    for (const id of ['StatusMenuUSBAudio', 'TimedSbn_ConnectionStatus', 'DeviceSelected',
        'FolderBrowsingPossible', 'NowPlayingData', 'ObjectInfo', 'PlayerState', 'PlaybackStatus', 'NowPlaying']) {
        assert.ok(msgIds.includes(id), id + ' missing: ' + msgIds);
    }
    assert.ok(msgIds.indexOf('DeviceSelected') < msgIds.indexOf('NowPlaying'));
    const conn = ws.messages.find((m) => m.msgId === 'TimedSbn_ConnectionStatus');
    assert.equal(conn.params.payload.name, 'MY STICK');
    assert.equal(speaker.sent[0].cmd, 'load');
    assert.equal(speaker.sent[0].url, '/usb/Rock/c.mp3'); // folders first in tree order
    const menu = ws.messages.find((m) => m.msgId === 'StatusMenuUSBAudio');
    assert.equal(menu.params.payload.statusMenuUSBAudio.statusMenu.appStatus, 'Available');
    assert.equal(menu.params.payload.statusMenuUSBAudio.displayName, 'MY STICK');
});

test('BrowseContext lists the folder; PlaySongIndex counts sub folders in the index', () => {
    const { ws, speaker, drive } = setup();
    send(ws, 'SelectUSBA');
    const reply = usbms.handleRequest(
        {
            msgType: 'method', serviceName: 'usbms', methodName: 'BrowseContext', reqId: 7,
            params: { browseContext: { deviceId: 1, offset: 0, count: 50,
                filterList: { filter: [{ filterEnum: 4, idLevel1: 1 }] } } }
        },
        drive
    );
    assert.equal(reply.msgType, 'methodResponse');
    assert.equal(reply.reqId, 7);
    assert.deepEqual(reply.params.browseContextReply.itemList.map((i) => i.itemName), ['Rock', 'a.mp3', 'b.mp3']);
    assert.equal(reply.params.browseContextReply.totalCount, 3);

    ws.messages.length = 0;
    speaker.sent.length = 0;
    // index 2 of the list [Rock, a.mp3, b.mp3] is b.mp3
    send(ws, 'PlaySongIndex', { payload: { filter: { filterEnum: 4, idLevel1: 1 }, objectId: 2 } });
    assert.equal(speaker.sent[0].url, '/usb/b.mp3');
    assert.equal(lastCtx(ws).ctxtId, 'NowPlaying');
    // index 0 is a folder: nothing happens
    speaker.sent.length = 0;
    send(ws, 'PlaySongIndex', { payload: { filter: { filterEnum: 4, idLevel1: 1 }, objectId: 0 } });
    assert.equal(speaker.sent.length, 0);
});

test('GetBrowseFolderInfo, unknown service and metadata views', () => {
    const { drive } = setup();
    const info = usbms.handleRequest({ msgType: 'method', serviceName: 'usbms', methodName: 'GetBrowseFolderInfo',
        reqId: 1, params: { getBrowseFolderInfo: { deviceId: 1, itemId: 2 } } }, drive);
    assert.equal(info.params.getBrowseFolderInfoReply.result, 0);
    assert.equal(info.params.getBrowseFolderInfoReply.folderName, 'Rock');
    assert.equal(usbms.handleRequest({ msgType: 'method', serviceName: 'other', methodName: 'X', reqId: 1 }, drive), null);
    const artists = usbms.handleRequest({ msgType: 'method', serviceName: 'usbms', methodName: 'BrowseContext', reqId: 2,
        params: { browseContext: { offset: 0, count: 5, filterList: { filter: [{ filterEnum: 1 }] } } } }, drive);
    assert.equal(artists.params.browseContextReply.totalCount, 0);
});

test('folder navigation and back handling', () => {
    const { ws } = setup();
    send(ws, 'SelectUSBA');
    ws.messages.length = 0;
    send(ws, 'BrowseFolders');
    let ctx = lastCtx(ws);
    assert.equal(ctx.ctxtId, 'Folders');
    assert.equal(ctx.params.payload.path, 'FolderSongs');
    assert.equal(ctx.params.payload.folderId, 1);

    send(ws, 'BrowseFolder', { payload: { folderId: 2, folderName: 'Rock' } });
    ctx = lastCtx(ws);
    assert.equal(ctx.params.payload.folderName, 'Rock');

    send(ws, 'Global.MenuUp');
    ctx = lastCtx(ws);
    assert.equal(ctx.ctxtId, 'Folders');
    assert.equal(ctx.params.payload.folderId, 1);

    send(ws, 'Global.MenuUp'); // root folder: up to the source menu
    assert.equal(lastCtx(ws).ctxtId, 'USBAudio');
});

test('GoBack from Now Playing returns to Entertainment without a new stack entry', () => {
    const { ws } = setup();
    navigationState.goBackStack = [{ uiaId: 'system', ctxtId: 'Entertainment', params: undefined, contextSeq: 3 }];
    send(ws, 'SelectUSBA');
    ws.messages.length = 0;
    handleMmuiEvent(ws, 'common', 'Global.GoBack');
    assert.equal(lastCtx(ws).ctxtId, 'Entertainment');
    assert.equal(navigationState.goBackStack.length, 1);
});

test('transport events drive the player', () => {
    const { ws, speaker, drive } = setup();
    send(ws, 'SelectUSBA');
    speaker.sent.length = 0;
    send(ws, 'Global.Pause');
    assert.equal(speaker.sent[0].cmd, 'pause');
    send(ws, 'Global.Resume');
    assert.equal(speaker.sent[1].cmd, 'play');
    send(ws, 'Global.Next');
    assert.equal(speaker.sent[2].url, '/usb/Rock/d.mp3');
    send(ws, 'Shuffle');
    send(ws, 'Repeat');
    assert.equal(drive.player.snapshot().repeat, 'USBM_REPEAT_MODE_ALL');
    drive.player.handleSpeakerEvent({ evt: 'loaded', duration: 200 });
    speaker.sent.length = 0;
    send(ws, 'PlaybackJumpToPosition', { payload: { percent: 50 } });
    assert.deepEqual(speaker.sent[0], { cmd: 'seek', position: 100 });
});

test('player: auto advance, repeat one, end of list, previous restart, errors', () => {
    const speaker = makeSpeaker();
    const files = ['a', 'b', 'c'].map((n, i) => ({ id: i, name: n + '.mp3', relPath: n + '.mp3', absPath: '/x/' + n }));
    const player = new UsbPlayer({ speaker, readTags: () => ({}), random: () => 0 });
    player.start(files, 0);
    player.handleSpeakerEvent({ evt: 'ended' });
    assert.equal(player.snapshot().index, 1);
    player.handleSpeakerEvent({ evt: 'time', time: 10 });
    player.previous();
    assert.equal(player.snapshot().index, 1); // restarted, not skipped
    assert.equal(player.snapshot().elapsed, 0);
    player.cycleRepeat(); player.cycleRepeat(); // ONE
    player.handleSpeakerEvent({ evt: 'ended' });
    assert.equal(player.snapshot().index, 1);
    player.cycleRepeat(); // NONE
    player.handleSpeakerEvent({ evt: 'ended' });
    player.handleSpeakerEvent({ evt: 'ended' });
    assert.equal(player.snapshot().state, 'STOPED');
    player.resume();
    assert.equal(player.snapshot().state, 'PLAY');
    assert.equal(player.snapshot().index, 0);
    // every file fails: stops instead of looping
    for (let i = 0; i < 5; i++) player.handleSpeakerEvent({ evt: 'error' });
    assert.equal(player.snapshot().state, 'STOPED');
});

test('without a drive the menu shows USB as unavailable and nothing plays', () => {
    const speaker = makeSpeaker();
    setDrive(new UsbDrive({ musicDir: null, deviceName: 'X' }, speaker));
    const ws = createMockWs();
    send(ws, 'SelectUSBA');
    const menu = ws.messages.find((m) => m.msgId === 'StatusMenuUSBAudio');
    assert.equal(menu.params.payload.statusMenuUSBAudio.statusMenu.appStatus, 'Unavailable');
    assert.equal(speaker.sent.length, 0);
});

test('SelectSourceMenu from Now Playing opens Entertainment', () => {
    const { ws } = setup();
    navigationState.goBackStack = [{ uiaId: 'system', ctxtId: 'Entertainment', contextSeq: 1 }];
    send(ws, 'SelectUSBA');
    ws.messages.length = 0;
    send(ws, 'SelectSourceMenu');
    assert.equal(lastCtx(ws).ctxtId, 'Entertainment');
});

test('pressing and releasing the play button does not change playback; the click does', () => {
    const { ws, drive } = setup();
    send(ws, 'SelectUSBA');
    send(ws, 'Global.Pause');
    assert.equal(drive.player.snapshot().state, 'PAUSE');
    send(ws, 'PlayPausePress');
    assert.equal(drive.player.snapshot().state, 'PAUSE');
    send(ws, 'PlayPauseRelease');
    handleMmuiEvent(ws, 'Common', 'Global.Resume'); // the click of the GUI
    assert.equal(drive.player.snapshot().state, 'PLAY');
});
