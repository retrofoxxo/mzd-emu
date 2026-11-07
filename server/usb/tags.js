const fs = require('fs');
const path = require('path');

// A small, dependency-free reader for the tags the Now Playing screen shows: title, artist,
// album, genre and the embedded cover. It understands ID3v2 / ID3v1 (MP3), FLAC and MP4/M4A.
// Files it cannot read (or that carry no tags, like WAV) yield an empty result; it never throws.

const MAX_ID3_TAG_BYTES = 16 * 1024 * 1024;
const MAX_FLAC_BLOCK_BYTES = 16 * 1024 * 1024;

// The ID3v1 genre table (first 80 entries, as in the original specification).
const ID3V1_GENRES = [
    'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz',
    'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno',
    'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno',
    'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental',
    'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'AlternRock', 'Bass', 'Soul', 'Punk',
    'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave',
    'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy',
    'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American',
    'Cabaret', 'New Wave', 'Psychadelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal',
    'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock'
];

function emptyTags() {
    return { title: '', artist: '', album: '', genre: '', picture: null };
}

function readBytes(fd, position, length) {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, position);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

function cleanText(value) {
    return String(value || '')
        .replace(/\0+$/g, '')
        .replace(/\0/g, ' / ')
        .trim();
}

function resolveGenre(value) {
    const text = cleanText(value);
    const numeric = /^\((\d+)\)$|^(\d+)$/.exec(text);
    if (numeric) {
        return ID3V1_GENRES[Number(numeric[1] || numeric[2])] || '';
    }
    return text.replace(/^\(\d+\)/, '');
}

// ---------------------------------------------------------------- ID3

function decodeId3Text(buffer, encoding) {
    switch (encoding) {
        case 1: {
            // UTF-16 with a byte order mark
            if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
                return swapBytes(buffer.subarray(2)).toString('utf16le');
            }
            const start = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? 2 : 0;
            return buffer.subarray(start).toString('utf16le');
        }
        case 2:
            return swapBytes(buffer).toString('utf16le');
        case 3:
            return buffer.toString('utf8');
        default:
            return buffer.toString('latin1');
    }
}

function swapBytes(buffer) {
    const copy = Buffer.from(buffer);
    // swap16 needs an even length
    return copy.length % 2 === 0 ? copy.swap16() : copy.subarray(0, copy.length - 1).swap16();
}

function synchsafe(buffer, offset) {
    return (
        ((buffer[offset] & 0x7f) << 21) |
        ((buffer[offset + 1] & 0x7f) << 14) |
        ((buffer[offset + 2] & 0x7f) << 7) |
        (buffer[offset + 3] & 0x7f)
    );
}

function unsynchronise(buffer) {
    const out = [];
    for (let i = 0; i < buffer.length; i++) {
        out.push(buffer[i]);
        if (buffer[i] === 0xff && buffer[i + 1] === 0x00) {
            i++;
        }
    }
    return Buffer.from(out);
}

function id3TextFrame(data) {
    if (data.length < 2) {
        return '';
    }
    return cleanText(decodeId3Text(data.subarray(1), data[0]));
}

// Index of the string terminator that fits the encoding, or -1.
function findTerminator(buffer, from, encoding) {
    if (encoding === 1 || encoding === 2) {
        for (let i = from; i + 1 < buffer.length; i += 2) {
            if (buffer[i] === 0 && buffer[i + 1] === 0) {
                return i;
            }
        }
        return -1;
    }
    return buffer.indexOf(0, from);
}

function id3PictureFrame(data, version) {
    if (data.length < 4) {
        return null;
    }
    const encoding = data[0];
    let offset = 1;
    let mime;
    if (version === 2) {
        const format = data.subarray(1, 4).toString('latin1').toUpperCase();
        mime = format === 'PNG' ? 'image/png' : 'image/jpeg';
        offset = 4;
    } else {
        const end = data.indexOf(0, 1);
        if (end < 0) {
            return null;
        }
        mime = data.subarray(1, end).toString('latin1').toLowerCase() || 'image/jpeg';
        offset = end + 1;
    }
    offset += 1; // picture type
    const descriptionEnd = findTerminator(data, offset, encoding);
    if (descriptionEnd < 0) {
        return null;
    }
    offset = descriptionEnd + (encoding === 1 || encoding === 2 ? 2 : 1);
    const bytes = data.subarray(offset);
    if (bytes.length === 0) {
        return null;
    }
    return { mime: mime === 'image/jpg' ? 'image/jpeg' : mime, data: bytes };
}

