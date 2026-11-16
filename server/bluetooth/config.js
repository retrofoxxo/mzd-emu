const fs = require('fs');
const path = require('path');
const defaults = require('../config/bluetooth.json');
const { PROJECT_ROOT, loadUsbConfig } = require('../usb/config');

function level(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(5, Math.max(0, Math.round(number))) : fallback;
}

// The emulated phone that is paired with the head unit (config/bluetooth.json). Its music comes
// from `musicDir`; when that is empty the phone carries the same music as the USB drive.
// `MZD_BT_MUSIC_DIR` overrides it.
function loadBluetoothConfig(env = process.env, config = defaults, usbConfig = loadUsbConfig(env)) {
    const phone = config.phone || {};
    const configured = String(env.MZD_BT_MUSIC_DIR || config.musicDir || '').trim();
    let musicDir = usbConfig.musicDir;
    if (configured) {
        const resolved = path.resolve(PROJECT_ROOT, configured);
        let isDirectory = false;
        try {
            isDirectory = fs.statSync(resolved).isDirectory();
        } catch {
            isDirectory = false;
        }
        musicDir = isDirectory ? resolved : null;
    }
    return {
        name: String(phone.name || 'Mock Phone').trim() || 'Mock Phone',
        address: String(phone.address || 'AA:BB:CC:DD:EE:01'),
        batteryLevel: level(phone.batteryLevel, 4),
        signalStrength: level(phone.signalStrength, 4),
        network: String(phone.network || ''),
        callAnswerMs: Number((config.calls || {}).answerMs) >= 0 ? Number(config.calls.answerMs) : 3000,
        callRingMs: Number((config.calls || {}).ringMs) > 0 ? Number(config.calls.ringMs) : 30000,
        emergency: {
            countdownS: Number((config.emergency || {}).countdownS) > 0 ? Number(config.emergency.countdownS) : 10,
            searchMs: Number((config.emergency || {}).searchMs) >= 0 ? Number(config.emergency.searchMs) : 2000,
            connectMs: Number((config.emergency || {}).connectMs) >= 0 ? Number(config.emergency.connectMs) : 4000
        },
        contacts: Array.isArray(config.contacts) ? config.contacts : [],
        callHistory: Array.isArray(config.callHistory) ? config.callHistory : [],
        musicDir: musicDir
    };
}

module.exports = { loadBluetoothConfig };
