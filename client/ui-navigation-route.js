// Destination search, route and guidance on the navigation map (see ui-navigation.js).
//
//  * Destinations: a search box (Nominatim, an open geocoder), or a right click on the map.
//  * Route: an OSRM-style routing server (routingUrl in server/config/runtime.json; the public
//    demo server by default). The route is followed with the GPS: the position is snapped to
//    the route, the next manoeuvre and the distance to it are shown and spoken, and a position
//    away from the route for a few fixes calculates a new route.
//  * "Simulate" drives the route without a GPS, as the navigation software's own simulator does.
//
// The panels are drawn after the look of the Mazda navigation skin (dark panels, yellow
// arrows); the skin's own images are in a format this emulator does not read.
(function (root) {
    'use strict';

    var map = root.MzdNavMap;
    var routeLogic = root.MzdNavRoute;
    if (!map || !routeLogic) {
        return;
    }

    var W = map.WIDTH;
    var H = map.HEIGHT;
    var C = {
        panel: 'rgba(22,22,22,0.93)',
        button: 'rgba(48,48,48,0.94)',
        text: '#ffffff',
        dim: '#b8b8b8',
        accent: '#ffd200',
        route: '#ff8a00',
        routeCase: '#6b3600',
        routeDone: '#a0a0a0'
    };
    var VOICE_STEPS = { Kilometers: [500, 200, 40], Miles: [805, 305, 40] };
    var OFF_ROUTE_FIXES = 3;
    var REROUTE_MIN_MS = 8000;
    var SIM_SPEED = 13.9; // m/s, about 50 km/h
    var STATUS_BAR = 66; // the GUI's status bar covers the top of the map

    var state = {
        route: null,
        destination: null,
        pending: null, // a destination waiting for "Start"
        along: 0,
        offCount: 0,
        lastReroute: 0,
        guidance: null,
        arrived: false,
        busy: false,
        voice: true,
        spoken: {},
        simTimer: null,
        toast: null,
        toastTimer: null
    };

    function units() {
        return (root.MzdUnits && root.MzdUnits.distance) || 'Kilometers';
    }

    // ---------------------------------------------------------------- messages and voice

    function showToast(text, ms) {
        state.toast = text;
        clearTimeout(state.toastTimer);
        state.toastTimer = setTimeout(function () {
            state.toast = null;
            map.markDirty();
        }, ms || 6000);
        map.markDirty();
    }

    function speak(text) {
        if (!state.voice || !root.speechSynthesis || !root.SpeechSynthesisUtterance) {
            return;
        }
        try {
            var utterance = new root.SpeechSynthesisUtterance(text);
            utterance.lang = 'en-US';
            root.speechSynthesis.cancel();
            root.speechSynthesis.speak(utterance);
        } catch (error) {
            console.warn('[ui-navigation-route] speech: ' + error.message);
        }
    }

    // The prompts of the next manoeuvre, once each: far away, nearer, and at the manoeuvre.
    function announce(guidance) {
        var thresholds = VOICE_STEPS[units()] || VOICE_STEPS.Kilometers;
        var stepKey = guidance.stepIndex;
        var stepLength = state.route.steps[Math.min(guidance.stepIndex + 1, state.route.steps.length - 1)].startAlong -
            state.route.steps[guidance.stepIndex].startAlong;
        for (var i = 0; i < thresholds.length; i++) {
            var key = stepKey + ':' + thresholds[i];
            if (state.spoken[key] || guidance.distanceToManeuver > thresholds[i]) {
                continue;
            }
            state.spoken[key] = true;
            // a prompt for a distance longer than the step itself would be a lie: skip it
            if (thresholds[i] > stepLength * 1.2 && i < thresholds.length - 1) {
                continue;
            }
            var isNow = i === thresholds.length - 1;
            speak(routeLogic.spokenPrompt(guidance.maneuver, isNow ? 0 : thresholds[i], units()));
            return;
        }
    }

    // ---------------------------------------------------------------- routing

    function routeUrl(from, to) {
        return (
            map.runtime.routingUrl.replace(/\/+$/, '') +
            '/route/v1/driving/' + from.lon + ',' + from.lat + ';' + to.lon + ',' + to.lat +
            '?overview=full&geometries=geojson&steps=true'
        );
    }

    // Asks the routing server for a route; resolves with the parsed route or rejects with a text.
    function fetchRoute(from, to) {
        if (!map.runtime.routingUrl) {
            return Promise.reject('Routing is switched off (routingUrl is empty).');
        }
        return root
            .fetch(routeUrl(from, to))
            .then(function (response) {
                return response.json();
            })
            .then(function (json) {
                var route = routeLogic.parseRoute(json);
                if (!route) {
                    throw new Error('no route');
                }
                return route;
            })
            .catch(function (error) {
                throw error && error.message === 'no route'
                    ? 'No route found to that destination.'
                    : 'The routing service could not be reached.';
            });
    }

    function startRoute(destination) {
        var fix = map.view.fix;
        if (!fix) {
            showToast('Waiting for a GPS position.');
            return Promise.resolve();
        }
        if (state.busy) {
            return Promise.resolve();
        }
        state.busy = true;
        state.pending = null;
        showToast('Calculating route...', 20000);
        return fetchRoute({ lat: fix.latitude, lon: fix.longitude }, destination)
            .then(function (route) {
                adoptRoute(route, destination);
                showToast('Route calculated.', 3000);
                speak(routeLogic.instruction(route.steps[0]));
            })
            .catch(function (text) {
                showToast(text);
            })
            .then(function () {
                state.busy = false;
                map.markDirty();
            });
    }

    function adoptRoute(route, destination) {
        state.route = route;
        state.destination = destination;
        state.along = 0;
        state.offCount = 0;
        state.arrived = false;
        state.spoken = {};
        state.guidance = routeLogic.guidanceAt(route, 0);
        map.view.follow = true;
        if (map.view.fix) {
            map.setCenter(map.view.fix.latitude, map.view.fix.longitude);
        }
        map.setZoom(16);
    }

    // Away from the route: a new route from where the car is now.
    function reroute(fix) {
        if (state.busy || !state.destination) {
            return;
        }
        state.busy = true;
        state.lastReroute = Date.now();
        showToast('Recalculating route...', 20000);
        speak('Recalculating');
        fetchRoute({ lat: fix.latitude, lon: fix.longitude }, state.destination)
            .then(function (route) {
                var destination = state.destination;
                adoptRoute(route, destination);
                showToast('New route calculated.', 3000);
            })
            .catch(function (text) {
                showToast(text);
            })
            .then(function () {
                state.busy = false;
                map.markDirty();
            });
    }

    function cancelRoute() {
        stopSimulation();
        state.route = null;
        state.destination = null;
        state.pending = null;
        state.guidance = null;
        state.arrived = false;
        if (root.speechSynthesis) {
            root.speechSynthesis.cancel();
        }
        map.markDirty();
    }

    // A position of the car: follow the route.
    function onFix(fix) {
        if (!state.route || state.arrived) {
            return;
        }
        var snapped = routeLogic.snap(state.route, fix.longitude, fix.latitude, state.along);
        if (!snapped) {
            return;
        }
        state.along = snapped.along;
        var limit = Math.max(35, (fix.accuracy || 0) * 1.5);
        state.offCount = snapped.offset > limit ? state.offCount + 1 : 0;
        if (state.offCount >= OFF_ROUTE_FIXES && Date.now() - state.lastReroute > REROUTE_MIN_MS) {
            state.offCount = 0;
            reroute(fix);
            return;
        }
        state.guidance = routeLogic.guidanceAt(state.route, state.along);
        if (state.guidance.arrived) {
            arrive();
        } else {
            announce(state.guidance);
        }
        map.markDirty();
    }

    function arrive() {
        state.arrived = true;
        stopSimulation();
        showToast('You have arrived.', 8000);
        speak('You have arrived');
        // the guidance ends a moment after the arrival
        setTimeout(function () {
            if (state.arrived) {
                cancelRoute();
            }
        }, 8000);
    }

    // ---------------------------------------------------------------- drive simulation

    function startSimulation() {
        if (!state.route || state.simTimer) {
            return;
        }
        map.view.simulating = true;
        state.simTimer = setInterval(function () {
            var along = Math.min(state.route.distance, state.along + SIM_SPEED);
            var point = routeLogic.pointAt(state.route, along);
            map.handleFix({
                valid: true,
                latitude: point.lat,
                longitude: point.lon,
                altitude: null,
                heading: point.heading,
                speed: SIM_SPEED,
                accuracy: 5
            });
        }, 1000);
        map.markDirty();
    }

    function stopSimulation() {
        if (state.simTimer) {
            clearInterval(state.simTimer);
            state.simTimer = null;
        }
        map.view.simulating = false;
        map.markDirty();
    }

    // ---------------------------------------------------------------- drawing helpers

    function roundedRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function fitText(ctx, text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) {
            return text;
        }
        var cut = text;
        while (cut.length > 1 && ctx.measureText(cut + '...').width > maxWidth) {
            cut = cut.slice(0, -1);
        }
        return cut + '...';
    }

    function label(ctx, text, x, y, size, color, align, weight) {
        ctx.font = (weight || '') + ' ' + size + 'px sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = align || 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x, y);
    }

    var ANGLES = {
        straight: 0, 'slight right': 45, right: 90, 'sharp right': 135, uturn: 180,
        'sharp left': -135, left: -90, 'slight left': -45
    };

    // The manoeuvre arrow, centred on (cx, cy), `s` pixels high.
    function drawManeuver(ctx, cx, cy, s, step) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.strokeStyle = C.accent;
        ctx.fillStyle = C.accent;
        ctx.lineWidth = s * 0.13;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (step.type === 'arrive') {
            ctx.beginPath();
            ctx.arc(0, -s * 0.1, s * 0.22, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, -s * 0.1, s * 0.07, 0, 2 * Math.PI);
            ctx.fill();
        } else if (step.modifier === 'uturn') {
            ctx.beginPath();
            ctx.moveTo(s * 0.18, s * 0.4);
            ctx.lineTo(s * 0.18, -s * 0.1);
            ctx.arc(0, -s * 0.1, s * 0.18, 0, Math.PI, true);
            ctx.lineTo(-s * 0.18, s * 0.15);
            ctx.stroke();
            head(ctx, -s * 0.18, s * 0.28, 180, s);
        } else {
            var angle = ANGLES[step.modifier] || 0;
            ctx.beginPath();
            ctx.moveTo(0, s * 0.42);
            ctx.lineTo(0, 0);
            ctx.stroke();
            ctx.rotate((angle * Math.PI) / 180);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, -s * 0.28);
            ctx.stroke();
            head(ctx, 0, -s * 0.42, 0, s);
        }
        if (/roundabout|rotary/.test(step.type) && step.exit) {
            ctx.rotate(0);
        }
        ctx.restore();
    }

    function head(ctx, x, y, rotationDeg, s) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate((rotationDeg * Math.PI) / 180);
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.16);
        ctx.lineTo(-s * 0.2, s * 0.1);
        ctx.lineTo(s * 0.2, s * 0.1);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    // ---------------------------------------------------------------- buttons

    var buttons = [];

    function addButton(id, rect, text, isVisible, action) {
        buttons.push({ id: id, rect: rect, text: text, isVisible: isVisible, action: action });
    }

    function hasRoute() {
        return Boolean(state.route);
    }

    function searchOpen() {
        return searchBox && searchBox.style.display !== 'none';
    }

    addButton('search', { x: W - 152, y: STATUS_BAR + 6, w: 144, h: 46 }, 'Destination',
        function () { return !hasRoute() && !state.pending && !searchOpen(); }, openSearch);
    addButton('zoomIn', { x: W - 60, y: 170, w: 52, h: 52 }, '+', function () { return !searchOpen(); },
        function () { map.setZoom(map.view.zoom + 1); });
    addButton('zoomOut', { x: W - 60, y: 228, w: 52, h: 52 }, '-', function () { return !searchOpen(); },
        function () { map.setZoom(map.view.zoom - 1); });
    addButton('follow', { x: W - 60, y: 286, w: 52, h: 52 }, 'GPS',
        function () { return !map.view.follow && Boolean(map.view.fix) && !searchOpen(); },
        function () {
            map.view.follow = true;
            map.setCenter(map.view.fix.latitude, map.view.fix.longitude);
        });
    addButton('simulate', { x: W - 296, y: H - 70, w: 138, h: 46 }, 'Simulate',
        function () { return hasRoute() && !state.simTimer && !state.arrived; }, startSimulation);
    addButton('stopSim', { x: W - 296, y: H - 70, w: 138, h: 46 }, 'Stop sim',
        function () { return hasRoute() && Boolean(state.simTimer); }, stopSimulation);
    addButton('cancel', { x: W - 150, y: H - 70, w: 138, h: 46 }, 'Cancel',
        hasRoute, cancelRoute);
    addButton('voice', { x: 8, y: H - 70, w: 120, h: 46 }, 'Voice', hasRoute,
        function () {
            state.voice = !state.voice;
            if (!state.voice && root.speechSynthesis) {
                root.speechSynthesis.cancel();
            }
        });
    addButton('start', { x: W / 2 - 150, y: H - 76, w: 140, h: 46 }, 'Start',
        function () { return Boolean(state.pending); },
        function () { startRoute(state.pending); });
    addButton('pendingCancel', { x: W / 2 + 10, y: H - 76, w: 140, h: 46 }, 'Cancel',
        function () { return Boolean(state.pending); },
        function () { state.pending = null; });

    function drawButton(ctx, button) {
        var r = button.rect;
        roundedRect(ctx, r.x, r.y, r.w, r.h, 8);
        ctx.fillStyle = C.button;
        ctx.fill();
        ctx.strokeStyle = '#6a6a6a';
        ctx.lineWidth = 1;
        ctx.stroke();
        var text = button.text;
        var color = C.text;
        if (button.id === 'voice') {
            text = state.voice ? 'Voice on' : 'Voice off';
            color = state.voice ? C.accent : C.dim;
        }
        label(ctx, text, r.x + r.w / 2, r.y + r.h / 2, r.h > 50 ? (text.length > 1 ? 16 : 28) : 19, color, 'center');
    }

    // ---------------------------------------------------------------- map layers

    function drawRoute(ctx) {
        var route = state.route;
        if (!route) {
            return;
        }
        var points = route.coords.map(function (c) {
            return map.toScreen(c[1], c[0]);
        });
        function stroke(from, to, color, width) {
            ctx.beginPath();
            for (var i = from; i <= to; i++) {
                if (i === from) {
                    ctx.moveTo(points[i].x, points[i].y);
                } else {
                    ctx.lineTo(points[i].x, points[i].y);
                }
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();
        }
        // the part already driven is grey
        var passed = 0;
        while (passed < route.cum.length - 1 && route.cum[passed + 1] < state.along) {
            passed++;
        }
        stroke(passed, points.length - 1, C.routeCase, 11);
        stroke(passed, points.length - 1, C.route, 7);
        if (passed > 0) {
            stroke(0, passed, C.routeDone, 7);
        }
        var end = points[points.length - 1];
        ctx.beginPath();
        ctx.arc(end.x, end.y, 11, 0, 2 * Math.PI);
        ctx.fillStyle = '#d02020';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(end.x, end.y, 4, 0, 2 * Math.PI);
        ctx.fillStyle = '#fff';
        ctx.fill();
    }

    function drawPending(ctx) {
        if (!state.pending) {
            return;
        }
        var spot = map.toScreen(state.pending.lat, state.pending.lon);
        ctx.beginPath();
        ctx.arc(spot.x, spot.y, 9, 0, 2 * Math.PI);
        ctx.fillStyle = '#d02020';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.stroke();
        roundedRect(ctx, 8, H - 142, W - 16, 120, 10);
        ctx.fillStyle = C.panel;
        ctx.fill();
        label(ctx, 'Navigate to', 24, H - 122, 16, C.dim, 'left');
        ctx.font = '22px sans-serif';
        label(ctx, fitText(ctx, state.pending.name, W - 56), 24, H - 96, 22, C.text, 'left');
    }

    function drawGuidance(ctx) {
        var guidance = state.guidance;
        if (!state.route || !guidance) {
            return;
        }
        // next manoeuvre
        roundedRect(ctx, 8, STATUS_BAR + 6, W - 180, 88, 10);
        ctx.fillStyle = C.panel;
        ctx.fill();
        drawManeuver(ctx, 56, STATUS_BAR + 50, 64, guidance.maneuver);
        var d = routeLogic.formatDistance(guidance.distanceToManeuver, units());
        label(ctx, d.value, 108, STATUS_BAR + 30, 38, C.text, 'left', 'bold');
        var valueWidth = ctx.measureText(d.value).width;
        label(ctx, d.unit, 108 + valueWidth + 8, STATUS_BAR + 34, 22, C.dim, 'left');
        ctx.font = '19px sans-serif';
        label(ctx, fitText(ctx, routeLogic.instruction(guidance.maneuver), W - 310), 108, STATUS_BAR + 70, 19, C.text, 'left');
        // trip
        roundedRect(ctx, 8, H - 76, W - 16, 56, 10);
        ctx.fillStyle = C.panel;
        ctx.fill();
        // drawn over the bar: the buttons paint their own background
        var remaining = routeLogic.formatDistance(guidance.remainingDistance, units());
        var eta = new Date(Date.now() + guidance.remainingDuration * 1000);
        var time = eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        label(ctx, routeLogic.formatDuration(guidance.remainingDuration), 140, H - 54, 20, C.text, 'left', 'bold');
        label(ctx, remaining.value + ' ' + remaining.unit + '  ·  ' + time, 140, H - 32, 15, C.dim, 'left');
    }

    function drawToast(ctx) {
        if (!state.toast) {
            return;
        }
        ctx.font = '18px sans-serif';
        var text = fitText(ctx, state.toast, W - 80);
        var width = ctx.measureText(text).width + 32;
        roundedRect(ctx, (W - width) / 2, STATUS_BAR + 100, width, 38, 8);
        ctx.fillStyle = C.panel;
        ctx.fill();
        label(ctx, text, W / 2, STATUS_BAR + 119, 18, C.accent, 'center');
    }

    function drawButtons(ctx) {
        buttons.forEach(function (button) {
            if (button.isVisible()) {
                drawButton(ctx, button);
            }
        });
    }

    map.layers.route.push(drawRoute, drawPending);
    // trip panels first, then the buttons on top of them
    map.layers.hud.push(drawGuidance, drawButtons, drawToast);

    map.onPointer(function (x, y) {
        for (var i = buttons.length - 1; i >= 0; i--) {
            var button = buttons[i];
            var r = button.rect;
            if (button.isVisible() && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                button.action();
                map.markDirty();
                return true;
            }
        }
        return false;
    });

    // A right click on the map picks a destination there.
    map.onContext(function (x, y) {
        var spot = map.toLatLon(x, y);
        state.pending = { lat: spot.lat, lon: spot.lon, name: 'Selected point on the map' };
        map.markDirty();
    });

    map.onFix(onFix);

    // ---------------------------------------------------------------- destination search

    var searchBox = null;
    var searchInput = null;
    var searchResults = null;

    function element(tag, css, text) {
        var el = root.document.createElement(tag);
        el.style.cssText = css || '';
        if (text) {
            el.textContent = text;
        }
        return el;
    }

    function buildSearch() {
        searchBox = element(
            'div',
            'position:fixed;left:0;top:' + STATUS_BAR + 'px;width:' + W + 'px;height:' + (H - STATUS_BAR) +
            'px;background:#141414;color:#fff;font-family:sans-serif;z-index:100001;display:none;'
        );
        var bar = element('div', 'display:flex;gap:8px;padding:10px;');
        searchInput = element(
            'input',
            'flex:1;font-size:22px;padding:8px 12px;background:#2a2a2a;color:#fff;' +
            'border:1px solid #666;border-radius:8px;outline:none;'
        );
        searchInput.placeholder = 'Address or place';
        var go = element('button', 'font-size:20px;padding:0 18px;border-radius:8px;background:' + C.accent + ';border:0;color:#000;', 'Search');
        var close = element('button', 'font-size:20px;padding:0 18px;border-radius:8px;background:#444;border:0;color:#fff;', 'Close');
        bar.appendChild(searchInput);
        bar.appendChild(go);
        bar.appendChild(close);
        searchResults = element('div', 'overflow-y:auto;height:' + (H - STATUS_BAR - 66) + 'px;');
        searchBox.appendChild(bar);
        searchBox.appendChild(searchResults);
        root.document.body.appendChild(searchBox);

        // the head unit's own key handling must not see what is typed here
        ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'wheel', 'contextmenu'].forEach(function (type) {
            searchBox.addEventListener(type, function (event) {
                event.stopPropagation();
            });
        });
        searchInput.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
                runSearch();
            } else if (event.key === 'Escape') {
                closeSearch();
            }
        });
        go.addEventListener('click', runSearch);
        close.addEventListener('click', closeSearch);
    }

    function openSearch() {
        if (!searchBox) {
            buildSearch();
        }
        searchBox.style.display = 'block';
        searchResults.textContent = '';
        // after the click that opened this: the browser would give the focus to what was clicked
        setTimeout(function () {
            searchInput.focus();
        }, 50);
        map.markDirty();
    }

    function closeSearch() {
        if (searchBox) {
            searchBox.style.display = 'none';
            searchInput.blur();
        }
        map.markDirty();
    }

    function showSearchMessage(text) {
        searchResults.textContent = '';
        searchResults.appendChild(element('div', 'padding:16px;font-size:18px;color:#b8b8b8;', text));
    }

    // One request per press of Enter / Search: the geocoder's usage policy forbids autocomplete.
    function runSearch() {
        var query = searchInput.value.trim();
        if (query.length < 2) {
            return;
        }
        if (!map.runtime.geocodeUrl) {
            showSearchMessage('Search is switched off (geocodeUrl is empty).');
            return;
        }
        showSearchMessage('Searching...');
        var url = map.runtime.geocodeUrl.replace(/\/+$/, '') + '/search?format=jsonv2&limit=8&q=' + encodeURIComponent(query);
        var fix = map.view.fix;
        if (fix) {
            // prefer results near the car, without excluding the others
            url += '&viewbox=' + (fix.longitude - 0.5) + ',' + (fix.latitude + 0.5) + ',' +
                (fix.longitude + 0.5) + ',' + (fix.latitude - 0.5);
        }
        root.fetch(url)
            .then(function (response) {
                return response.json();
            })
            .then(renderResults)
            .catch(function () {
                showSearchMessage('The search service could not be reached.');
            });
    }

    function renderResults(results) {
        searchResults.textContent = '';
        if (!Array.isArray(results) || results.length === 0) {
            showSearchMessage('Nothing found.');
            return;
        }
        results.forEach(function (result) {
            var row = element(
                'div',
                'padding:12px 16px;font-size:19px;border-top:1px solid #2c2c2c;cursor:pointer;',
                result.display_name
            );
            row.addEventListener('mouseenter', function () {
                row.style.background = '#3a2a00';
            });
            row.addEventListener('mouseleave', function () {
                row.style.background = '';
            });
            row.addEventListener('click', function () {
                state.pending = { lat: Number(result.lat), lon: Number(result.lon), name: result.display_name };
                map.setCenter(state.pending.lat, state.pending.lon);
                map.view.follow = false;
                closeSearch();
            });
            searchResults.appendChild(row);
        });
    }

    map.onVisible(function (visible) {
        if (!visible) {
            closeSearch();
        }
    });

    // for tests and debugging in the browser console
    root.MzdNavRouteApi = {
        state: state,
        startRoute: startRoute,
        setPending: function (destination) {
            state.pending = destination;
            map.markDirty();
        },
        startSimulation: startSimulation,
        cancelRoute: cancelRoute,
        onFix: onFix
    };
})(typeof window !== 'undefined' ? window : globalThis);
