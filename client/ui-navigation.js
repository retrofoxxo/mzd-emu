// Browser stand-ins for the two native parts of the navigation system.
//
//  * The GPS receiver: the browser's Geolocation API. Fixes go to the server as "GpsFix"
//    events (server/mmui/uia/emnaviApp.js), which answers with the CurrentLocationInfo message
//    the Compass screen shows.
//  * The map layer: on the car the NNG navigation software draws the map on its own video
//    layer (NNG_NAVI_MAP1) beneath the GUI, and the GUI's map screen is transparent. Here a
//    canvas beneath the GUI shows the OpenStreetMap tiles around the current position.
//
// The GPS only starts when Navigation is chosen on the Home screen (the browser asks for
// permission then). There is no route planning: the map shows where you are.
(function (root) {
    'use strict';

    var TILE_SIZE = 256;
    var MIN_ZOOM = 3;
    var MAX_ZOOM = 19;
    var DEFAULT_ZOOM = 16;
    var WIDTH = 800;
    var HEIGHT = 480;
    var MAP_SURFACE = 'NNG_NAVI_MAP1';
    var SEND_INTERVAL_MS = 1000;
    var TILE_CACHE_LIMIT = 256;

    // ---------------------------------------------------------------- pure map math

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    // Web Mercator: degrees to pixels of the whole world at `zoom`.
    function project(lat, lon, zoom) {
        var scale = TILE_SIZE * Math.pow(2, zoom);
        var latitude = clamp(lat, -85.0511, 85.0511) * (Math.PI / 180);
        return {
            x: ((lon + 180) / 360) * scale,
            y: ((1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2) * scale
        };
    }

    function unproject(x, y, zoom) {
        var scale = TILE_SIZE * Math.pow(2, zoom);
        var n = Math.PI - (2 * Math.PI * y) / scale;
        return {
            lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
            lon: (x / scale) * 360 - 180
        };
    }

    // The tiles that cover a width x height view centred on (lat, lon):
    // [{ x, y, z, left, top }], with x wrapped around the world and left/top in view pixels.
    function visibleTiles(lat, lon, zoom, width, height) {
        var center = project(lat, lon, zoom);
        var originX = center.x - width / 2;
        var originY = center.y - height / 2;
        var tilesPerSide = Math.pow(2, zoom);
        var tiles = [];
        var firstX = Math.floor(originX / TILE_SIZE);
        var lastX = Math.floor((originX + width) / TILE_SIZE);
        var firstY = Math.floor(originY / TILE_SIZE);
        var lastY = Math.floor((originY + height) / TILE_SIZE);
        for (var ty = firstY; ty <= lastY; ty++) {
            if (ty < 0 || ty >= tilesPerSide) {
                continue;
            }
            for (var tx = firstX; tx <= lastX; tx++) {
                tiles.push({
                    x: ((tx % tilesPerSide) + tilesPerSide) % tilesPerSide,
                    y: ty,
                    z: zoom,
                    left: Math.round(tx * TILE_SIZE - originX),
                    top: Math.round(ty * TILE_SIZE - originY)
                });
            }
        }
        return tiles;
    }

    // Metres one pixel stands for at this latitude and zoom.
    function metersPerPixel(lat, zoom) {
        return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
    }

    function tileUrl(template, tile) {
        return template
            .replace('{z}', tile.z)
            .replace('{x}', tile.x)
            .replace('{y}', tile.y);
    }

    var api = {
        project: project,
        unproject: unproject,
        visibleTiles: visibleTiles,
        metersPerPixel: metersPerPixel,
        tileUrl: tileUrl
    };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        return;
    }

    // ---------------------------------------------------------------- state

    var runtime = { mapTileUrl: '', mapAttribution: '', routingUrl: '', geocodeUrl: '' };
    var view = {
        fix: null, // { latitude, longitude, heading, speed, accuracy } or null
        hasCenter: false, // a position was known once, so the map around it can be drawn
        status: 'Waiting for GPS...', // shown while there is no fix
        zoom: DEFAULT_ZOOM,
        center: { lat: 0, lon: 0 },
        follow: true,
        visible: false
    };
    // Hooks for the route layer (ui-navigation-route.js), which draws on this map.
    var layers = { route: [], hud: [] };
    var fixListeners = [];
    var visibleListeners = [];
    var pointerHandlers = [];
    var contextHandlers = [];
    var tiles = {}; // url -> { img, loaded }
    var tileOrder = [];
    var canvas = null;
    var ctx = null;
    var dirty = false;

    // ---------------------------------------------------------------- GPS

    var watchId = null;
    var lastSent = 0;
    var pending = null;
    var sendTimer = null;

    function sendFix(fix) {
        var fw = root.framework;
        if (fw && fw.sendEventToMmui) {
            fw.sendEventToMmui('emnavi', 'GpsFix', { payload: fix });
        }
    }

    // At most one fix per second reaches the server; the newest one wins.
    function queueFix(fix) {
        pending = fix;
        var wait = SEND_INTERVAL_MS - (Date.now() - lastSent);
        if (wait <= 0) {
            flush();
        } else if (!sendTimer) {
            sendTimer = setTimeout(flush, wait);
        }
    }

    function flush() {
        sendTimer = null;
        if (pending) {
            lastSent = Date.now();
            sendFix(pending);
            pending = null;
        }
    }

    function onPosition(position) {
        if (view.simulating) {
            return; // a simulated drive replaces the real position
        }
        var c = position.coords;
        var fix = {
            valid: true,
            latitude: c.latitude,
            longitude: c.longitude,
            altitude: typeof c.altitude === 'number' ? c.altitude : null,
            heading: typeof c.heading === 'number' && !isNaN(c.heading) ? c.heading : null,
            speed: typeof c.speed === 'number' && !isNaN(c.speed) ? c.speed : null,
            accuracy: typeof c.accuracy === 'number' ? c.accuracy : null
        };
        handleFix(fix);
    }

    // A position, from the GPS or from the drive simulation.
    function handleFix(fix) {
        view.fix = fix;
        if (view.follow || !view.hasCenter) {
            view.hasCenter = true;
            view.center = { lat: fix.latitude, lon: fix.longitude };
        }
        queueFix(fix);
        fixListeners.forEach(function (listener) {
            listener(fix);
        });
        markDirty();
    }

    function onPositionError(error) {
        if (view.simulating) {
            return;
        }
        view.fix = null;
        view.status =
            error && error.code === 1
                ? 'Location access was denied. Allow it in the browser, then reopen Navigation.'
                : 'No GPS position available.';
        queueFix({ valid: false });
        markDirty();
        console.warn('[ui-navigation] geolocation: ' + (error && error.message));
    }

    function startGps() {
        if (watchId !== null) {
            return;
        }
        if (!root.navigator || !root.navigator.geolocation) {
            onPositionError({ code: 2, message: 'Geolocation is not available' });
            return;
        }
        // Geolocation only works on https pages and on localhost.
        watchId = root.navigator.geolocation.watchPosition(onPosition, onPositionError, {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 20000
        });
    }

    // ---------------------------------------------------------------- map drawing

    function markDirty() {
        if (dirty || !view.visible) {
            return;
        }
        dirty = true;
        root.requestAnimationFrame(draw);
    }

    function getTile(url) {
        var entry = tiles[url];
        if (entry) {
            return entry;
        }
        entry = { img: new root.Image(), loaded: false };
        entry.img.onload = function () {
            entry.loaded = true;
            markDirty();
        };
        entry.img.onerror = function () {
            entry.failed = true;
        };
        entry.img.src = url;
        tiles[url] = entry;
        tileOrder.push(url);
        if (tileOrder.length > TILE_CACHE_LIMIT) {
            delete tiles[tileOrder.shift()];
        }
        return entry;
    }

    function drawText(text, x, y, align) {
        ctx.font = '14px sans-serif';
        ctx.textAlign = align;
        ctx.textBaseline = 'alphabetic';
        var width = ctx.measureText(text).width;
        var left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(left - 4, y - 14, width + 8, 20);
        ctx.fillStyle = '#222';
        ctx.fillText(text, x, y);
    }

    function drawVehicle(fix) {
        var point = project(fix.latitude, fix.longitude, view.zoom);
        var origin = project(view.center.lat, view.center.lon, view.zoom);
        var x = point.x - origin.x + WIDTH / 2;
        var y = point.y - origin.y + HEIGHT / 2;
        var radius = fix.accuracy ? fix.accuracy / metersPerPixel(fix.latitude, view.zoom) : 0;
        if (radius > 14) {
            ctx.beginPath();
            ctx.arc(x, y, Math.min(radius, 400), 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(255,210,0,0.14)';
            ctx.fill();
        }
        // The position arrow (not the Mazda vehicle symbol: the skin's images are in a format
        // this emulator cannot read): the skin's yellow with a dark outline. It points the way
        // the car moves, and north while there is no heading.
        var moving = typeof fix.speed === 'number' && fix.speed >= 1 && typeof fix.heading === 'number';
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(moving ? (fix.heading * Math.PI) / 180 : 0);
        ctx.beginPath();
        ctx.moveTo(0, -20);
        ctx.lineTo(14, 16);
        ctx.lineTo(0, 8);
        ctx.lineTo(-14, 16);
        ctx.closePath();
        ctx.fillStyle = moving ? '#ffd200' : 'rgba(255,210,0,0.75)';
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.fill();
        ctx.restore();
    }

    function draw() {
        dirty = false;
        if (!view.visible || !ctx) {
            return;
        }
        ctx.fillStyle = '#e8e4dc';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        if (view.hasCenter) {
            visibleTiles(view.center.lat, view.center.lon, view.zoom, WIDTH, HEIGHT).forEach(
                function (tile) {
                    if (!runtime.mapTileUrl) {
                        return;
                    }
                    var entry = getTile(tileUrl(runtime.mapTileUrl, tile));
                    if (entry.loaded) {
                        ctx.drawImage(entry.img, tile.left, tile.top, TILE_SIZE, TILE_SIZE);
                    }
                }
            );
        }
        layers.route.forEach(function (layer) {
            layer(ctx);
        });
        if (view.fix) {
            drawVehicle(view.fix);
        } else {
            drawText(view.status, WIDTH / 2, HEIGHT / 2, 'center');
        }
        layers.hud.forEach(function (layer) {
            layer(ctx);
        });
        if (runtime.mapAttribution) {
            drawText(runtime.mapAttribution, WIDTH - 6, HEIGHT - 6, 'right');
        }
        if (!view.follow && layers.hud.length === 0) {
            drawText('Double-click to follow your position', 6, HEIGHT - 6, 'left');
        }
    }

    // ---------------------------------------------------------------- layer and input

    function createCanvas() {
        canvas = root.document.createElement('canvas');
        canvas.width = WIDTH;
        canvas.height = HEIGHT;
        canvas.dataset.surface = MAP_SURFACE;
        // Beneath the GUI: its map screen is transparent, everything else stays on top.
        canvas.style.cssText =
            'position:fixed;left:0;top:0;width:' + WIDTH + 'px;height:' + HEIGHT +
            'px;display:none;z-index:-1;pointer-events:none;';
        root.document.body.appendChild(canvas);
        ctx = canvas.getContext('2d');
    }

    function setVisible(visible) {
        if (!canvas || view.visible === visible) {
            return;
        }
        view.visible = visible;
        canvas.style.display = visible ? 'block' : 'none';
        visibleListeners.forEach(function (listener) {
            listener(visible);
        });
        if (visible) {
            markDirty();
        }
    }

    // The GUI's map screen covers the canvas, so the mouse is read on the page. Only events on
    // the transparent map screen (or on the bare page) count.
    function onMapArea(event) {
        var target = event.target;
        return (
            view.visible &&
            (target === root.document.body ||
                target === root.document.documentElement ||
                (target.closest && target.closest('.EmNaviTmplt')))
        );
    }

    function installInput() {
        var dragging = null;
        root.document.addEventListener('mousedown', function (event) {
            if (!onMapArea(event)) {
                return;
            }
            // buttons of the route layer come first; the rest of the map is dragged
            for (var i = 0; i < pointerHandlers.length; i++) {
                if (pointerHandlers[i](event.clientX, event.clientY)) {
                    dragging = null;
                    return;
                }
            }
            dragging = { x: event.clientX, y: event.clientY };
        });
        root.document.addEventListener('contextmenu', function (event) {
            if (!onMapArea(event)) {
                return;
            }
            event.preventDefault();
            contextHandlers.forEach(function (handler) {
                handler(event.clientX, event.clientY);
            });
        });
        root.document.addEventListener('mousemove', function (event) {
            if (!dragging) {
                return;
            }
            var dx = event.clientX - dragging.x;
            var dy = event.clientY - dragging.y;
            dragging = { x: event.clientX, y: event.clientY };
            if (dx === 0 && dy === 0) {
                return;
            }
            var origin = project(view.center.lat, view.center.lon, view.zoom);
            var moved = unproject(origin.x - dx, origin.y - dy, view.zoom);
            view.center = { lat: clamp(moved.lat, -85, 85), lon: moved.lon };
            view.follow = false;
            markDirty();
        });
        root.document.addEventListener('mouseup', function () {
            dragging = null;
        });
        root.document.addEventListener('wheel', function (event) {
            if (!onMapArea(event)) {
                return;
            }
            view.zoom = clamp(view.zoom + (event.deltaY < 0 ? 1 : -1), MIN_ZOOM, MAX_ZOOM);
            markDirty();
        });
        root.document.addEventListener('dblclick', function (event) {
            if (onMapArea(event) && view.fix) {
                view.follow = true;
                view.center = { lat: view.fix.latitude, lon: view.fix.longitude };
                markDirty();
            }
        });
    }

    // ---------------------------------------------------------------- hooks into the GUI

    // The GUI lists the layers it needs on every screen change (Utility.setRequiredSurfaces).
    function hookSurfaces() {
        if (!root.Utility || !root.Utility.prototype.setRequiredSurfaces) {
            return false;
        }
        var original = root.Utility.prototype.setRequiredSurfaces;
        root.Utility.prototype.setRequiredSurfaces = function (surfaces) {
            setVisible(Array.isArray(surfaces) && surfaces.indexOf(MAP_SURFACE) !== -1);
            return original.apply(this, arguments);
        };
        return true;
    }

    // Choosing Navigation on the Home screen starts the GPS (and the browser's permission prompt).
    function hookNavigationEvent() {
        var fw = root.framework;
        if (!fw || !fw.sendEventToMmui) {
            return false;
        }
        var original = fw.sendEventToMmui;
        fw.sendEventToMmui = function (uiaId, eventId) {
            if (uiaId === 'system' && eventId === 'SelectNavigation') {
                startGps();
            }
            return original.apply(this, arguments);
        };
        return true;
    }

    function whenReady(action) {
        var tries = 0;
        (function attempt() {
            if (action() || ++tries > 150) {
                return;
            }
            setTimeout(attempt, 200);
        })();
    }

    // What the route layer builds on (ui-navigation-route.js).
    root.MzdNavMap = {
        WIDTH: WIDTH,
        HEIGHT: HEIGHT,
        view: view,
        runtime: runtime,
        layers: layers,
        markDirty: markDirty,
        handleFix: handleFix,
        onFix: function (listener) { fixListeners.push(listener); },
        onVisible: function (listener) { visibleListeners.push(listener); },
        onPointer: function (handler) { pointerHandlers.push(handler); },
        onContext: function (handler) { contextHandlers.push(handler); },
        startGps: startGps,
        toScreen: function (lat, lon) {
            var point = project(lat, lon, view.zoom);
            var origin = project(view.center.lat, view.center.lon, view.zoom);
            return { x: point.x - origin.x + WIDTH / 2, y: point.y - origin.y + HEIGHT / 2 };
        },
        toLatLon: function (x, y) {
            var origin = project(view.center.lat, view.center.lon, view.zoom);
            return unproject(origin.x + x - WIDTH / 2, origin.y + y - HEIGHT / 2, view.zoom);
        },
        setCenter: function (lat, lon) {
            view.center = { lat: lat, lon: lon };
            view.hasCenter = true;
            markDirty();
        },
        setZoom: function (zoom) {
            view.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
            markDirty();
        }
    };

    root.document.addEventListener('DOMContentLoaded', function () {
        createCanvas();
        installInput();
        whenReady(hookSurfaces);
        whenReady(hookNavigationEvent);
        root.fetch('/emulator/runtime.json')
            .then(function (r) {
                return r.json();
            })
            .then(function (config) {
                runtime.mapTileUrl = config.mapTileUrl || '';
                runtime.mapAttribution = config.mapAttribution || '';
                runtime.routingUrl = config.routingUrl || '';
                runtime.geocodeUrl = config.geocodeUrl || '';
                markDirty();
            })
            .catch(function () {});
    });
})(typeof window !== 'undefined' ? window : globalThis);
