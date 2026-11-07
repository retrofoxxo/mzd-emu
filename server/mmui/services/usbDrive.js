const { loadUsbConfig } = require('../../usb/config');
const { UsbLibrary, OBJECT_ID_INVALID, ROOT_FOLDER_ID } = require('../../usb/library');
const { UsbPlayer } = require('./usbPlayer');
const speaker = require('./speaker');
const audioFocus = require('./audioFocus');

// USB device A of the head unit: the directory from config/usb.json (or MZD_USB_DIR) plays the
// role of a flash drive that is plugged in.
const DEVICE = { usb: 'A', deviceId: 1, type: 'UMASS' };

class UsbDrive {
    constructor(config, speakerPort) {
        this.config = config;
        this.library = config.musicDir ? new UsbLibrary(config.musicDir) : null;
        this.player = new UsbPlayer({
            speaker: speakerPort,
            onBeforePlay: () => audioFocus.acquire('usb')
        });
        audioFocus.register('usb', this.player);
    }

    // A drive is "inserted" when its directory exists. It may still hold no music.
    isInserted() {
        return this.library !== null;
    }

    hasMusic() {
        return this.library !== null && !this.library.isEmpty();
    }

    name() {
        return this.config.deviceName;
    }

    // Reads the directory again (the user copied new files onto the "drive").
    rescan() {
        if (this.library) {
            this.library.scan();
        }
    }

    // Folder id of a filter's idLevel1: the firmware sends "invalid" or 0 for the root.
    folderIdOf(filter) {
        const id = Number(filter && filter.idLevel1);
        return !id || id === OBJECT_ID_INVALID ? ROOT_FOLDER_ID : id;
    }
}

let instance = null;

function getDrive() {
    if (!instance) {
        instance = new UsbDrive(loadUsbConfig(), speaker);
    }
    return instance;
}

// For tests: a drive built from the given config and speaker, replacing the shared one.
function setDrive(drive) {
    instance = drive;
}

module.exports = { UsbDrive, getDrive, setDrive, DEVICE };
