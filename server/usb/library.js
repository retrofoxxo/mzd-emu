const fs = require('fs');
const path = require('path');

// What the head unit's USB audio player can play (the browser has to decode it as well).
const PLAYABLE_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus']);

// CPP_USBMS enum itemType (see apps/usbaudio/js/usbaudioApp.js).
const ITEM_TYPE = { BROWSABLE: 1, PLAYABLE_FILE: 2 };

// The id the firmware uses for "no object", and the root folder of a device.
const OBJECT_ID_INVALID = 2147483647;
const ROOT_FOLDER_ID = 1;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);

function isPlayable(fileName) {
    return PLAYABLE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

// The folder tree of one directory, numbered like the firmware numbers a device's folders: the
// root is 1 and every other folder and file gets the next free id while walking the tree. Folders
// that hold no playable file anywhere below them are left out, as the head unit hides them.
class UsbLibrary {
    constructor(rootDir) {
        this.rootDir = rootDir;
        this.folders = new Map();
        this.files = new Map();
        this.scan();
    }

    scan() {
        this.folders = new Map();
        this.files = new Map();
        this.nextId = ROOT_FOLDER_ID;
        this.walk(this.rootDir, '', null, '/');
        return this;
    }

    // Returns the folder, or null when it (and everything below it) holds no playable file.
    walk(absDir, relDir, parentId, name) {
        let dirents;
        try {
            dirents = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
            return null;
        }
        const folder = {
            id: this.nextId++,
            name: name,
            parentId: parentId,
            relPath: relDir,
            folderIds: [],
            fileIds: []
        };
        this.folders.set(folder.id, folder);

        const subDirs = [];
        const audioFiles = [];
        for (const dirent of dirents) {
            if (dirent.name.startsWith('.')) {
                continue;
            }
            const abs = path.join(absDir, dirent.name);
            // A symbolic link counts as what it points to.
            let kind = dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : null;
            if (dirent.isSymbolicLink()) {
                try {
                    const stats = fs.statSync(abs);
                    kind = stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : null;
                } catch {
                    kind = null;
                }
            }
            if (kind === 'dir') {
                subDirs.push({ name: dirent.name, abs: abs });
            } else if (kind === 'file' && isPlayable(dirent.name)) {
                audioFiles.push({ name: dirent.name, abs: abs });
            }
        }

        subDirs.sort(byName);
        audioFiles.sort(byName);

        for (const dir of subDirs) {
            const rel = relDir ? relDir + '/' + dir.name : dir.name;
            const child = this.walk(dir.abs, rel, folder.id, dir.name);
            if (child) {
                folder.folderIds.push(child.id);
            }
        }
        for (const file of audioFiles) {
            const record = {
                id: this.nextId++,
                name: file.name,
                folderId: folder.id,
                relPath: relDir ? relDir + '/' + file.name : file.name,
                absPath: file.abs
            };
            this.files.set(record.id, record);
            folder.fileIds.push(record.id);
        }

        if (folder.id !== ROOT_FOLDER_ID && !this.hasPlayable(folder)) {
            // Nothing playable below: drop the folder and the ids it took.
            this.removeFolder(folder);
            return null;
        }
        return folder;
    }

    hasPlayable(folder) {
        return (
            folder.fileIds.length > 0 ||
            folder.folderIds.some((id) => this.hasPlayable(this.folders.get(id)))
        );
    }

    removeFolder(folder) {
        this.folders.delete(folder.id);
    }

    getFolder(id) {
        return this.folders.get(Number(id)) || null;
    }

    getFile(id) {
        return this.files.get(Number(id)) || null;
    }

    isEmpty() {
        return this.files.size === 0;
    }

    // What a folder lists: its sub folders, then its files (the order of the firmware list).
    listEntries(folderId) {
        const folder = this.getFolder(folderId);
        if (!folder) {
            return null;
        }
        const entries = [];
        folder.folderIds.forEach((id) => {
            const child = this.folders.get(id);
            entries.push({ id: child.id, name: child.name, type: ITEM_TYPE.BROWSABLE });
        });
        folder.fileIds.forEach((id) => {
            const file = this.files.get(id);
            entries.push({ id: file.id, name: file.name, type: ITEM_TYPE.PLAYABLE_FILE });
        });
        return entries;
    }

    // The files directly in a folder, in list order.
    filesIn(folderId) {
        const folder = this.getFolder(folderId);
        return folder ? folder.fileIds.map((id) => this.files.get(id)) : [];
    }

    // Every file in a folder and below it, in tree order.
    allFilesUnder(folderId) {
        const folder = this.getFolder(folderId);
        if (!folder) {
            return [];
        }
        const result = [];
        const visit = (current) => {
            current.folderIds.forEach((id) => visit(this.folders.get(id)));
            current.fileIds.forEach((id) => result.push(this.files.get(id)));
        };
        visit(folder);
        return result;
    }

    // BrowseContext for ALL_CONTENTS_IN_FOLDER: one page of the folder list.
    browseFolder(folderId, offset, count) {
        const entries = this.listEntries(folderId);
        if (!entries) {
            return null;
        }
        return pageOf(entries, offset, count);
    }

    // BrowseContext for ALL_SUBFOLDER_ENTRIES_IN_FOLDER: one page of every file below a folder.
    browseAllSongs(folderId, offset, count) {
        if (!this.getFolder(folderId)) {
            return null;
        }
        const entries = this.allFilesUnder(folderId).map((file) => ({
            id: file.id,
            name: file.name,
            type: ITEM_TYPE.PLAYABLE_FILE
        }));
        return pageOf(entries, offset, count);
    }

    // GetBrowseFolderInfo.
    folderInfo(folderId) {
        const folder = this.getFolder(folderId);
        if (!folder) {
            return null;
        }
        const parent = folder.parentId === null ? null : this.getFolder(folder.parentId);
        return {
            folderName: folder.name,
            parentId: parent ? parent.id : OBJECT_ID_INVALID,
            parentName: parent ? parent.name : ''
        };
    }
}

function pageOf(entries, offset, count) {
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.max(0, Number(count) || 0);
    return {
        itemList: entries.slice(start, start + size).map((entry) => ({
            itemName: entry.name,
            itemId: entry.id,
            itemType: entry.type
        })),
        totalCount: entries.length
    };
}

// URL under which ui-server.js streams a file of the drive (see usb/media.js).
function mediaUrl(file) {
    return '/usb/' + file.relPath.split('/').map(encodeURIComponent).join('/');
}

// URL of the cover picture of a file (embedded in it, or a cover.jpg next to it).
function coverUrl(file) {
    return mediaUrl(file).replace('/usb/', '/usb-cover/');
}

module.exports = {
    UsbLibrary,
    PLAYABLE_EXTENSIONS,
    ITEM_TYPE,
    OBJECT_ID_INVALID,
    ROOT_FOLDER_ID,
    isPlayable,
    mediaUrl,
    coverUrl
};
