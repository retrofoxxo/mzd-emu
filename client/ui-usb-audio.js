// The loudspeaker and the backlight of the emulated head unit. The server decides what plays (the
// audio sources, server/mmui/services/) and when the display is lit (services/display.js); this
// script only makes the sound with an audio element, plays the system beeps, dims the page and
// reports what the audio element does. It needs no user interface.
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

    // The touch / key beep. On the car the amplifier generates it, so there is no sample in the
    // firmware: these are tones of about the right character, mixed over the music.
    var beepContext = null;

    function beep(isLong) {
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
            return;
        }
        if (!beepContext) {
            beepContext = new AudioCtx();
        }
        if (beepContext.state === 'suspended') {
            beepContext.resume();
        }
        var now = beepContext.currentTime;
        var length = isLong ? 0.16 : 0.05;
        var oscillator = beepContext.createOscillator();
        var gain = beepContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = isLong ? 1200 : 1800;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.18, now + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
        oscillator.connect(gain);
        gain.connect(beepContext.destination);
        oscillator.start(now);
        oscillator.stop(now + length + 0.02);
    }

    // Settings > Display > Turn display off: the backlight goes out, the picture stays.
    var blackout = null;

    function setBacklight(on) {
        if (!blackout) {
            blackout = document.createElement('div');
            blackout.style.cssText =
                'position:fixed;left:0;top:0;width:800px;height:480px;background:#000;' +
                'z-index:100000;display:none;pointer-events:none;';
            document.body.appendChild(blackout);
        }
        // pointer-events:none: the touch that wakes the display still reaches the off screen
        blackout.style.display = on ? 'none' : 'block';
    }

    function handle(command) {
        switch (command.cmd) {
            case 'beep':
                beep(command.pressType === 'Long');
                break;
            case 'units':
                // read by the navigation screen (ui-navigation-route.js)
                window.MzdUnits = { distance: command.distance };
                break;
            case 'backlight':
                setBacklight(command.on !== false);
                break;
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