function readId3v2(fd, tags) {
    const header = readBytes(fd, 0, 10);
    if (header.length < 10 || header.toString('latin1', 0, 3) !== 'ID3') {
        return 0;
    }
    const version = header[3];
    const flags = header[5];
    const size = synchsafe(header, 6);
    const total = 10 + size;
    if (![2, 3, 4].includes(version) || size > MAX_ID3_TAG_BYTES) {
        return total;
    }
    let body = readBytes(fd, 10, size);
    if (version < 4 && flags & 0x80) {
        body = unsynchronise(body);
    }

    let offset = 0;
    if (flags & 0x40 && version >= 3 && body.length >= 4) {
        // extended header
        offset = version === 4 ? synchsafe(body, 0) : body.readUInt32BE(0) + 4;
    }

    const idLength = version === 2 ? 3 : 4;
    const headerLength = version === 2 ? 6 : 10;
    while (offset + headerLength <= body.length) {
        const id = body.toString('latin1', offset, offset + idLength);
        if (!/^[A-Z0-9]+$/.test(id)) {
            break; // padding
        }
        let frameSize;
        if (version === 2) {
            frameSize = (body[offset + 3] << 16) | (body[offset + 4] << 8) | body[offset + 5];
        } else if (version === 4) {
            frameSize = synchsafe(body, offset + 4);
        } else {
            frameSize = body.readUInt32BE(offset + 4);
        }
        const start = offset + headerLength;
        const end = start + frameSize;
        if (frameSize <= 0 || end > body.length) {
            break;
        }
        let data = body.subarray(start, end);
        if (version === 4 && body[offset + 9] & 0x02) {
            data = unsynchronise(data);
        }
        assignId3Frame(tags, id, data, version);
        offset = end;
    }
    return total;
}

function assignId3Frame(tags, id, data, version) {
    switch (id) {
        case 'TIT2':
        case 'TT2':
            tags.title = tags.title || id3TextFrame(data);
            break;
        case 'TPE1':
        case 'TP1':
            tags.artist = tags.artist || id3TextFrame(data);
            break;
        case 'TPE2':
        case 'TP2':
            // the album artist is only a fallback for the artist
            tags.albumArtist = tags.albumArtist || id3TextFrame(data);
            break;
        case 'TALB':
        case 'TAL':
            tags.album = tags.album || id3TextFrame(data);
            break;
        case 'TCON':
        case 'TCO':
            tags.genre = tags.genre || resolveGenre(id3TextFrame(data));
            break;
        case 'APIC':
        case 'PIC':
            if (!tags.picture) {
                tags.picture = id3PictureFrame(data, version);
            }
            break;
        default:
            break;
    }
}

function readId3v1(fd, size, tags) {
    if (size < 128) {
        return;
    }
    const block = readBytes(fd, size - 128, 128);
    if (block.length < 128 || block.toString('latin1', 0, 3) !== 'TAG') {
        return;
    }
    tags.title = tags.title || cleanText(block.toString('latin1', 3, 33));
    tags.artist = tags.artist || cleanText(block.toString('latin1', 33, 63));
    tags.album = tags.album || cleanText(block.toString('latin1', 63, 93));
    tags.genre = tags.genre || ID3V1_GENRES[block[127]] || '';
}

// ---------------------------------------------------------------- FLAC

function applyVorbisComment(tags, block) {
    if (block.length < 8) {
        return;
    }
    let offset = 4 + block.readUInt32LE(0); // vendor string
    if (offset + 4 > block.length) {
        return;
    }
    const count = block.readUInt32LE(offset);
    offset += 4;
    for (let i = 0; i < count && offset + 4 <= block.length; i++) {
        const length = block.readUInt32LE(offset);
        offset += 4;
        if (offset + length > block.length) {
            break;
        }
        const text = block.toString('utf8', offset, offset + length);
        offset += length;
        const equals = text.indexOf('=');
        if (equals < 1) {
            continue;
        }
        const key = text.slice(0, equals).toUpperCase();
        const value = cleanText(text.slice(equals + 1));
        if (key === 'TITLE') tags.title = tags.title || value;
        else if (key === 'ARTIST') tags.artist = tags.artist || value;
        else if (key === 'ALBUMARTIST') tags.albumArtist = tags.albumArtist || value;
        else if (key === 'ALBUM') tags.album = tags.album || value;
        else if (key === 'GENRE') tags.genre = tags.genre || value;
    }
}

function flacPicture(block) {
    // type, mime length+mime, description length+description, 4 x uint32, data length+data
    try {
        let offset = 4;
        const mimeLength = block.readUInt32BE(offset);
        offset += 4;
        const mime = block.toString('latin1', offset, offset + mimeLength);
        offset += mimeLength;
        const descriptionLength = block.readUInt32BE(offset);
        offset += 4 + descriptionLength + 16;
        const dataLength = block.readUInt32BE(offset);
        offset += 4;
        const bytes = block.subarray(offset, offset + dataLength);
        return bytes.length ? { mime: mime || 'image/jpeg', data: bytes } : null;
    } catch {
        return null;
    }
}

function readFlac(fd, tags) {
    if (readBytes(fd, 0, 4).toString('latin1') !== 'fLaC') {
        return false;
    }
    let offset = 4;
    for (let guard = 0; guard < 256; guard++) {
        const header = readBytes(fd, offset, 4);
        if (header.length < 4) {
            break;
        }
        const isLast = (header[0] & 0x80) !== 0;
        const type = header[0] & 0x7f;
        const length = (header[1] << 16) | (header[2] << 8) | header[3];
        offset += 4;
        if (length > MAX_FLAC_BLOCK_BYTES) {
            offset += length;
        } else if (type === 4) {
            applyVorbisComment(tags, readBytes(fd, offset, length));
            offset += length;
        } else if (type === 6) {
            if (!tags.picture) {
                tags.picture = flacPicture(readBytes(fd, offset, length));
            }
            offset += length;
        } else {
            offset += length;
        }
        if (isLast) {
            break;
        }
    }
    return true;
}

