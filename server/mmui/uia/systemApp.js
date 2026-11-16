const protocol = require('../protocol');
const sendContextChange = protocol.sendContextChange;
const navigationState = require('../state/navigationState');
const startup = require('../services/startup');
const vehsettingsApp = require('./vehsettingsApp');
const syssettingsApp = require('./syssettingsApp');
const audiosettingsApp = require('./audiosettingsApp');
const btpairingApp = require('./btpairingApp');
const settings = require('../services/settings');
const vehicleEquipment = require('../services/vehicleEquipment');
const settingsTabs = require('../services/settingsTabs');
const schedmaintApp = require('./schedmaintApp');
const ecoenergyApp = require('./ecoenergyApp');
const logger = require('../../logger');
const coldStart = require('../services/coldStart');
const usbaudioApp = require('./usbaudioApp');
const btaudioApp = require('./btaudioApp');
const emnaviApp = require('./emnaviApp');
const warnguideApp = require('./warnguideApp');
const netmgmtApp = require('./netmgmtApp');
const { getPhone } = require('../services/btPhone');
const phoneApp = require('./phoneApp');
const speaker = require('../services/speaker');
const vehicleWarnings = require('../services/vehicleWarnings');

// Dialog state of this application (what the shared Global.Yes / Global.No answer, see commonApp.js).
const dialogs = {
    disclaimerActive: false,
    introAnimationActive: false
};

function handleGetStartupSettings(ws) {
    startup.sendStartupSettings(ws);
    syssettingsApp.sendDisplayState(ws);
    syssettingsApp.sendClockState(ws);
    syssettingsApp.sendDevicesState(ws);
    audiosettingsApp.sendSoundState(ws);

    vehsettingsApp.sendVehicleFeatureInstalled(ws);
    vehsettingsApp.sendVehicleCapabilityState(ws);
    vehsettingsApp.sendHudType(ws);
    vehsettingsApp.sendNavigationAvailability(ws);
    vehsettingsApp.sendIgnitionOn(ws);
    vehsettingsApp.sendHudState(ws);
    vehsettingsApp.sendDoorLockState(ws);
    vehsettingsApp.sendSpeedAlarmState(ws);
    vehsettingsApp.sendTurnSettingsState(ws);
    vehsettingsApp.sendLightingState(ws);
    vehsettingsApp.sendSafetyState(ws);
    sendApplicationsState(ws);

    btpairingApp.sendPhoneConnectedStatus(ws);

    startIntroAnimation(ws);
}

function cancelColdStart(ws) {
    dialogs.introAnimationActive = false;
    coldStart.cancel(ws);
}

// The GUI's startup request arrives instantly here; the answer waits for the simulated boot.
function scheduleStartupSettings(ws) {
    dialogs.introAnimationActive = false;
    coldStart.waitForBoot(ws, handleGetStartupSettings);
}

// Cold start: the firmware starts the tranlogo video and enters IntroAnimation. When the
// video ends it reports FinishIntroAnimation, the system state becomes NORMAL and the
// native side raises ShowDisclaimer, which lands in the Disclaimer context.
function startIntroAnimation(ws) {
    dialogs.disclaimerActive = false;
    dialogs.introAnimationActive = true;
    sendContextChange(ws, 'system', 'IntroAnimation', undefined, undefined, true);
    coldStart.waitForIntroEnd(ws, showDisclaimer);
}

function showDisclaimer(ws) {
    dialogs.introAnimationActive = false;
    navigationState.goBackStack = [];
    dialogs.disclaimerActive = true;
    // Disclaimer is transient and must not enter the back stack.
    sendContextChange(ws, 'system', 'Disclaimer', undefined, undefined, true);
}

// The GUI asks for the current context; the firmware answers with the one it already holds
// (IntroAnimation on cold start), so nothing new is sent here.
function handleInitGui() {
    navigationState.goBackStack = [];
}

// Home is the navigation root; discard stale stack entries.
function handleIntentHome(ws) {
    cancelColdStart(ws);
    navigationState.goBackStack = [];
    dialogs.disclaimerActive = false;
    sendContextChange(ws, 'system', 'HomeScreen');
}

