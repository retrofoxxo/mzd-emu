const defaults = require('../../config/wifi.json');
const settings = require('./settings');

// The head unit's Wi-Fi (client mode). A browser cannot scan for access points, so the networks
// "in range" are virtual: the list in config/wifi.json, with their security and password. The
// screens behave as on the car: scan list, connect (with a password for secured networks),
// remembered networks, disconnect, delete, and a hidden network by name.

// BLM_WIFI_Security_Types of the firmware (see apps/netmgmt/js/netmgmtApp.js).
const SECURITY = { None: 0, WEP: 2, WPA: 4, WPA2: 8, 'WPA/WPA2': 12 };
const MODE = { OFF: 0, CLIENT: 1, ACCESS_POINT: 2 };
const MAX_REMEMBERED = 10;

class WifiService {
    constructor(config = defaults) {
        this.config = config;
        this.networks = (config.networks || []).map((network, index) => ({
            ssid: network.ssid,
            bssid: '02:00:00:00:00:' + (index + 1).toString(16).padStart(2, '0'),
            securityType: SECURITY[network.security] || 0,
            password: network.password || '',
            signal: Math.max(0, Math.min(100, Number(network.signal) || 0)),
            hidden: network.hidden === true
        }));
        this.nextId = 1;
        this.remembered = [];
        (config.remembered || []).forEach((ssid) => {
            const network = this.find(ssid);
            if (network) {
                this.remember(network, network.password);
            }
        });
        this.connected = null; // ssid
        // Joining a remembered network happens once when Wi-Fi comes on, not again after the user
        // has disconnected.
        this.autoDone = false;
        // what the user is entering for a network that is not remembered yet
        this.pending = { bssid: null, password: '' };
        this.hidden = { networkName: '', securityType: '', password: '' };
    }

    connectDelayMs() {
        return Number(this.config.connectMs) >= 0 ? Number(this.config.connectMs) : 1500;
    }

    isOn() {
        return settings.currentSettings.wifiMode === MODE.CLIENT;
    }

    find(ssid) {
        return this.networks.find((network) => network.ssid === ssid) || null;
    }

    findByBssid(bssid) {
        return this.networks.find((network) => network.bssid === bssid) || null;
    }

    rememberedBySsid(ssid) {
        return this.remembered.find((entry) => entry.ssid === ssid) || null;
    }

    remember(network, password) {
        const existing = this.rememberedBySsid(network.ssid);
        if (existing) {
            existing.password = password;
            return existing;
        }
        const entry = {
            id: this.nextId++,
            ssid: network.ssid,
            securityType: network.securityType,
            password: password
        };
        this.remembered.push(entry);
        return entry;
    }

    forget(id) {
        const entry = this.remembered.find((item) => item.id === Number(id));
        if (!entry) {
            return null;
        }
        this.remembered = this.remembered.filter((item) => item !== entry);
        if (this.connected === entry.ssid) {
            this.connected = null;
        }
        return entry;
    }

    // Checks a password the way the access point would: 'ok', 'bad-password' or 'not-found'.
    check(ssid, password) {
        const network = this.find(ssid);
        if (!network || !this.isOn()) {
            return 'not-found';
        }
        if (network.securityType !== 0 && network.password !== password) {
            return 'bad-password';
        }
        return 'ok';
    }

    connect(ssid, password) {
        const network = this.find(ssid);
        this.connected = ssid;
        this.remember(network, password);
        this.pending = { bssid: null, password: '' };
    }

    disconnect() {
        this.connected = null;
    }

    // Connects to a remembered network that is in range, as the unit does when Wi-Fi comes on.
    autoConnect() {
        if (!this.isOn() || this.connected || this.autoDone) {
            return;
        }
        this.autoDone = true;
        const entry = this.remembered.find((item) => {
            const network = this.find(item.ssid);
            return network && !network.hidden && this.check(item.ssid, item.password) === 'ok';
        });
        if (entry) {
            this.connected = entry.ssid;
        }
    }

    // Wi-Fi went off (or changed mode): the next time it is on it joins a remembered network again.
    disconnectAll() {
        this.connected = null;
        this.autoDone = false;
    }

    // Wi-Fi was switched on.
    switchedOn() {
        this.autoDone = false;
    }

    rememberedCount() {
        return this.remembered.length;
    }

    maxRemembered() {
        return MAX_REMEMBERED;
    }

    // ScannedNetworksList: the visible networks in range.
    scanList() {
        if (!this.isOn()) {
            return { size: 0, list: [] };
        }
        const list = this.networks
            .filter((network) => !network.hidden)
            .map((network) => {
                const entry = this.rememberedBySsid(network.ssid);
                return {
                    name: network.ssid,
                    bssid: network.bssid,
                    id: entry ? entry.id : -1,
                    connectionState: this.connected === network.ssid ? 1 : 0,
                    signalStrength: network.signal,
                    securityType: network.securityType,
                    stateFlags: entry ? 1 : 0
                };
            });
        return { size: list.length, list: list };
    }

    // RememberedNetworksList: the saved networks, in range or not.
    rememberedList() {
        const list = this.remembered.map((entry) => {
            const network = this.find(entry.ssid);
            return {
                name: entry.ssid,
                bssid: network ? network.bssid : '',
                id: entry.id,
                connectionState: this.connected === entry.ssid ? 1 : 0,
                signalStrength: network && this.isOn() ? network.signal : 0,
                securityType: entry.securityType
            };
        });
        return { size: list.length, list: list };
    }

    // WifiStatus: on/off, connected (3) or not (0), the signal of the connected network.
    status() {
        const network = this.connected ? this.find(this.connected) : null;
        return {
            onOffState: this.isOn() ? 1 : 0,
            connectedState: network ? 3 : 0,
            transmissionState: 0,
            signalStrength: network ? network.signal : 0
        };
    }

    resetHidden() {
        this.hidden = { networkName: '', securityType: '', password: '' };
    }
}

let instance = null;

function getWifi() {
    if (!instance) {
        instance = new WifiService();
    }
    return instance;
}

// For tests: replaces the shared service.
function setWifi(service) {
    instance = service;
}

module.exports = { WifiService, getWifi, setWifi, SECURITY, MODE };
