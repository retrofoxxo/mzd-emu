const { loadBluetoothConfig } = require('../../bluetooth/config');
const { UsbLibrary } = require('../../usb/library');
const { UsbPlayer } = require('./usbPlayer');
const speaker = require('./speaker');
const audioFocus = require('./audioFocus');
const { PhoneCalls } = require('./phoneCalls');
const { Phonebook } = require('./phonebook');
const { EmergencyCall } = require('./emergencyCall');
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
        this.paired = true;
        this.profiles = { phone: true, audio: true };
        this.phonebook = new Phonebook(config.contacts);
        this.calls = new PhoneCalls({ answerMs: config.callAnswerMs, ringMs: config.callRingMs });
        this.calls.seedHistory(config.callHistory);
        this.emergency = new EmergencyCall({ phone: this, ...config.emergency });
    }

    // Pairing: the phone is paired with the head unit and has the phone (hands-free) and the audio
    // (music) profile connected, until the user disconnects or removes it.
    bluetoothOn() {
        return settings.currentSettings.bluetooth === 'On';
    }

    isConnected() {
        return this.bluetoothOn() && this.paired && (this.profiles.phone || this.profiles.audio);
    }

    phoneOn() {
        return this.bluetoothOn() && this.paired && this.profiles.phone;
    }

    audioOn() {
        return this.bluetoothOn() && this.paired && this.profiles.audio;
    }

    // kind: 'phoneAndAudio', 'phoneOnly', 'audioOnly'
    connectProfiles(kind) {
        this.paired = true;
        this.profiles = {
            phone: kind === 'phoneAndAudio' || kind === 'phoneOnly',
            audio: kind === 'phoneAndAudio' || kind === 'audioOnly'
        };
    }

    disconnectProfiles() {
        this.profiles = { phone: false, audio: false };
    }

    unpair() {
        this.paired = false;
        this.disconnectProfiles();
    }

    // What a profile going away does: music stops, a call ends.
    applyProfiles() {
        if (!this.audioOn()) {
            this.player.pause();
        }
        if (!this.phoneOn()) {
            this.calls.hangup();
        }
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
