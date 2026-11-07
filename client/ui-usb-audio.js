// The loudspeaker of the emulated head unit. The server decides what plays (the USB drive
// player, server/mmui/services/usbPlayer.js); this script only makes the sound with an audio
// element and reports what the element does. It needs no user interface.
(function () {
    'use strict';

    var RECONNECT_MS = 2000;
    var audio = new Audio();
    audio.preload = 'auto';
    var socket = null;
    var wantPlaying = false;

    function report(event) {
        if (socket && socket.readyState === 1) {
            socket.send(JSON.stringify(event));
        }
    }

    function play() {
        var promise = audio.play();
        if (promise && promise.catch) {
            promise.catch(function (error) {
                // Autoplay policy: the browser wants a click first. Show the player as paused.
                if (error && error.name === 'NotAllowedError') {
                    wantPlaying = false;
                    report({ evt: 'blocked' });
                }
            });
        }
    }

    function load(command) {
        wantPlaying = command.play !== false;
        var position = Number(command.position) || 0;
        audio.src = command.url;
        // The position can only be set once the file's length is known.
        if (position > 0) {
            audio.addEventListener(
                'loadedmetadata',
                function () {
                    audio.currentTime = position;
                },
                { once: true }
            );
        }
        if (wantPlaying) {
            play();
        }
    }

    function handle(command) {
        switch (command.cmd) {
            case 'load':
                load(command);
                break;
            case 'play':
                wantPlaying = true;
                play();
                break;
            case 'pause':
                wantPlaying = false;
                audio.pause();
                break;
            case 'stop':
                wantPlaying = false;
                audio.pause();
                audio.removeAttribute('src');
                audio.load();
                break;
            case 'seek':
                audio.currentTime = Number(command.position) || 0;
                break;
            default:
                break;
        }
    }

    audio.addEventListener('loadedmetadata', function () {
        report({ evt: 'loaded', duration: audio.duration });
    });
    audio.addEventListener('timeupdate', function () {
        report({ evt: 'time', time: audio.currentTime });
    });
    audio.addEventListener('ended', function () {
        report({ evt: 'ended' });
    });
    audio.addEventListener('error', function () {
        // Without a src the element also raises an error (after "stop"): not a failure.
        if (audio.getAttribute('src')) {
            report({ evt: 'error' });
        }
    });

    function connect(port) {
        socket = new WebSocket('ws://' + window.location.hostname + ':' + port);
        socket.onmessage = function (message) {
            try {
                handle(JSON.parse(message.data));
            } catch (error) {
                console.error('usb audio:', error);
            }
        };
        socket.onclose = function () {
            setTimeout(function () {
                connect(port);
            }, RECONNECT_MS);
        };
    }

    fetch('/emulator/runtime.json')
        .then(function (r) {
            return r.json();
        })
        .then(function (runtime) {
            if (runtime.audioPort) {
                connect(runtime.audioPort);
            }
        });
})();
