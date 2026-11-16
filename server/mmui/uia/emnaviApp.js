const protocol = require('../protocol');
const navigationState = require('../state/navigationState');
const settings = require('../services/settings');
const logger = require('../../logger');

// Counterpart of libjciuiaemnavi.so (uiaid 3): the shell around the navigation system. On the
// car the map is drawn by a separate native process (NNG) on its own video layers; this
// application only shows the compass screen and the notices around it. Here the position
// comes from the browser's GPS (client/ui-gps.js sends a "GpsFix" event about once a second),
// and the GUI shows it as the firmware does: latitude, longitude, altitude and the compass.
// The map itself is drawn by client/ui-map.js on the NNG_NAVI_MAP1 layer.

const UIA_ID = 'emnavi';
const METERS_TO_FEET = 3.28084;
// Below this speed (m/s) a GPS heading is noise, so the needle is hidden.
const MIN_HEADING_SPEED = 1;

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// The last fix the browser reported: { valid, latitude, longitude, altitude, heading (degrees
// or null), speed (m/s or null) }. Kept so that the compass screen is filled when it opens.
let lastFix = { valid: false };

function sendMsg(ws, msgId, payload) {
    ws.send(
        JSON.stringify({
            msgType: 'msg',
            uiaId: UIA_ID,
            msgId: msgId,
            params: { payload: payload }
        })
    );
    logger.debug('emnavi', 'Sent message msgId=%s', msgId);
}

// Degrees (0 = north, clockwise) to the eight points the compass control knows.
function compassPoint(degrees) {
    const normalized = ((degrees % 360) + 360) % 360;
    return COMPASS_POINTS[Math.round(normalized / 45) % 8];
}

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

// The GUI's CurrentLocationInfo message for a fix.
function locationInfo(fix) {
    if (!fix.valid) {
        return { isValidInfo: 0, showNeedle: false, heading: 'Invalid' };
    }
    const metric = settings.currentSettings.distanceUnit === 'Kilometers';
    const altitude = finite(fix.altitude) ? fix.altitude : 0;
    const moving = finite(fix.speed) && fix.speed >= MIN_HEADING_SPEED;
    const hasHeading = finite(fix.heading) && moving;
    return {
        isValidInfo: 1,
        showNeedle: hasHeading,
        heading: finite(fix.heading) ? compassPoint(fix.heading) : 'Invalid',
        latitude: fix.latitude,
        longitude: fix.longitude,
        // The GUI labels "KM" as meters and anything else as feet.
        altitudeUnit: metric ? 'KM' : 'FT',
        altitude: Math.round(metric ? altitude : altitude * METERS_TO_FEET)
    };
}

function sendLocation(ws) {
    sendMsg(ws, 'CurrentLocationInfo', locationInfo(lastFix));
}

// A fix from the browser. Only forwarded while the navigation screens are showing; the latest
// one is sent when they open.
function handleGpsFix(ws, params) {
    const payload = params && params.payload;
    if (!payload) {
        return;
    }
    const valid =
        payload.valid !== false &&
        finite(payload.latitude) &&
        finite(payload.longitude) &&
        Math.abs(payload.latitude) <= 90 &&
        Math.abs(payload.longitude) <= 180;
    lastFix = valid
        ? {
              valid: true,
              latitude: payload.latitude,
              longitude: payload.longitude,
              altitude: finite(payload.altitude) ? payload.altitude : null,
              heading: finite(payload.heading) ? payload.heading : null,
              speed: finite(payload.speed) ? payload.speed : null
          }
        : { valid: false };
    if (navigationState.current.uiaId === UIA_ID) {
        sendLocation(ws);
    }
}

// Home > Navigation: the map screen (the map layer itself is the browser's).
function handleSelectNavigation(ws) {
    sendLocation(ws);
    protocol.sendContextChange(ws, UIA_ID, 'Active', { payload: { ScreenType: 'Full' } });
}

function handleSelectCompass(ws) {
    sendLocation(ws);
    protocol.sendContextChange(ws, UIA_ID, 'Compass');
}

// Back from the Compass screen returns to the map. Returns false when the Compass is not on
// screen, so that the shared handler (commonApp.js) takes over: emnavi screens are not on the
// go-back stack.
function handleBack(ws) {
    const current = navigationState.current;
    if (!current || current.uiaId !== UIA_ID || current.ctxtId !== 'Compass') {
        return false;
    }
    protocol.sendContextChange(ws, UIA_ID, 'Active', { payload: { ScreenType: 'Full' } });
    return true;
}

const events = {
    SelectCompass: handleSelectCompass,
    GpsFix: handleGpsFix,
    // sent by the GUI when the map layer takes too long to appear; nothing to recover here
    preparingStucked: () => {}
};

// Home > Navigation reaches handleSelectNavigation through systemApp.js, which owns that event.
module.exports = {
    events: events,
    handleSelectNavigation: handleSelectNavigation,
    handleBack: handleBack,
    locationInfo: locationInfo,
    compassPoint: compassPoint,
    resetFix: () => {
        lastFix = { valid: false };
    }
};
