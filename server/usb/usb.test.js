const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsbLibrary, ITEM_TYPE, OBJECT_ID_INVALID } = require('./library');
const { readTags } = require('./tags');
const { parseRange, resolveInside } = require('./media');
const { loadUsbConfig } = require('./config');

function makeDrive() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-'));
    const put = (rel, content = 'x') => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    };
    put('b.mp3');
    put('a10.mp3');
    put('a2.mp3');
    put('notes.txt');
    put('Rock/one.flac');
    put('Rock/Live/two.ogg');
    put('Empty/readme.txt');
    put('.hidden/x.mp3');
    return root;
}

test('library lists folders first, sorts naturally and hides folders without music', () => {
    const lib = new UsbLibrary(makeDrive());
    const names = lib.listEntries(1).map((e) => e.name);
    assert.deepEqual(names, ['Rock', 'a2.mp3', 'a10.mp3', 'b.mp3']);
    assert.equal(lib.listEntries(1)[0].type, ITEM_TYPE.BROWSABLE);
    assert.equal(lib.listEntries(1)[1].type, ITEM_TYPE.PLAYABLE_FILE);
});

test('library pages, counts and reports folder info', () => {
    const lib = new UsbLibrary(makeDrive());
    const page = lib.browseFolder(1, 1, 2);
    assert.equal(page.totalCount, 4);
    assert.equal(page.itemList.length, 2);
    const rock = lib.listEntries(1)[0];
    assert.deepEqual(lib.folderInfo(rock.id), { folderName: 'Rock', parentId: 1, parentName: '/' });
    assert.equal(lib.folderInfo(1).parentId, OBJECT_ID_INVALID);
    assert.equal(lib.browseFolder(9999, 0, 5), null);
});

test('allFilesUnder walks the tree and folder files stay direct', () => {
    const lib = new UsbLibrary(makeDrive());
    assert.deepEqual(
        lib.allFilesUnder(1).map((f) => f.relPath),
        ['Rock/Live/two.ogg', 'Rock/one.flac', 'a2.mp3', 'a10.mp3', 'b.mp3']
    );
    assert.equal(lib.filesIn(1).length, 3);
});

function id3Frame(id, text) {
    const data = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
    const header = Buffer.alloc(10);
    header.write(id, 0, 'latin1');
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
}

test('tag reader parses ID3v2.3 text frames and falls back to nothing on junk', () => {
    const frames = Buffer.concat([
        id3Frame('TIT2', 'Song'),
        id3Frame('TPE1', 'Band'),
        id3Frame('TALB', 'Disc'),
        id3Frame('TCON', '(17)')
    ]);
    const header = Buffer.alloc(10);
    header.write('ID3', 0, 'latin1');
    header[3] = 3;
    header[6] = (frames.length >> 21) & 0x7f;
    header[7] = (frames.length >> 14) & 0x7f;
    header[8] = (frames.length >> 7) & 0x7f;
    header[9] = frames.length & 0x7f;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tag-')), 't.mp3');
    fs.writeFileSync(file, Buffer.concat([header, frames, Buffer.alloc(32)]));
    const tags = readTags(file);
    assert.equal(tags.title, 'Song');
    assert.equal(tags.artist, 'Band');
    assert.equal(tags.album, 'Disc');
    assert.equal(tags.genre, 'Rock');

    fs.writeFileSync(file, 'not audio');
    assert.equal(readTags(file).title, '');
    assert.equal(readTags('/nonexistent/file.mp3').title, '');
});

test('tag reader parses FLAC vorbis comments', () => {
    const comment = (s) => {
        const b = Buffer.from(s);
        const l = Buffer.alloc(4);
        l.writeUInt32LE(b.length);
        return Buffer.concat([l, b]);
    };
    const vendor = Buffer.from('x');
    const body = Buffer.concat([
        Buffer.from([1, 0, 0, 0]).fill(0, 1),
        vendor,
        Buffer.from([2, 0, 0, 0]),
        comment('TITLE=Flac Song'),
        comment('ARTIST=Flac Band')
    ]);
    body.writeUInt32LE(vendor.length, 0);
    const block = Buffer.alloc(4);
    block[0] = 0x80 | 4;
    block.writeUIntBE(body.length, 1, 3);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flac-')), 't.flac');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('fLaC'), block, body]));
    const tags = readTags(file);
    assert.equal(tags.title, 'Flac Song');
    assert.equal(tags.artist, 'Flac Band');
});

test('range header parsing', () => {
    assert.equal(parseRange(undefined, 100), null);
    assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
    assert.equal(parseRange('bytes=100-', 100), 'invalid');
    assert.equal(parseRange('garbage', 100), null);
});

test('media paths cannot leave the music directory', () => {
    const root = makeDrive();
    assert.equal(resolveInside(root, 'Rock/one.flac'), path.join(root, 'Rock', 'one.flac'));
    assert.equal(resolveInside(root, '..%2Fsecret.mp3'), null);
    assert.equal(resolveInside(root, '../secret.mp3'), null);
    assert.equal(resolveInside(null, 'a.mp3'), null);
});

test('config: env overrides, missing directory means no drive', () => {
    const root = makeDrive();
    assert.equal(loadUsbConfig({ MZD_USB_DIR: root }, { musicDir: 'x' }).musicDir, root);
    assert.equal(loadUsbConfig({}, { musicDir: '/no/such/dir' }).musicDir, null);
    assert.equal(loadUsbConfig({}, { musicDir: '' }).musicDir, null);
});
