const settings = require('./settings');
const vehicleEquipment = require('./vehicleEquipment');

// The tabs of Settings: which screen each is, and which one was used last.
const TABS = ['HUD', 'Display', 'Safety', 'Sound', 'Clock', 'Vehicle', 'Devices', 'System'];

// The screen of a tab, or null when this vehicle has no such tab.
function tabScreen(tab) {
    switch (tab) {
        case 'HUD':
            if (vehicleEquipment.VEHICLE_EQUIPMENT.Hud_Installed !== 1) {
                return null;
            }
            return {
                uiaId: 'vehsettings',
                ctxtId:
                    settings.HARDWARE_CONFIG.vehicleType === 'SETTINGS_VehicleModelType_J78A'
                        ? 'HUDTabJ78'
                        : 'HUDTab'
            };
        case 'Display':
            return { uiaId: 'syssettings', ctxtId: 'DisplayTab' };
        case 'Safety':
            return { uiaId: 'vehsettings', ctxtId: 'SafetyTab' };
        case 'Sound':
            return { uiaId: 'audiosettings', ctxtId: 'SoundTab' };
        case 'Clock':
            return { uiaId: 'syssettings', ctxtId: 'ClockTab' };
        case 'Vehicle':
            return { uiaId: 'vehsettings', ctxtId: 'VehicleSettingsTab' };
        case 'Devices':
            return { uiaId: 'syssettings', ctxtId: 'DevicesTab' };
        case 'System':
            return { uiaId: 'syssettings', ctxtId: 'SystemTab' };
        default:
            return null;
    }
}

// Which tab a screen is the main screen of, or null.
function tabOf(uiaId, ctxtId) {
    return (
        TABS.find((tab) => {
            const screen = tabScreen(tab);
            return screen && screen.uiaId === uiaId && screen.ctxtId === ctxtId;
        }) || null
    );
}

// The first tab this vehicle has.
function firstTab() {
    return TABS.find((tab) => tabScreen(tab) !== null);
}

let last = null;

module.exports = {
    TABS: TABS,
    tabScreen: tabScreen,
    tabOf: tabOf,
    firstTab: firstTab,
    // Called for every screen that is shown: remembers the tab it belongs to.
    noteScreen(uiaId, ctxtId) {
        const tab = tabOf(uiaId, ctxtId);
        if (tab) {
            last = tab;
        }
    },
    // The tab used last, if this vehicle still has it; else the first one.
    lastTab() {
        return last && tabScreen(last) ? last : firstTab();
    },
    reset() {
        last = null;
    }
};
