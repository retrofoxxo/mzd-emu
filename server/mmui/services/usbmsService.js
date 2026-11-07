const logger = require('../../logger');
const { getDrive } = require('./usbDrive');

// CPP_USBMS enum BrowseCategory (see apps/usbaudio/js/usbaudioApp.js). Only the folder views are
// provided by the emulated drive; the metadata views (artists, albums, ...) are not, because the
// drive reports that metadata browsing is not possible.
const BROWSE = { ALL_CONTENTS_IN_FOLDER: 4, ALL_SUBFOLDER_ENTRIES_IN_FOLDER: 7 };

function response(request, params) {
    return {
        msgType: 'methodResponse',
        serviceName: request.serviceName,
        methodName: request.methodName,
        reqId: request.reqId,
        params: params
    };
}

function errorResponse(request, reason) {
    return {
        msgType: 'methodErrorResponse',
        serviceName: request.serviceName,
        methodName: request.methodName,
        reqId: request.reqId,
        params: { error: reason }
    };
}

function browseContext(request, drive) {
    const context = request.params && request.params.browseContext;
    const filter =
        context && context.filterList && Array.isArray(context.filterList.filter)
            ? context.filterList.filter[0]
            : null;
    if (!filter) {
        return errorResponse(request, 'no filter');
    }
    const folderId = drive.folderIdOf(filter);
    let page = null;
    if (filter.filterEnum === BROWSE.ALL_CONTENTS_IN_FOLDER) {
        page = drive.library.browseFolder(folderId, context.offset, context.count);
    } else if (filter.filterEnum === BROWSE.ALL_SUBFOLDER_ENTRIES_IN_FOLDER) {
        page = drive.library.browseAllSongs(folderId, context.offset, context.count);
    } else {
        // artists, albums, genres, playlists, ...: nothing on this drive
        page = { itemList: [], totalCount: 0 };
    }
    if (!page) {
        return errorResponse(request, 'unknown folder');
    }
    return response(request, { browseContextReply: page });
}

function getBrowseFolderInfo(request, drive) {
    const info = request.params && request.params.getBrowseFolderInfo;
    const folder = info ? drive.library.folderInfo(drive.folderIdOf({ idLevel1: info.itemId })) : null;
    if (!folder) {
        return response(request, { getBrowseFolderInfoReply: { result: 1 } });
    }
    return response(request, { getBrowseFolderInfoReply: { result: 0, ...folder } });
}

// Answers one AppSDK request of the GUI (`usbms` service). Returns the message to send back,
// or null for a service this emulator does not stand in for.
function handleRequest(request, drive = getDrive()) {
    if (!request || request.msgType !== 'method' || request.serviceName !== 'usbms') {
        return null;
    }
    if (!drive.isInserted()) {
        return errorResponse(request, 'no device');
    }
    switch (request.methodName) {
        case 'BrowseContext':
            return browseContext(request, drive);
        case 'GetBrowseFolderInfo':
            return getBrowseFolderInfo(request, drive);
        case 'GetAlphabet':
            // letter index of the metadata lists, which this drive does not have
            return response(request, { getAlphabetReply: { item: [] } });
        default:
            logger.debug('usbms', 'Unsupported method %s', request.methodName);
            return errorResponse(request, 'unsupported method');
    }
}

module.exports = { handleRequest, BROWSE };
