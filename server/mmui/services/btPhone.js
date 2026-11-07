const { loadBluetoothConfig } = require('../../bluetooth/config');
const { UsbLibrary } = require('../../usb/library');
const { UsbPlayer } = require('./usbPlayer');
const speaker = require('./speaker');
const audioFocus = require('./audioFocus');
const settings = require('./settings');

// The emulated phone paired with the head unit. It is connected while Bluetooth is switched on.
// It plays music (Bluetooth audio) from its own directory, with the controls of AVRCP.
class BtPhone {
    constructor(config, speakerPort) {
        this.config = config;
        this.library = config.musicDir ? new UsbLibrary(config.musicDir) : null;
        this.player = new UsbPlayer({
            speaker: speakerPort,
            onBeforePlay: () => audioFocus.acquire('bt')
        });
        audioFocus.register('bt', this.player);
    }

    isConnected() {
        return settings.currentSettings.bluetooth === 'On';
    }

    name() {
        return this.config.name;
    }

    hasMusic() {
        return this.library !== null && !this.library.isEmpty();
    }
}

let instance = null;

function getPhone() {
    if (!instance) {
        instance = new BtPhone(loadBluetoothConfig(), speaker);
    }
    return instance;
}

// For tests: replaces the shared phone.
function setPhone(phone) {
    instance = phone;
}

module.exports = { BtPhone, getPhone, setPhone };
