const fs = require('fs');
const path = require('path');
const defaults = require('../config/usb.json');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

// The directory that plays the role of the USB flash drive. `MZD_USB_DIR` overrides
// `musicDir` from config/usb.json; a relative path is taken from the project root. The result
// has `musicDir === null` when nothing is configured or the directory does not exist, which the
// GUI shows as "no USB device inserted".
function loadUsbConfig(env = process.env, config = defaults) {
    const configured = String(env.MZD_USB_DIR || config.musicDir || '').trim();
    const deviceName = String(config.deviceName || 'USB DEVICE').trim() || 'USB DEVICE';
    if (!configured) {
        return { musicDir: null, configured: '', deviceName: deviceName };
    }
    const resolved = path.resolve(PROJECT_ROOT, configured);
    let isDirectory = false;
    try {
        isDirectory = fs.statSync(resolved).isDirectory();
    } catch {
        isDirectory = false;
    }
    return {
        musicDir: isDirectory ? resolved : null,
        configured: configured,
        deviceName: deviceName
    };
}

module.exports = { loadUsbConfig, PROJECT_ROOT };
