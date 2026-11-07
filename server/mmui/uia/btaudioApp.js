const protocol = require('../protocol');
const navigationState = require('../state/navigationState');
const logger = require('../../logger');
const { getPhone } = require('../services/btPhone');
const { leaveToEntertainment } = require('../services/entertainmentNav');
const { REPEAT, SHUFFLE } = require('../services/usbPlayer');
const { ROOT_FOLDER_ID, coverUrl } = require('../../usb/library');

// Counterpart of libjciuiabtaudio.so: Bluetooth audio from the emulated phone (the A2DP stream
// with AVRCP metadata and controls). The phone offers no folder browsing, so the screen is the
// AVRCP 1.3 Now Playing one: title, artist, album, a progress bar, repeat and shuffle.

const UIA_ID = 'btaudio';
const NOW_PLAYING = 'NowPlayingAVRCP13';

const clients = new Set();
const subscribed = new WeakSet();

const REPEAT_NAMES = {
    [REPEAT.NONE]: 'Off',
    [REPEAT.ONE]: 'Single',
    [REPEAT.ALL]: 'All'
};
const SHUFFLE_NAMES = { [SHUFFLE.OFF]: 'Off', [SHUFFLE.ON]: 'All' };

function sendMsg(ws, uiaId, msgId, payload) {
    ws.send(
        JSON.stringify({ msgType: 'msg', uiaId: uiaId, msgId: msgId, params: { payload: payload } })
    );
    logger.debug('btaudio', 'Sent message uiaId=%s msgId=%s', uiaId, msgId);
}

const sendBt = (ws, msgId, payload) => sendMsg(ws, UIA_ID, msgId, payload);

// The Bluetooth entry of the Entertainment menu shows the phone's name while it is connected.
function sendMenuStatus(ws) {
    const phone = getPhone();
    sendMsg(ws, 'system', 'StatusMenuBTAudio', {
        appStatus: phone.isConnected() ? 'Available' : 'Unavailable',
        deviceName: phone.isConnected() ? phone.name() : ''
    });
}

function playerStateName(state) {
    return state === 'PLAY' ? 'PLAYING' : state === 'PAUSE' ? 'PAUSED' : 'STOPPED';
}

function sendDeviceState(ws, phone) {
    sendBt(ws, 'DeviceInfo', { connected: true, deviceName: phone.name() });
    // What the phone's player supports (read before the capabilities)
    sendBt(ws, 'SettingsSupported', {
        SupportedSettings: {
            RepeatOff: true,
            RepeatSingle: true,
            RepeatAll: true,
            ShuffleOff: true,
            ShuffleAll: true,
            ShuffleGroup: false,
            ScanOff: false,
            ScanAll: false,
            ScanGroup: false
        }
    });
    sendBt(ws, 'DeviceCapability', {
        capability: { repeat: 'ON', random: 'ON', scanPlay: 'OFF' }
    });
}

function sendObjectInfo(ws, snapshot) {
    const track = snapshot.track;
    sendBt(ws, 'ObjectInfo', {
        songDetails: {
            titleInfo: track ? track.title : '',
            artistInfo: track ? track.artist : '',
            albumInfo: track ? track.album : '',
            albumArtPath: track && track.hasCover ? coverUrl(track.file) : '',
            // milliseconds; 0 until the browser knows the length
            trackDuration: snapshot.duration * 1000,
            isGracenoteUpdate: false
        }
    });
}

function sendModes(ws, repeat, shuffle) {
    sendBt(ws, 'RepeatState', { repeat: REPEAT_NAMES[repeat] });
    sendBt(ws, 'ShuffleState', { shuffle: SHUFFLE_NAMES[shuffle] });
}

function sendPlaybackState(ws, snapshot) {
    sendObjectInfo(ws, snapshot);
    sendModes(ws, snapshot.repeat, snapshot.shuffle);
    sendBt(ws, 'PlayerState', { playerState: playerStateName(snapshot.state) });
    sendBt(ws, 'ElapsedTime', { time: snapshot.elapsed * 1000 });
}

function subscribe(player) {
    if (subscribed.has(player)) {
        return;
    }
    subscribed.add(player);
    const everyClient = (action) => clients.forEach(action);
    player.on('track', () => {
        const snapshot = player.snapshot();
        everyClient((ws) => sendPlaybackState(ws, snapshot));
    });
    player.on('state', (state) =>
        everyClient((ws) => sendBt(ws, 'PlayerState', { playerState: playerStateName(state) }))
    );
    let lastDuration = 0;
    player.on('progress', ({ elapsed, duration }) => {
        // decided once, not per client: every client must hear about a new duration
        const durationChanged = duration !== lastDuration;
        lastDuration = duration;
        everyClient((ws) => {
            if (durationChanged) {
                sendObjectInfo(ws, player.snapshot());
            }
            sendBt(ws, 'ElapsedTime', { time: elapsed * 1000 });
        });
    });
    player.on('modes', (modes) => everyClient((ws) => sendModes(ws, modes.repeat, modes.shuffle)));
}

function attachClient(ws, phone) {
    subscribe(phone.player);
    if (!clients.has(ws)) {
        clients.add(ws);
        if (typeof ws.on === 'function') {
            ws.on('close', () => clients.delete(ws));
        }
    }
}

// Entertainment > Bluetooth.
function handleSelectBtAudio(ws) {
    const phone = getPhone();
    sendMenuStatus(ws);
    if (!phone.isConnected()) {
        // "Bluetooth device disconnected"
        protocol.sendContextChange(ws, UIA_ID, 'Disconnect');
        return;
    }
    attachClient(ws, phone);
    sendDeviceState(ws, phone);
    const player = phone.player;
    if (!player.hasQueue() && phone.hasMusic()) {
        player.start(phone.library.allFilesUnder(ROOT_FOLDER_ID), 0, null);
    } else {
        sendPlaybackState(ws, player.snapshot());
    }
    protocol.sendContextChange(ws, UIA_ID, NOW_PLAYING);
}

const withPlayer = (action) => () => action(getPhone().player);

// Back from Now Playing. Returns false when Bluetooth audio is not on screen.
function handleBack(ws) {
    if (navigationState.current.uiaId !== UIA_ID) {
        return false;
    }
    leaveToEntertainment(ws);
    return true;
}

const events = {
    SelectBTAudio: handleSelectBtAudio,
    SelectSource: (ws) => leaveToEntertainment(ws),
    ToggleShuffle: withPlayer((player) => player.toggleShuffle()),
    ToggleRepeat: withPlayer((player) => player.cycleRepeat()),
    // The phone's folder browsing and settings are not emulated
    SelectRootMenu: () => {},
    ScanPlay: () => {},
    TriggerDisplayReconnecting: () => {}
};

module.exports = {
    events: events,
    handleBack: handleBack,
    sendMenuStatus: sendMenuStatus,
    clients: clients
};