// Agree and the firmware timeout both return to Home.
function dismissDisclaimer(ws) {
    dialogs.disclaimerActive = false;
    navigationState.goBackStack = [];
    sendContextChange(ws, 'system', 'HomeScreen');
    showPendingSystemWarning(ws);
}

// "Temperature Warning" state per GUI connection (several tabs may be open).
const openSystemWarnings = new WeakSet();
const pendingSystemWarnings = new WeakSet();

// IntentSystemWarningMessage(DisplayExtremeTemp): the firmware opens the SystemWarning context
// from almost anywhere, but keeps the message as pending while the boot video or the Disclaimer
// is up (UIA_SYSTEM_SavePendingWarningMessage) and ignores it while a warning is already open.
function requestSystemWarning(ws) {
    if (openSystemWarnings.has(ws)) {
        return;
    }
    if (dialogs.introAnimationActive || dialogs.disclaimerActive) {
        pendingSystemWarnings.add(ws);
        return;
    }
    pendingSystemWarnings.delete(ws);
    openSystemWarnings.add(ws);
    // Transient dialog: it must not become a back-stack entry.
    sendContextChange(ws, 'system', 'SystemWarning', undefined, undefined, true);
}

function showPendingSystemWarning(ws) {
    if (pendingSystemWarnings.has(ws)) {
        requestSystemWarning(ws);
    }
}

function isSystemWarningOpen(ws) {
    return openSystemWarnings.has(ws);
}

// OK (Global.Yes) on the warning goes to Home. The firmware would return to the Disclaimer if
// the warning had interrupted it, which the emulator avoids by deferring the warning instead.
function dismissSystemWarning(ws) {
    openSystemWarnings.delete(ws);
    navigationState.goBackStack = [];
    sendContextChange(ws, 'system', 'HomeScreen');
}

function handleSelectApplications(ws) {
    sendApplicationsState(ws);
    sendContextChange(ws, 'system', 'Applications');
}

function sendSystemMsg(ws, msgId, payload) {
    const msg = JSON.stringify({
        msgType: 'msg',
        uiaId: 'system',
        msgId: msgId,
        params: { payload: payload }
    });
    ws.send(msg);
    logger.debug('system', 'Sent message msgId=%s', msgId);
}

function sendSyssettingsMsg(ws, msgId, payload) {
    const msg = JSON.stringify({
        msgType: 'msg',
        uiaId: 'syssettings',
        msgId: msgId,
        params: { payload: payload }
    });
    ws.send(msg);
    logger.debug('system', 'Sent syssettings message msgId=%s', msgId);
}

function sendStatusMenuVisible(ws, appName, visible) {
    sendSystemMsg(ws, 'StatusMenuVisible', {
        appName: appName,
        state: visible ? 'Visible' : 'Invisible'
    });
}

function sendStatusMenu(ws, appName, available) {
    sendSystemMsg(ws, 'StatusMenu', {
        statusMenu: {
            appName: appName,
            appStatus: available ? 'Available' : 'Unavailable'
        }
    });
}

function sendApplicationStatus(ws, appName, visible, available) {
    sendStatusMenuVisible(ws, appName, visible);
    sendStatusMenu(ws, appName, available);
}

// The number next to Warning Guidance in the Applications menu.
function sendWarningCount(ws) {
    sendSystemMsg(ws, 'WarningStatusCount', {
        warningcount: vehicleWarnings.activeNumbers().length
    });
}

// The Communication menu: its entries need the phone that is connected over Bluetooth.
function sendCommunicationStatus(ws) {
    const connected = getPhone().phoneOn();
    sendApplicationStatus(ws, 'phone', true, connected);
    sendApplicationStatus(ws, 'contacts', true, connected);
    // text messages are not emulated: the entry stays greyed out
    sendApplicationStatus(ws, 'sms', true, false);
    sendApplicationStatus(ws, 'notifications', true, false);
    sendApplicationStatus(ws, 'favorites', true, false);
    sendApplicationStatus(ws, 'syssettings', true, true);
    // the phone book and call history the GUI may read
    phoneApp.sendConnectStatus(ws);
}

