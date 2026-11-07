const protocol = require('../protocol');
const navigationState = require('../state/navigationState');
const vehicleWarnings = require('../services/vehicleWarnings');
const logger = require('../../logger');

// Counterpart of libjciuiawarnguide.so: Warning Guidance. The list of the warnings the vehicle
// reports (Applications > Warning Guidance), the detail screen of one warning, and the pop-up
// for a high priority warning. Which warnings are active comes from services/vehicleWarnings.js.

const UIA_ID = 'warnguide';

// Dialog state (what the shared Global.Yes answers, see commonApp.js).
const dialogs = { highAlertActive: false };
// The screen the high priority pop-up interrupted: OK returns to it.
let interrupted = null;

function sendMsg(ws, msgId, payload) {
    ws.send(
        JSON.stringify({ msgType: 'msg', uiaId: UIA_ID, msgId: msgId, params: { payload: payload } })
    );
    logger.debug('warnguide', 'Sent message msgId=%s', msgId);
}

// The list of active warnings, by warning number.
function sendWarningStatus(ws) {
    const numbers = vehicleWarnings.activeNumbers();
    sendMsg(ws, 'WarningStatus', {
        WarningList: { Warning_count: numbers.length, Warning_Values: numbers }
    });
}

function handleSelectWarnGuide(ws) {
    sendWarningStatus(ws);
    protocol.sendContextChange(ws, UIA_ID, 'WarningList');
}

// A tap on a warning of the list: its detail screen.
function handleSelectWarning(ws, params) {
    const payload = params && params.payload;
    const warning = payload ? vehicleWarnings.entry(payload.WarningID) : null;
    if (!warning) {
        logger.warn('warnguide', 'Unknown warning %s', payload && payload.WarningID);
        return;
    }
    sendMsg(ws, 'SelectedWarning', { WarningID: warning.no });
    protocol.sendContextChange(ws, UIA_ID, 'WarningDetail');
}

// The pop-up for a high priority warning. It is transient (no go-back entry) and is skipped
// while the boot video or the disclaimer is up; the warning stays in the list.
function raiseHighAlert(ws, no) {
    const systemApp = require('./systemApp');
    if (systemApp.dialogs.introAnimationActive || systemApp.dialogs.disclaimerActive) {
        return;
    }
    if (!dialogs.highAlertActive) {
        const current = navigationState.current;
        interrupted = current && current.uiaId ? Object.assign({}, current) : null;
    }
    sendMsg(ws, 'HighAlert', {
        HAWarningList: { Warning_HA_Values: no, Warning_HA_Values_Priority: 1 }
    });
    dialogs.highAlertActive = true;
    protocol.sendContextChange(ws, UIA_ID, 'HighPriorityAlert', undefined, undefined, true);
}

// OK on the pop-up: back to the screen it interrupted (Home when there was none).
function dismissHighAlert(ws) {
    dialogs.highAlertActive = false;
    const previous = interrupted;
    interrupted = null;
    if (previous && !(previous.uiaId === UIA_ID && previous.ctxtId === 'HighPriorityAlert')) {
        protocol.sendContextChange(
            ws,
            previous.uiaId,
            previous.ctxtId,
            previous.params,
            undefined,
            true
        );
    } else {
        navigationState.goBackStack = [];
        protocol.sendContextChange(ws, 'system', 'HomeScreen');
    }
}

const events = {
    SelectWarning: handleSelectWarning,
    // an item of the list that only goes back
    GoBack: (ws, params, uiaId) => require('./commonApp').events['Global.GoBack'](ws, params, uiaId)
};

// Dialogs this application answers for the shared Global.Yes / Global.No, as [flag, handler].
const dialogAnswers = {
    yes: [['highAlertActive', dismissHighAlert]],
    no: []
};

module.exports = {
    dialogs: dialogs,
    dialogAnswers: dialogAnswers,
    events: events,
    sendWarningStatus: sendWarningStatus,
    handleSelectWarnGuide: handleSelectWarnGuide,
    handleSelectWarning: handleSelectWarning,
    raiseHighAlert: raiseHighAlert,
    dismissHighAlert: dismissHighAlert
};
