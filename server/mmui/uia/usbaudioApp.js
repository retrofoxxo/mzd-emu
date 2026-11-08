const protocol = require('../protocol');
const navigationState = require('../state/navigationState');
const logger = require('../../logger');
const { getDrive, DEVICE } = require('../services/usbDrive');
const { leaveToEntertainment } = require('../services/entertainmentNav');
const { STATE } = require('../services/usbPlayer');
const { ITEM_TYPE, OBJECT_ID_INVALID, ROOT_FOLDER_ID, coverUrl } = require('../../usb/library');
const { BROWSE } = require('../services/usbmsService');

// Counterpart of libjciuiausbaudio.so (uiaid 11): the USB audio source. The emulator offers one
// device, USB A, which is the directory from config/usb.json (see services/usbDrive.js). It
// browses by folder only; the drive tells the GUI that metadata browsing is not possible, so the
// Artist / Album / Song / Genre / Playlist entries of the source menu stay greyed out.

const UIA_ID = 'usbaudio';

// The GUI windows that show this application: the menu, the folder lists and Now Playing.
const CONTEXT = { MENU: 'USBAudio', FOLDERS: 'Folders', NOW_PLAYING: 'NowPlaying' };
const PATH = { FOLDER: 'FolderSongs', ALL_SONGS: 'FolderAllSongs' };

// The GUI connections that show the USB source; player events go to all of them.
const clients = new Set();
// What each GUI connection is browsing: { folderId }.
const sessions = new WeakMap();
// Players this module already listens to (the drive can be replaced in tests).
const subscribed = new WeakSet();

function sendMsg(ws, uiaId, msgId, payload) {
    ws.send(
        JSON.stringify({
            msgType: 'msg',
            uiaId: uiaId,
            msgId: msgId,
            params: { payload: payload }
        })
    );
    logger.debug('usbaudio', 'Sent message uiaId=%s msgId=%s', uiaId, msgId);
}

const sendUsb = (ws, msgId, payload) => sendMsg(ws, UIA_ID, msgId, payload);

function sessionOf(ws) {
    if (!sessions.has(ws)) {
        sessions.set(ws, { folderId: ROOT_FOLDER_ID });
    }
    return sessions.get(ws);
}

function openContext(ws, ctxtId, payload) {
    protocol.sendContextChange(ws, UIA_ID, ctxtId, payload ? { payload: payload } : undefined);
}

// ------------------------------------------------------------------ status in the system app

// The Entertainment menu entries "USB1" / "USB2": available when the drive is inserted.
function sendMenuStatus(ws) {
    const drive = getDrive();
    sendMsg(ws, 'system', 'StatusMenuUSBAudio', {
        statusMenuUSBAudio: {
            usbAB: 'USB_A',
            statusMenu: {
                appName: 'usbaudio',
                appStatus: drive.isInserted() ? 'Available' : 'Unavailable'
            },
            displayName: drive.isInserted() ? drive.name() : ''
        }
    });
    sendMsg(ws, 'system', 'StatusMenuUSBAudio', {
        statusMenuUSBAudio: {
            usbAB: 'USB_B',
            statusMenu: { appName: 'usbaudio', appStatus: 'Unavailable' },
            displayName: ''
        }
    });
}

function sendAudioSourceStatus(ws, state) {
    sendMsg(ws, 'system', 'StatusUpdateAudioSource', {
        statusAudio: { audioSource: 'USB_A', audioActive: state === STATE.PLAY ? 'Play' : 'Pause' }
    });
}

// ------------------------------------------------------------------ messages about the device

// Tells the GUI that a flash drive is connected, selected and browsable by folder.
function sendDeviceState(ws, drive) {
    sendUsb(ws, 'TimedSbn_ConnectionStatus', {
        status: 'Connected',
        usb: DEVICE.usb,
        deviceId: DEVICE.deviceId,
        name: drive.name(),
        type: DEVICE.type
    });
    sendUsb(ws, 'DeviceSelected', { deviceId: DEVICE.deviceId });
    sendUsb(ws, 'FolderBrowsingPossible', { deviceId: DEVICE.deviceId });
}