function sendApplicationsState(ws) {
    sendSyssettingsMsg(ws, 'VehicleConfigData', { evData: 'New' });

    sendSystemMsg(ws, 'StatusUpdateEcoEnergy', { fuelType: 'GAS' });
    sendApplicationStatus(ws, 'ecoenergy', true, true);

    sendApplicationStatus(ws, 'warnguide', true, true);
    sendApplicationStatus(ws, 'schedmaint', true, true);
    sendApplicationStatus(ws, 'vsm', false, false);
    sendStatusMenu(ws, 'vehicleStatus', true);

    sendEntertainmentStatus(ws);
    // the Wi-Fi symbol of the status bar
    netmgmtApp.sendWifiStatus(ws);
    sendCommunicationStatus(ws);

    sendApplicationStatus(ws, 'carplay', true, false);
    sendApplicationStatus(ws, 'androidauto', true, false);

    sendApplicationStatus(ws, 'xmdata', false, false);
    sendApplicationStatus(ws, 'hdtrafficimage', false, false);
    sendApplicationStatus(ws, 'idm', false, false);
    sendApplicationStatus(ws, 'driverid', false, false);
    sendApplicationStatus(ws, 'vdt_settings', false, false);
    sendApplicationStatus(ws, 'vdt', false, false);

    sendWarningCount(ws);
    sendSystemMsg(ws, 'StatusUpdateSchedMaint', { due: false });
}

function handleSelectEcoEnergy(ws) {
    ecoenergyApp.handleSelectEcoEnergy(ws);
}

function handleSelectVehicleStatusMonitor(ws) {
    sendApplicationsState(ws);
    sendContextChange(ws, 'system', 'VehicleStatusMonitor');
}

function handleSelectWarnGuide(ws) {
    warnguideApp.handleSelectWarnGuide(ws);
}

function handleSelectSchedMaint(ws) {
    schedmaintApp.handleSelectSchedMaint(ws);
}

// The audio sources of the Entertainment menu: whether USB and Bluetooth are available.
function sendEntertainmentStatus(ws) {
    usbaudioApp.sendMenuStatus(ws);
    btaudioApp.sendMenuStatus(ws);
}

function handleSelectEntertainment(ws) {
    sendEntertainmentStatus(ws);
    sendContextChange(ws, 'system', 'Entertainment');
}

function handleSelectCommunication(ws) {
    sendContextChange(ws, 'system', 'Communication');
}

// The map screen of the navigation system, only when the vehicle has the navigation SD card.
// The GUI asks for a touch / key beep (common.beep). The hardware makes it only when the Beep
// setting (Settings > Sound) is on; the browser plays it over the music, as the amplifier does.
function handlePlayAudioBeep(_ws, params) {
    if (settings.currentSettings.soundBeep !== 'On') {
        return;
    }
    const payload = (params && params.payload) || {};
    speaker.send({ cmd: 'beep', pressType: payload.pressType === 'Long' ? 'Long' : 'Short' });
}

function handleSelectNavigation(ws) {
    if (ws && settings.HARDWARE_CONFIG.navigationSdCard === 'On') {
        emnaviApp.handleSelectNavigation(ws);
    }
}

// The sources whose Settings button (the gear in the player) means the sound settings.
const AUDIO_SOURCES = [
    'usbaudio', 'btaudio', 'fmradio', 'amradio', 'aharadio', 'auxin', 'cd', 'dab', 'satradio',
    'xmaudio', 'pandora', 'stitcher', 'dvd', 'tv'
];

// Shows a tab of Settings. Tabs are siblings; `replace` swaps the current stack entry for the new
// tab instead of adding depth (switching tabs), otherwise the tab is opened on top.
function openSettingsTab(ws, tab) {
    const screen = settingsTabs.tabScreen(tab);
    if (!screen) {
        return;
    }
    if (tab === 'Devices') {
        syssettingsApp.sendDevicesState(ws);
    }
    sendContextChange(ws, screen.uiaId, screen.ctxtId);
}

