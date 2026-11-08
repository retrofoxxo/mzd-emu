// Route and guidance logic of the navigation screen, free of any browser code so that it can be
// tested in Node. It works on routes in the format of the OSRM HTTP API (route service,
// geometries=geojson, steps=true), which several open routing servers speak.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.MzdNavRoute = factory();
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    var EARTH_RADIUS = 6371008.8;
    var ARRIVAL_DISTANCE = 25; // metres from the end of the route
    var SNAP_WINDOW_BACK = 150; // metres: how far back along the route a fix may snap
    var SNAP_WINDOW_FORWARD = 2000; // ... and forward, so that a route crossing itself stays on track
    var SNAP_WINDOW_OK = 80; // a snap inside the window farther away than this is searched again

    function rad(degrees) {
        return (degrees * Math.PI) / 180;
    }

    function deg(radians) {
        return (radians * 180) / Math.PI;
    }

    // Metres between two [lon, lat] points.
    function distance(a, b) {
        var dLat = rad(b[1] - a[1]);
        var dLon = rad(b[0] - a[0]);
        var h =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    // Compass bearing in degrees (0 = north, clockwise) from a to b, both [lon, lat].
    function bearing(a, b) {
        var y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
        var x =
            Math.cos(rad(a[1])) * Math.sin(rad(b[1])) -
            Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
        return (deg(Math.atan2(y, x)) + 360) % 360;
    }

    // ------------------------------------------------------------------ the route

    // An OSRM route response as { distance, duration, coords, cum, steps }:
    // coords are [lon, lat] points, cum[i] the metres along the route at coords[i], and every step
    // knows where along the route its manoeuvre lies (startAlong).
    function parseRoute(response) {
        var route = response && response.routes && response.routes[0];
        if (!route || !route.geometry || !Array.isArray(route.geometry.coordinates)) {
            return null;
        }
        var coords = route.geometry.coordinates;
        if (coords.length < 2) {
            return null;
        }
        var cum = [0];
        for (var i = 1; i < coords.length; i++) {
            cum.push(cum[i - 1] + distance(coords[i - 1], coords[i]));
        }
        var steps = [];
        var along = 0;
        var legs = route.legs || [];
        legs.forEach(function (leg) {
            (leg.steps || []).forEach(function (step) {
                var maneuver = step.maneuver || {};
                steps.push({
                    type: maneuver.type || 'turn',
                    modifier: maneuver.modifier || '',
                    exit: maneuver.exit || 0,
                    bearingAfter: maneuver.bearing_after,
                    location: maneuver.location,
                    name: step.name || '',
                    distance: step.distance || 0,
                    duration: step.duration || 0,
                    startAlong: along
                });
                along += step.distance || 0;
            });
        });
        if (steps.length === 0) {
            return null;
        }
        return {
            distance: cum[cum.length - 1],
            duration: route.duration || 0,
            coords: coords,
            cum: cum,
            steps: steps
        };
    }

    // ------------------------------------------------------------------ position on the route

    // Where a position lies on the route: { along (metres), offset (metres from the route) }.
    // `hintAlong` is the last known position along the route; it keeps a route that crosses
    // itself from jumping to the wrong part.
    function snap(route, lon, lat, hintAlong) {
        var best = searchRange(route, lon, lat, hintAlong - SNAP_WINDOW_BACK, hintAlong + SNAP_WINDOW_FORWARD);
        if (!best || best.offset > SNAP_WINDOW_OK) {
            var whole = searchRange(route, lon, lat, -Infinity, Infinity);
            if (whole && (!best || whole.offset < best.offset)) {
                best = whole;
            }
        }
        return best;
    }

    function searchRange(route, lon, lat, fromAlong, toAlong) {
        var cosLat = Math.cos(rad(lat));
        var best = null;
        for (var i = 0; i < route.coords.length - 1; i++) {
            if (route.cum[i + 1] < fromAlong || route.cum[i] > toAlong) {
                continue;
            }
            var a = route.coords[i];
            var b = route.coords[i + 1];
            // local flat metres around the position
            var ax = rad(a[0] - lon) * cosLat * EARTH_RADIUS;
            var ay = rad(a[1] - lat) * EARTH_RADIUS;
            var bx = rad(b[0] - lon) * cosLat * EARTH_RADIUS;
            var by = rad(b[1] - lat) * EARTH_RADIUS;
            var dx = bx - ax;
            var dy = by - ay;
            var lengthSquared = dx * dx + dy * dy;
            var t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
            var px = ax + t * dx;
            var py = ay + t * dy;
            var offset = Math.sqrt(px * px + py * py);
            if (!best || offset < best.offset) {
                best = {
                    offset: offset,
                    along: route.cum[i] + t * (route.cum[i + 1] - route.cum[i]),
                    segment: i
                };
            }
        }
        return best;
    }

    // The point at `along` metres: { lon, lat, heading }.
    function pointAt(route, along) {
        var clamped = Math.max(0, Math.min(route.distance, along));
        var i = 0;
        while (i < route.cum.length - 2 && route.cum[i + 1] < clamped) {
            i++;
        }
        var span = route.cum[i + 1] - route.cum[i];
        var t = span === 0 ? 0 : (clamped - route.cum[i]) / span;
        var a = route.coords[i];
        var b = route.coords[i + 1];
        return {
            lon: a[0] + t * (b[0] - a[0]),
            lat: a[1] + t * (b[1] - a[1]),
            heading: bearing(a, b)
        };
    }

    // ------------------------------------------------------------------ guidance

    // What the guidance panel shows at `along` metres: the next manoeuvre and what is left.
    function guidanceAt(route, along) {
        var steps = route.steps;
        var index = 0;
        for (var i = 0; i < steps.length; i++) {
            if (steps[i].startAlong <= along + 0.001) {
                index = i;
            }
        }
        var remaining = Math.max(0, route.distance - along);
        var arrived = index >= steps.length - 1 || remaining <= ARRIVAL_DISTANCE;
        var upcoming = arrived ? steps[steps.length - 1] : steps[index + 1];
        var current = steps[index];
        var left = 0;
        if (current.distance > 0) {
            left = current.duration * Math.max(0, 1 - (along - current.startAlong) / current.distance);
        }
        for (var j = index + 1; j < steps.length; j++) {
            left += steps[j].duration;
        }
        return {
            arrived: arrived,
            stepIndex: index,
            maneuver: upcoming,
            distanceToManeuver: Math.max(0, upcoming.startAlong - along),
            remainingDistance: remaining,
            remainingDuration: left,
            streetName: current.name
        };
    }

    // ------------------------------------------------------------------ texts

    var MODIFIER_WORDS = {
        uturn: 'around (U-turn)',
        'sharp right': 'sharp right',
        right: 'right',
        'slight right': 'slight right',
        straight: 'straight',
        'slight left': 'slight left',
        left: 'left',
        'sharp left': 'sharp left'
    };

    var COMPASS_WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

    function onto(name) {
        return name ? ' onto ' + name : '';
    }

    // The instruction of a manoeuvre, in English.
    function instruction(step) {
        var side = MODIFIER_WORDS[step.modifier] || '';
        switch (step.type) {
            case 'depart': {
                var way = typeof step.bearingAfter === 'number'
                    ? COMPASS_WORDS[Math.round(step.bearingAfter / 45) % 8]
                    : '';
                return 'Head ' + (way || 'out') + (step.name ? ' on ' + step.name : '');
            }
            case 'arrive':
                return step.modifier === 'left' || step.modifier === 'right'
                    ? 'You have arrived, the destination is on your ' + step.modifier
                    : 'You have arrived';
            case 'new name':
                return 'Continue' + onto(step.name);
            case 'merge':
                return 'Merge' + (side && side !== 'straight' ? ' ' + side : '') + onto(step.name);
            case 'on ramp':
                return 'Take the ramp' + (side && side !== 'straight' ? ' on the ' + side : '') + onto(step.name);
            case 'off ramp':
                return 'Take the exit' + (side && side !== 'straight' ? ' on the ' + side : '') + onto(step.name);
            case 'fork':
                return (
                    'Keep ' + (step.modifier.indexOf('left') !== -1 ? 'left' : step.modifier.indexOf('right') !== -1 ? 'right' : 'straight') +
                    ' at the fork' + onto(step.name)
                );
            case 'end of road':
                return 'Turn ' + (side || 'around') + ' at the end of the road' + onto(step.name);
            case 'roundabout':
            case 'rotary':
            case 'roundabout turn':
                return step.exit
                    ? 'At the roundabout take exit ' + step.exit + onto(step.name)
                    : 'Enter the roundabout' + onto(step.name);
            case 'exit roundabout':
            case 'exit rotary':
                return 'Exit the roundabout' + onto(step.name);
            case 'continue':
                return side && side !== 'straight' ? 'Continue ' + side + onto(step.name) : 'Continue straight' + onto(step.name);
            default:
                if (step.modifier === 'straight') {
                    return 'Continue straight' + onto(step.name);
                }
                return 'Turn ' + (side || 'around') + onto(step.name);
        }
    }

    // A distance as the unit setting wants it: { value, unit }.
    function formatDistance(meters, units) {
        if (units === 'Miles') {
            var miles = meters / 1609.344;
            if (miles < 0.2) {
                return { value: String(Math.max(10, Math.round((meters * 3.28084) / 10) * 10)), unit: 'ft' };
            }
            return { value: miles < 10 ? miles.toFixed(1) : String(Math.round(miles)), unit: 'mi' };
        }
        if (meters < 1000) {
            var step = meters < 100 ? 10 : 50;
            return { value: String(Math.max(10, Math.round(meters / step) * step)), unit: 'm' };
        }
        var km = meters / 1000;
        return { value: km < 10 ? km.toFixed(1) : String(Math.round(km)), unit: 'km' };
    }

    function formatDuration(seconds) {
        var minutes = Math.max(1, Math.round(seconds / 60));
        if (minutes < 60) {
            return minutes + ' min';
        }
        var hours = Math.floor(minutes / 60);
        var rest = minutes % 60;
        return hours + ' h ' + (rest < 10 ? '0' : '') + rest + ' min';
    }

    // What the voice says when a manoeuvre is `meters` ahead (0 = now).
    function spokenPrompt(step, meters, units) {
        var text = instruction(step);
        if (step.type === 'arrive' || meters < 40) {
            return text;
        }
        var d = formatDistance(meters, units);
        var spokenUnit = { m: 'meters', km: 'kilometers', ft: 'feet', mi: 'miles' }[d.unit];
        return 'In ' + d.value + ' ' + spokenUnit + ', ' + text.charAt(0).toLowerCase() + text.slice(1);
    }

    return {
        distance: distance,
        bearing: bearing,
        parseRoute: parseRoute,
        snap: snap,
        pointAt: pointAt,
        guidanceAt: guidanceAt,
        instruction: instruction,
        formatDistance: formatDistance,
        formatDuration: formatDuration,
        spokenPrompt: spokenPrompt,
        ARRIVAL_DISTANCE: ARRIVAL_DISTANCE
    };
});