// ---------------------------------------------------------------- MP4

// Reads the atom header at `offset`: { type, start (of the payload), end }.
function mp4Atom(fd, offset, limit) {
    const header = readBytes(fd, offset, 16);
    if (header.length < 8) {
        return null;
    }
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1 && header.length >= 16) {
        size = Number(header.readBigUInt64BE(8));
        headerSize = 16;
    } else if (size === 0) {
        size = limit - offset;
    }
    if (size < headerSize || offset + size > limit) {
        return null;
    }
    return { type: type, start: offset + headerSize, end: offset + size };
}

function findMp4Atom(fd, start, end, type) {
    for (let offset = start; offset < end; ) {
        const atom = mp4Atom(fd, offset, end);
        if (!atom) {
            return null;
        }
        if (atom.type === type) {
            return atom;
        }
        offset = atom.end;
    }
    return null;
}

function mp4DataValue(fd, item) {
    const data = findMp4Atom(fd, item.start, item.end, 'data');
    if (!data || data.end - data.start < 8) {
        return null;
    }
    const flags = readBytes(fd, data.start, 8);
    return {
        type: flags.readUInt32BE(0) & 0xffffff,
        bytes: readBytes(fd, data.start + 8, data.end - data.start - 8)
    };
}

function readMp4(fd, size, tags) {
    const first = readBytes(fd, 0, 12);
    if (first.length < 12 || first.toString('latin1', 4, 8) !== 'ftyp') {
        return false;
    }
    const moov = findMp4Atom(fd, 0, size, 'moov');
    const udta = moov && findMp4Atom(fd, moov.start, moov.end, 'udta');
    const meta = udta && findMp4Atom(fd, udta.start, udta.end, 'meta');
    // `meta` is a full box: four bytes of version and flags come before its children.
    const ilst = meta && findMp4Atom(fd, meta.start + 4, meta.end, 'ilst');
    if (!ilst) {
        return true;
    }
    for (let offset = ilst.start; offset < ilst.end; ) {
        const item = mp4Atom(fd, offset, ilst.end);
        if (!item) {
            break;
        }
        offset = item.end;
        const value = mp4DataValue(fd, item);
        if (!value) {
            continue;
        }
        if (item.type === 'covr') {
            if (!tags.picture && value.bytes.length) {
                tags.picture = { mime: value.type === 14 ? 'image/png' : 'image/jpeg', data: value.bytes };
            }
            continue;
        }
        const text = cleanText(value.bytes.toString('utf8'));
        if (item.type === '\u00a9nam') tags.title = tags.title || text;
        else if (item.type === '\u00a9ART') tags.artist = tags.artist || text;
        else if (item.type === 'aART') tags.albumArtist = tags.albumArtist || text;
        else if (item.type === '\u00a9alb') tags.album = tags.album || text;
        else if (item.type === '\u00a9gen') tags.genre = tags.genre || text;
    }
    return true;
}

// ---------------------------------------------------------------- API

function readTags(filePath) {
    const tags = emptyTags();
    let fd = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const size = fs.fstatSync(fd).size;
        const extension = path.extname(filePath).toLowerCase();
        if (extension === '.flac') {
            readFlac(fd, tags);
        } else if (extension === '.m4a' || extension === '.aac') {
            readMp4(fd, size, tags);
        } else {
            // MP3 and anything else that may carry an ID3 tag (also on WAV, AAC and OGG files)
            readId3v2(fd, tags);
            if (!tags.title && !tags.artist && !tags.album) {
                readId3v1(fd, size, tags);
            }
        }
    } catch {
        // unreadable file: keep what was found
    } finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch {
                // nothing to do
            }
        }
    }
    tags.artist = tags.artist || tags.albumArtist || '';
    delete tags.albumArtist;
    return tags;
}

// The title the Now Playing screen shows when a file has none: the file name without extension.
function titleFromFileName(fileName) {
    return path.basename(fileName, path.extname(fileName));
}

const COVER_FILE_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
const COVER_EXTENSIONS = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

// A picture next to the audio file (cover.jpg, folder.png, ...), or null.
function findFolderCover(audioFilePath) {
    const directory = path.dirname(audioFilePath);
    let names;
    try {
        names = fs.readdirSync(directory);
    } catch {
        return null;
    }
    for (const base of COVER_FILE_NAMES) {
        for (const name of names) {
            const extension = path.extname(name).toLowerCase();
            if (
                COVER_EXTENSIONS[extension] &&
                path.basename(name, path.extname(name)).toLowerCase() === base
            ) {
                return { mime: COVER_EXTENSIONS[extension], path: path.join(directory, name) };
            }
        }
    }
    return null;
}

module.exports = { readTags, titleFromFileName, findFolderCover, ID3V1_GENRES };