// The track, its progress and the buttons: what Now Playing shows.
function sendPlaybackState(ws, snapshot) {
    const filter = snapshot.filter || {
        filterEnum: BROWSE.ALL_SUBFOLDER_ENTRIES_IN_FOLDER,
        idLevel1: ROOT_FOLDER_ID,
        idLevel2: OBJECT_ID_INVALID,
        idLevel3: OBJECT_ID_INVALID
    };
    sendUsb(ws, 'NowPlayingData', {
        filters: filter,
        playListName: '',
        trackId: snapshot.index,
        trackIdOffSetInList: snapshot.index,
        repeatMode: snapshot.repeat,
        shuffleMode: snapshot.shuffle
    });
    if (snapshot.track) {
        sendUsb(ws, 'ObjectInfo', {
            trackIndex: snapshot.index,
            trackIdOffSetInList: snapshot.index,
            genre: snapshot.track.genre,
            artist: snapshot.track.artist,
            title: snapshot.track.title,
            album: snapshot.track.album
        });
        sendUsb(ws, 'CoverArt', {
            path: snapshot.track.hasCover ? coverUrl(snapshot.track.file) : 'None'
        });
    }
    sendUsb(ws, 'RepeatShuffleStatus', { repeat: snapshot.repeat, shuffle: snapshot.shuffle });
    sendUsb(ws, 'PlayerState', { playerState: snapshot.state });
    sendProgress(ws, snapshot.elapsed, snapshot.duration);
}

function sendProgress(ws, elapsed, duration) {
    sendUsb(ws, 'PlaybackStatus', {
        deviceId: DEVICE.deviceId,
        trackDuration: duration,
        elapsedTime: elapsed
    });
}

// Connects the player's events to the GUI connections (once per player).
function subscribe(player) {
    if (subscribed.has(player)) {
        return;
    }
    subscribed.add(player);
    const everyClient = (action) => clients.forEach(action);

    player.on('track', (track) => {
        const snapshot = player.snapshot();
        everyClient((ws) => {
            sendPlaybackState(ws, snapshot);
            // A short "now playing" notice when the track changes behind another screen.
            if (navigationState.current.uiaId !== UIA_ID) {
                sendUsb(ws, 'TimedSbn_CurrentSong', { title: track.title });
            }
        });
    });
    player.on('state', (state) =>
        everyClient((ws) => {
            sendUsb(ws, 'PlayerState', { playerState: state });
            sendAudioSourceStatus(ws, state);
        })
    );
    player.on('progress', ({ elapsed, duration }) =>
        everyClient((ws) => sendProgress(ws, elapsed, duration))
    );
    player.on('modes', (modes) => everyClient((ws) => sendUsb(ws, 'RepeatShuffleStatus', modes)));
}

function attachClient(ws, drive) {
    subscribe(drive.player);
    if (!clients.has(ws)) {
        clients.add(ws);
        if (typeof ws.on === 'function') {
            ws.on('close', () => clients.delete(ws));
        }
    }
}

// ------------------------------------------------------------------ navigation

function openFolder(ws, folderId, pathName) {
    const drive = getDrive();
    const folder = drive.library && drive.library.getFolder(folderId);
    if (!folder) {
        logger.warn('usbaudio', 'Unknown folder %s', folderId);
        openContext(ws, CONTEXT.MENU);
        return;
    }
    sessionOf(ws).folderId = folder.id;
    openContext(ws, CONTEXT.FOLDERS, {
        path: pathName,
        folderId: folder.id,
        folderName: folder.name
    });
}

function openNowPlaying(ws) {
    openContext(ws, CONTEXT.NOW_PLAYING);
}

