const logger = require('../../logger');
const catalog = require('../../vehicle/warningCatalog.json');
const config = require('../../config/warnings.json');

// The vehicle's warning list: the warnings the car reports through the instrument cluster
// (Warning Guidance in the Applications menu, the warning counter next to it and the pop-up for
// high priority warnings). The catalog is the firmware's own warning table (warning numbers,
// priority and the English texts); which warnings are active is decided here: from
// config/warnings.json at start, then from the emulator controls panel (see controlPanel.js).
const BY_NUMBER = new Map(catalog.map((entry) => [entry.no, entry]));

let active = []; // warning numbers, in the order they came up
const clients = new Set();
const listeners = new Set();

function getState() {
    return { active: active.slice() };
}

function notify() {
    const state = getState();
    listeners.forEach((listener) => listener(state));
}

function entry(no) {
    return BY_NUMBER.get(no) || null;
}

// Lazy: the apps pull this module in themselves.
function apps() {
    return { system: require('../uia/systemApp'), warnguide: require('../uia/warnguideApp') };
}

// Switches a warning on or off. A high priority warning that comes up also raises its pop-up.
function setWarning(no, isActive) {
    if (!BY_NUMBER.has(no)) {
        return false;
    }
    const wasActive = active.includes(no);
    if (isActive === wasActive) {
        return true;
    }
    active = isActive ? active.concat(no) : active.filter((n) => n !== no);
    logger.info('warnings', '%s %d (%s)', isActive ? 'On' : 'Off', no, entry(no).label);
    const { system, warnguide } = apps();
    clients.forEach((ws) => {
        system.sendWarningCount(ws);
        warnguide.sendWarningStatus(ws);
        if (isActive && entry(no).priority === 'High') {
            warnguide.raiseHighAlert(ws, no);
        }
    });
    notify();
    return true;
}

function clearAll() {
    active.slice().forEach((no) => setWarning(no, false));
}

// A connected GUI gets the warning state now and every change until it disconnects.
function attach(ws) {
    clients.add(ws);
    if (typeof ws.once === 'function') {
        ws.once('close', () => clients.delete(ws));
    }
}

function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// Warnings that are already on when the emulator starts (config/warnings.json).
function loadInitial(numbers = config.active) {
    active = [];
    (Array.isArray(numbers) ? numbers : []).forEach((no) => {
        if (BY_NUMBER.has(no) && !active.includes(no)) {
            active.push(no);
        }
    });
}
loadInitial();

module.exports = {
    catalog: catalog,
    entry: entry,
    getState: getState,
    activeNumbers: () => active.slice(),
    setWarning: setWarning,
    clearAll: clearAll,
    attach: attach,
    onChange: onChange,
    loadInitial: loadInitial,
    reset: () => {
        active = [];
        clients.clear();
        listeners.clear();
    }
};
