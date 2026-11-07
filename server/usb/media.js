const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { loadUsbConfig } = require('./config');
const { PLAYABLE_EXTENSIONS } = require('./library');
const { readTags, findFolderCover } = require('./tags');

const AUDIO_PREFIX = '/usb/';
const COVER_PREFIX = '/usb-cover/';

const AUDIO_MIME_TYPES = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg'
};

function sendText(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
}

// Maps the part of a URL after the prefix to a file inside `musicDir`, or null. Only the
// directory configured as the USB drive is reachable.
function resolveInside(musicDir, encodedPath) {
    let relative;
    try {
        relative = decodeURIComponent(encodedPath.split('?')[0]);
    } catch {
        return null;
    }
    if (!musicDir || relative.includes('\0')) {
        return null;
    }
    const resolved = path.resolve(musicDir, relative);
    return resolved.startsWith(musicDir + path.sep) ? resolved : null;
}

// "bytes=START-END", "bytes=START-" or "bytes=-SUFFIX" for a file of `size` bytes:
// { start, end } (inclusive), 'invalid' when it cannot be satisfied, or null for no Range.
function parseRange(header, size) {
    if (!header) {
        return null;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!match || (match[1] === '' && match[2] === '')) {
        return null; // a header we do not understand is ignored: the whole file is sent
    }
    let start;
    let end;
    if (match[1] === '') {
        const suffix = Number(match[2]);
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    }
    if (size === 0 || start > end || start >= size) {
        return 'invalid';
    }
    return { start: start, end: end };
}

function streamFile(req, res, filePath, contentType) {
    fs.stat(filePath, (error, stats) => {
        if (error || !stats.isFile()) {
            sendText(res, 404, '404 Not Found');
            return;
        }
        const range = parseRange(req.headers.range, stats.size);
        if (range === 'invalid') {
            res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
            res.end();
            return;
        }
        const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };
        let streamOptions;
        if (range) {
            res.writeHead(206, {
                ...headers,
                'Content-Range': `bytes ${range.start}-${range.end}/${stats.size}`,
                'Content-Length': range.end - range.start + 1
            });
            streamOptions = { start: range.start, end: range.end };
        } else {
            res.writeHead(200, { ...headers, 'Content-Length': stats.size });
        }
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        const stream = fs.createReadStream(filePath, streamOptions);
        stream.on('error', (streamError) => {
            logger.error('usb', 'Could not stream %s: %s', filePath, streamError.message);
            res.destroy();
        });
        // The browser drops the connection whenever it seeks; that is not an error.
        res.on('close', () => stream.destroy());
        stream.pipe(res);
    });
}

function sendCover(res, audioPath) {
    const tags = readTags(audioPath);
    if (tags.picture) {
        res.writeHead(200, {
            'Content-Type': tags.picture.mime,
            'Content-Length': tags.picture.data.length,
            'Cache-Control': 'max-age=300'
        });
        res.end(tags.picture.data);
        return;
    }
    const cover = findFolderCover(audioPath);
    if (!cover) {
        sendText(res, 404, '404 Not Found');
        return;
    }
    fs.readFile(cover.path, (error, data) => {
        if (error) {
            sendText(res, 404, '404 Not Found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': cover.mime,
            'Content-Length': data.length,
            'Cache-Control': 'max-age=300'
        });
        res.end(data);
    });
}

// Serves the audio files of the USB drive directory at /usb/... and their cover pictures at
// /usb-cover/.... Returns true when the request was one of those (and has been answered).
function createMediaHandler(config = loadUsbConfig()) {
    return function handleMediaRequest(req, res) {
        const url = req.url || '';
        const isAudio = url.startsWith(AUDIO_PREFIX);
        const isCover = url.startsWith(COVER_PREFIX);
        if (!isAudio && !isCover) {
            return false;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendText(res, 405, '405 Method Not Allowed');
            return true;
        }
        const filePath = resolveInside(
            config.musicDir,
            url.slice((isAudio ? AUDIO_PREFIX : COVER_PREFIX).length)
        );
        const extension = filePath ? path.extname(filePath).toLowerCase() : '';
        if (!filePath || !PLAYABLE_EXTENSIONS.has(extension)) {
            sendText(res, 404, '404 Not Found: ' + url);
            return true;
        }
        if (isAudio) {
            streamFile(req, res, filePath, AUDIO_MIME_TYPES[extension] || 'application/octet-stream');
        } else {
            sendCover(res, filePath);
        }
        return true;
    };
}

module.exports = { createMediaHandler, resolveInside, parseRange, AUDIO_PREFIX, COVER_PREFIX };
