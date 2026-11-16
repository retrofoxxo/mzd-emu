// Emulator-only controls shown next to the 800x480 head unit screen.
//
// Nothing here exists on the car and nothing is injected into the firmware GUI from jci/:
// the panel talks to the emulator server over its own WebSocket (controlPort), and the server
// then behaves like the car's services would (see mmui/temperatureService.js).
(function () {
    'use strict';

    // The head unit screen is a fixed 800x480 block in the corner (ui-wayland.js), so the
    // panel takes the free space on its right.
    var PANEL_LEFT = 830;
    var SEND_THROTTLE_MS = 80;
    var RECONNECT_MS = 2000;

    var socket = null;
    var state = null;
    var sendTimer = null;
    var ui = {};

    function el(tag, css, text) {
        var node = document.createElement(tag);
        if (css) {
            node.style.cssText = css;
        }
        if (text) {
            node.textContent = text;
        }
        return node;
    }

    // Whether to show what lies outside the 800x480 screen (the head unit cuts it off).
    var OUTSIDE_CLASS = 'emulator-show-outside';
    var OUTSIDE_KEY = 'emulator.showOutside';

    function buildOutsideSwitch() {
        var row = el('label', 'display:block;margin-top:14px;font-size:13px;cursor:default;');
        var box = el('input', 'margin:0 6px 0 0;vertical-align:middle;');
        box.type = 'checkbox';
        box.checked = localStorage.getItem(OUTSIDE_KEY) === '1';
        function apply() {
            document.documentElement.classList.toggle(OUTSIDE_CLASS, box.checked);
            localStorage.setItem(OUTSIDE_KEY, box.checked ? '1' : '0');
        }
        box.addEventListener('change', apply);
        apply();
        row.appendChild(box);
        row.appendChild(document.createTextNode('Show what lies outside the screen'));
        row.appendChild(
            el(
                'div',
                'color:#777;font-size:11px;margin:2px 0 0 20px;',
                'Dimmed; the head unit cuts it off.'
            )
        );
        return row;
    }

    // Vehicle warnings: raise one from the car's warning table, clear it again.
    var catalog = [];
    var activeWarnings = [];

    function sendControl(message) {
        if (socket && socket.readyState === 1) {
            socket.send(JSON.stringify(message));
        }
    }

    // A call to the virtual phone.
    function buildPhone() {
        var box = el('div', 'margin-top:16px;border-top:1px solid #ddd;padding-top:10px;');
        box.appendChild(el('div', 'font-weight:bold;', 'Phone'));
        var number = el('input', 'width:100%;margin:6px 0;box-sizing:border-box;font-size:13px;');
        number.value = '+31 6 12345678';
        box.appendChild(number);
        var call = el('button', '', 'Incoming call');
        call.addEventListener('click', function () {
            sendControl({ type: 'incomingCall', number: number.value });
        });
        box.appendChild(call);
        box.appendChild(
            el('div', 'color:#777;font-size:11px;margin-top:4px;', 'Needs Bluetooth switched on.')
        );
        // Emergency call (Mobile 911): the SOS button, and an accident (a collision is detected and
        // the unit counts down before it calls).
        var sos = el('button', 'margin:8px 6px 0 0;color:#b00;font-weight:bold;', 'SOS button');
        sos.addEventListener('click', function () {
            sendControl({ type: 'emergency', kind: 'sos' });
        });
        var crash = el('button', 'margin-top:8px;color:#b00;font-weight:bold;', 'Simulate accident');
        crash.addEventListener('click', function () {
            sendControl({ type: 'emergency', kind: 'collision' });
        });
        box.appendChild(sos);
        box.appendChild(crash);
        return box;
    }

    function buildWarnings() {
        var box = el('div', 'margin-top:16px;border-top:1px solid #ddd;padding-top:10px;');
        box.appendChild(el('div', 'font-weight:bold;', 'Vehicle warnings'));
        ui.warnSelect = el('select', 'width:100%;margin:6px 0;font-size:12px;');
        box.appendChild(ui.warnSelect);
        var raise = el('button', 'margin-right:6px;', 'Raise warning');
        raise.addEventListener('click', function () {
            sendControl({ type: 'setWarning', no: Number(ui.warnSelect.value), active: true });
        });
        var clear = el('button', '', 'Clear all');
        clear.addEventListener('click', function () {
            sendControl({ type: 'clearWarnings' });
        });
        box.appendChild(raise);
        box.appendChild(clear);
        ui.warnActive = el('div', 'margin-top:8px;font-size:12px;');
        box.appendChild(ui.warnActive);
        box.appendChild(
            el(
                'div',
                'color:#777;font-size:11px;margin-top:4px;',
                'High priority warnings also open the pop-up on the head unit.'
            )
        );
        return box;
    }

    function renderCatalog() {
        ui.warnSelect.textContent = '';
        catalog.forEach(function (entry) {
            var option = el(
                'option',
                '',
                (entry.priority === 'High' ? '[High] ' : '') + entry.no + ' ' + entry.label
            );
            option.value = entry.no;
            ui.warnSelect.appendChild(option);
        });
    }

    function renderWarnings() {
        ui.warnActive.textContent = '';
        if (activeWarnings.length === 0) {
            ui.warnActive.appendChild(el('div', 'color:#777;', 'No active warnings'));
        }
        activeWarnings.forEach(function (no) {
            var entry = catalog.filter(function (e) {
                return e.no === no;
            })[0];
            var row = el('div', 'display:flex;justify-content:space-between;margin:2px 0;');
            row.appendChild(el('span', '', no + ' ' + (entry ? entry.label : '')));
            var remove = el('button', 'margin-left:6px;', '×');
            remove.addEventListener('click', function () {
                sendControl({ type: 'setWarning', no: no, active: false });
            });
            row.appendChild(remove);
            ui.warnActive.appendChild(row);
        });
    }

    function buildPanel() {
        var panel = el(
            'div',
            'position:fixed;top:0;left:' +
                PANEL_LEFT +
                'px;width:300px;padding:14px 16px;box-sizing:border-box;' +
                'font:14px/1.4 sans-serif;color:#222;background:#fff;' +
                'border-left:1px solid #ccc;min-height:480px;z-index:2147483647;'
        );
        // ui-polyfills.html keeps the normal arrow cursor on this id.
        panel.id = 'emulator-controls';
        panel.appendChild(el('div', 'font-weight:bold;font-size:16px;', 'Emulator controls'));
        panel.appendChild(
            el('div', 'color:#777;font-size:12px;margin-bottom:14px;', 'Not part of the head unit')
        );

        panel.appendChild(el('div', '', 'Display temperature'));
        ui.value = el('div', 'font-size:28px;font-weight:bold;margin:4px 0;', '-- °C');
        panel.appendChild(ui.value);

        ui.slider = el('input', 'width:100%;margin:0;');
        ui.slider.type = 'range';
        ui.slider.step = '1';
        ui.slider.addEventListener('input', onSlide);
        panel.appendChild(ui.slider);

        // Threshold marks under the slider.
        ui.marks = el('div', 'position:relative;height:30px;font-size:11px;color:#777;');
        panel.appendChild(ui.marks);

        ui.status = el('div', 'margin-top:8px;font-weight:bold;', '');
        panel.appendChild(ui.status);
        ui.note = el('div', 'margin-top:6px;color:#666;font-size:12px;', '');
        panel.appendChild(ui.note);
        panel.appendChild(buildPhone());
        panel.appendChild(buildWarnings());
        panel.appendChild(buildOutsideSwitch());
        ui.link = el('div', 'margin-top:14px;font-size:12px;color:#999;', 'Connecting…');
        panel.appendChild(ui.link);
        // Outside the body: the body clips everything to the 800x480 screen.
        document.documentElement.appendChild(panel);
    }

    function addMark(percent, label, color) {
        var mark = el(
            'div',
            'position:absolute;top:0;left:' +
                percent +
                '%;transform:translateX(-50%);' +
                'text-align:center;color:' +
                color +
                ';white-space:nowrap;'
        );
        mark.appendChild(el('div', 'height:6px;width:1px;background:' + color + ';margin:0 auto;'));
        mark.appendChild(el('div', '', label));
        ui.marks.appendChild(mark);
    }

    function render() {
        if (!state) {
            return;
        }
        var span = state.maxC - state.minC;
        ui.slider.min = state.minC;
        ui.slider.max = state.maxC;
        if (document.activeElement !== ui.slider) {
            ui.slider.value = state.temperatureC;
        }
        ui.value.textContent = state.temperatureC + ' °C';
        if (!ui.marks.firstChild) {
            addMark(0, state.minC, '#777');
            addMark(((state.clearAtC - state.minC) / span) * 100, state.clearAtC, '#c80');
            addMark(((state.warnAtC - state.minC) / span) * 100, state.warnAtC, '#c00');
            addMark(100, state.maxC, '#777');
        }
        ui.status.textContent = state.over ? 'Over-temperature: ON' : 'Over-temperature: off';
        ui.status.style.color = state.over ? '#c00' : '#2a7';
        ui.note.textContent =
            'Warning from ' +
            state.warnAtC +
            ' °C, ends below ' +
            state.clearAtC +
            ' °C. The unit checks the sensor every ' +
            state.pollIntervalMs / 1000 +
            ' s.';
    }

    function onSlide() {
        var value = Number(ui.slider.value);
        ui.value.textContent = value + ' °C';
        if (sendTimer) {
            return;
        }
        sendTimer = setTimeout(function () {
            sendTimer = null;
            if (socket && socket.readyState === 1) {
                socket.send(
                    JSON.stringify({ type: 'setTemperature', value: Number(ui.slider.value) })
                );
            }
        }, SEND_THROTTLE_MS);
    }

    function connect(port) {
        socket = new WebSocket('ws://' + location.hostname + ':' + port);
        socket.onopen = function () {
            ui.link.textContent = 'Connected to the emulator';
        };
        socket.onmessage = function (event) {
            var message = JSON.parse(event.data);
            if (message.type === 'temperature') {
                state = message.state;
                render();
            } else if (message.type === 'warningCatalog') {
                catalog = message.catalog;
                renderCatalog();
                renderWarnings();
            } else if (message.type === 'warnings') {
                activeWarnings = message.active;
                renderWarnings();
            }
        };
        socket.onclose = function () {
            ui.link.textContent = 'Emulator not connected, retrying…';
            setTimeout(function () {
                connect(port);
            }, RECONNECT_MS);
        };
    }

    document.addEventListener('DOMContentLoaded', function () {
        buildPanel();
        // The port is the server's setting, read from the same file the servers use.
        fetch('/emulator/runtime.json')
            .then(function (r) {
                return r.json();
            })
            .then(function (runtime) {
                connect(runtime.controlPort);
            });
    });
})();