// Global.MenuUp / Global.GoBack while this application is on screen. Returns false when it is
// not, so that the shared handler (commonApp.js) takes over.
function handleBack(ws) {
    const current = navigationState.current;
    if (!current || current.uiaId !== UIA_ID) {
        return false;
    }
    switch (current.ctxtId) {
        case CONTEXT.NOW_PLAYING:
            leaveToEntertainment(ws);
            break;
        case CONTEXT.FOLDERS: {
            const drive = getDrive();
            const session = sessionOf(ws);
            const folder = drive.library && drive.library.getFolder(session.folderId);
            if (folder && folder.parentId !== null && !isAllSongsList(current)) {
                sendMsg(ws, 'common', 'Global.MenuUpReceived', { receiverApp: UIA_ID });
                openFolder(ws, folder.parentId, PATH.FOLDER);
            } else if (folder && isAllSongsList(current)) {
                openFolder(ws, folder.id, PATH.FOLDER);
            } else {
                openContext(ws, CONTEXT.MENU);
            }
            break;
        }
        default:
            openNowPlaying(ws);
            break;
    }
    return true;
}

// SelectSourceMenu is shared with the eco energy app (ecoenergyApp.js asks here first): from
// Now Playing it opens the Entertainment menu. Returns false when this app is not on screen.
function handleSourceMenu(ws) {
    if (navigationState.current.uiaId !== UIA_ID) {
        return false;
    }
    leaveToEntertainment(ws);
    return true;
}

function isAllSongsList(current) {
    return Boolean(
        current.params && current.params.payload && current.params.payload.path === PATH.ALL_SONGS
    );
}

// ------------------------------------------------------------------ events of the GUI

function handleSelectUsbA(ws) {
    const drive = getDrive();
    sendMenuStatus(ws);
    if (!drive.isInserted()) {
        logger.warn('usbaudio', 'No USB drive: set musicDir in server/config/usb.json');
        return;
    }
    attachClient(ws, drive);
    sendDeviceState(ws, drive);
    if (!drive.hasMusic()) {
        openContext(ws, CONTEXT.MENU);
        return;
    }
    const player = drive.player;
    if (!player.hasQueue()) {
        const files = drive.library.allFilesUnder(ROOT_FOLDER_ID);
        player.start(files, 0, {
            filterEnum: BROWSE.ALL_SUBFOLDER_ENTRIES_IN_FOLDER,
            idLevel1: ROOT_FOLDER_ID,
            idLevel2: OBJECT_ID_INVALID,
            idLevel3: OBJECT_ID_INVALID
        });
    } else {
        sendPlaybackState(ws, player.snapshot());
    }
    openNowPlaying(ws);
}

function handleBrowseFolders(ws) {
    openFolder(ws, ROOT_FOLDER_ID, PATH.FOLDER);
}

function handleBrowseFolder(ws, params) {
    const payload = params && params.payload;
    if (payload) {
        openFolder(ws, Number(payload.folderId), PATH.FOLDER);
    }
}

// "All songs" at the top of a folder: every file below the folder, as one list.
function handleBrowseAll(ws) {
    openFolder(ws, sessionOf(ws).folderId, PATH.ALL_SONGS);
}

function handleSelectRootFolder(ws) {
    openContext(ws, CONTEXT.MENU);
}

// The list the GUI shows: from the folder the filter names.
function handlePlaySongIndex(ws, params) {
    const payload = params && params.payload;
    const drive = getDrive();
    if (!payload || !payload.filter || !drive.isInserted()) {
        return;
    }
    const filter = payload.filter;
    const folderId = drive.folderIdOf(filter);
    const library = drive.library;
    let files = [];
    let start = 0;
    if (filter.filterEnum === BROWSE.ALL_CONTENTS_IN_FOLDER) {
        // The index counts the whole list (sub folders first); the queue holds only its files.
        const entries = library.listEntries(folderId) || [];
        const entry = entries[Number(payload.objectId)];
        if (!entry || entry.type !== ITEM_TYPE.PLAYABLE_FILE) {
            logger.warn('usbaudio', 'PlaySongIndex %s is not a file', payload.objectId);
            return;
        }
        files = library.filesIn(folderId);
        start = files.findIndex((file) => file.id === entry.id);
    } else if (filter.filterEnum === BROWSE.ALL_SUBFOLDER_ENTRIES_IN_FOLDER) {
        files = library.allFilesUnder(folderId);
        start = Number(payload.objectId) || 0;
    } else {
        return;
    }
    attachClient(ws, drive);
    drive.player.start(files, start, {
        filterEnum: filter.filterEnum,
        idLevel1: folderId,
        idLevel2: OBJECT_ID_INVALID,
        idLevel3: OBJECT_ID_INVALID
    });
    openNowPlaying(ws);
}