// Which tab a Settings button opens: the Sound settings from a player, the Devices tab (Bluetooth,
// Wi-Fi) from the Communication menu or the phone screens, and the tab used last from anywhere else.
function settingsTabFor(senderUiaId) {
    const current = navigationState.current;
    if (AUDIO_SOURCES.includes(senderUiaId) || AUDIO_SOURCES.includes(current.uiaId)) {
        return 'Sound';
    }
    if (senderUiaId === 'phone' || (current.uiaId === 'system' && current.ctxtId === 'Communication')) {
        return 'Devices';
    }
    return settingsTabs.lastTab();
}

function handleSelectSettings(ws, senderUiaId) {
    const tab = settingsTabFor(senderUiaId);
    // From a player the settings sit on top of it, so that Back returns to the player.
    const current = navigationState.current;
    if (AUDIO_SOURCES.includes(current.uiaId)) {
        const stack = navigationState.goBackStack;
        const top = stack[stack.length - 1];
        if (!top || top.uiaId !== current.uiaId || top.ctxtId !== current.ctxtId) {
            stack.push({ uiaId: current.uiaId, ctxtId: current.ctxtId, params: current.params, contextSeq: 0 });
        }
    }
    openSettingsTab(ws, tab);
}

// Tabs are siblings, so replace the current stack entry instead of adding depth.
function handleIntentSettingsTab(ws, params) {
    if (navigationState.goBackStack.length > 0) {
        navigationState.goBackStack.pop();
    }
    openSettingsTab(ws, params.payload.settingsTab);
}

// Events of the system application (libjciuiasystem.so), dispatched by eventId.
const events = {
    'Global.GetStartupSettings': (ws) => scheduleStartupSettings(ws),
    'Global.InitGui': (ws) => handleInitGui(ws),
    'Global.IntentHome': (ws) => handleIntentHome(ws),
    'Global.IntentSettingsTab': (ws, params) => handleIntentSettingsTab(ws, params),
    SelectApplications: (ws) => handleSelectApplications(ws),
    SelectEntertainment: (ws) => handleSelectEntertainment(ws),
    SelectCommunication: (ws) => handleSelectCommunication(ws),
    SelectNavigation: (ws) => handleSelectNavigation(ws),
    PlayAudioBeep: (ws, params) => handlePlayAudioBeep(ws, params),
    SelectEcoEnergy: (ws) => handleSelectEcoEnergy(ws),
    SelectVehicleStatusMonitor: (ws) => handleSelectVehicleStatusMonitor(ws),
    SelectWarnGuide: (ws) => handleSelectWarnGuide(ws),
    SelectSchedMaint: (ws) => handleSelectSchedMaint(ws)
};

// Dialogs this application answers for the shared Global.Yes / Global.No, as [flag, handler]
// in the order they are tried.
const dialogAnswers = {
    yes: [['disclaimerActive', dismissDisclaimer]],
    no: []
};

module.exports = {
    dialogs: dialogs,
    dialogAnswers: dialogAnswers,
    events: events,
    handleGetStartupSettings: handleGetStartupSettings,
    handleInitGui: handleInitGui,
    showDisclaimer: showDisclaimer,
    cancelColdStart: cancelColdStart,
    scheduleStartupSettings: scheduleStartupSettings,
    handleIntentHome: handleIntentHome,
    dismissDisclaimer: dismissDisclaimer,
    requestSystemWarning: requestSystemWarning,
    isSystemWarningOpen: isSystemWarningOpen,
    dismissSystemWarning: dismissSystemWarning,
    sendApplicationsState: sendApplicationsState,
    handleSelectApplications: handleSelectApplications,
    handleSelectEcoEnergy: handleSelectEcoEnergy,
    handleSelectVehicleStatusMonitor: handleSelectVehicleStatusMonitor,
    handleSelectWarnGuide: handleSelectWarnGuide,
    handleSelectSchedMaint: handleSelectSchedMaint,
    handleSelectEntertainment: handleSelectEntertainment,
    handleSelectCommunication: handleSelectCommunication,
    handleSelectNavigation: handleSelectNavigation,
    sendEntertainmentStatus: sendEntertainmentStatus,
    sendWarningCount: sendWarningCount,
    sendCommunicationStatus: sendCommunicationStatus,
    handleSelectSettings: handleSelectSettings,
    handleIntentSettingsTab: handleIntentSettingsTab
};