// Plays a folder from its first file (voice command and the "play" intent).
function handlePlayFolder(ws, params) {
    const payload = params && params.payload;
    const drive = getDrive();
    if (!payload || !drive.isInserted()) {
        return;
    }
    const folderId = Number(payload.folderId) || ROOT_FOLDER_ID;
    const direct = drive.library.filesIn(folderId);
    const useDirect = direct.length > 0;
    const files = useDirect ? direct : drive.library.allFilesUnder(folderId);
    if (files.length === 0) {
        return;
    }
    attachClient(ws, drive);
    drive.player.start(files, 0, {
        filterEnum: useDirect
            ? BROWSE.ALL_CONTENTS_IN_FOLDER
            : BROWSE.ALL_SUBFOLDER_ENTRIES_IN_FOLDER,
        idLevel1: folderId,
        idLevel2: OBJECT_ID_INVALID,
        idLevel3: OBJECT_ID_INVALID
    });
    openNowPlaying(ws);
}

// The "song list" button of Now Playing: the list that is playing.
function handleSongList(ws) {
    const drive = getDrive();
    const filter = drive.player.snapshot().filter;
    if (!filter || !drive.isInserted()) {
        openFolder(ws, ROOT_FOLDER_ID, PATH.FOLDER);
        return;
    }
    openFolder(
        ws,
        drive.folderIdOf(filter),
        filter.filterEnum === BROWSE.ALL_SUBFOLDER_ENTRIES_IN_FOLDER ? PATH.ALL_SONGS : PATH.FOLDER
    );
}

// The GUI reports the folder it just listed, so that the native side knows where "up" leads.
// The library already knows the parents, so only the current folder is kept.
function handleBrowseParentId(ws, params) {
    const payload = params && params.payload;
    if (payload && Number(payload.folderId) > 0) {
        sessionOf(ws).folderId = Number(payload.folderId);
    }
}

function withPlayer(action) {
    return () => {
        const drive = getDrive();
        if (drive.isInserted()) {
            action(drive.player);
        }
    };
}

// Events of this application (libjciuiausbaudio.so), dispatched by eventId. The transport keys
// (Global.Play, Global.Next, ...) are shared by all audio sources: see transportApp.js.
const events = {
    SelectUSBA: handleSelectUsbA,
    SelectUSBB: () => logger.info('usbaudio', 'USB B is not fitted'),
    BrowseFolders: handleBrowseFolders,
    BrowseFolder: handleBrowseFolder,
    BrowseAll: handleBrowseAll,
    BrowseParentId: handleBrowseParentId,
    SelectRootFolder: handleSelectRootFolder,
    PlaySongIndex: handlePlaySongIndex,
    PlayFolder: handlePlayFolder,
    SongList: handleSongList,
    EmptyPlayingList: () => {},
    Shuffle: withPlayer((player) => player.toggleShuffle()),
    Repeat: withPlayer((player) => player.cycleRepeat()),
    PlaybackJumpToPosition: (ws, params) => {
        const percent = params && params.payload ? params.payload.percent : null;
        withPlayer((player) => player.seekPercent(percent))();
    },
    // Press and release only animate the button; the click sends Global.Resume / Global.Pause
    // (transportApp.js). Acting on the press as well would undo the click.
    PlayPausePress: () => {},
    PlayPauseRelease: () => {}
};

module.exports = {
    events: events,
    handleBack: handleBack,
    handleSourceMenu: handleSourceMenu,
    sendMenuStatus: sendMenuStatus,
    clients: clients
};
