# mzd-emu — Mazda Connect (JCI-IHU) Emulator

This project lets you run the Mazda Connect (JCI-IHU) head unit's UI on your
own computer, in a regular modern browser such as Chrome — no head unit or
special hardware required. It is based on firmware version **74.00.324 EU N**.

<p align="center">
  <img src="docs/home.png" alt="mzd-emu running the Mazda Connect home screen in a browser">
</p>

> [!WARNING]
> This is an emulator, not the real head unit software: not every function
> is implemented, and some behavior may be incomplete or inaccurate compared
> to a real vehicle.

It works by running two small local servers:

- `server/ui-server.js` — serves the original head unit GUI in your browser
  and patches it so it works outside the real hardware.
- `server/mmui-server.js` — stands in for the head unit's internal software,
  answering the GUI's requests (screen navigation, status bar, settings,
  etc.) so the interface behaves like it does in the car.

https://github.com/user-attachments/assets/ef45d208-f471-477d-8029-747deec10643

## Installation

1. Install [Node.js](https://nodejs.org) 20.19 or newer.
2. Clone this repository, or download and extract the ZIP from the
   [latest release](https://github.com/ScorpAL/mzd-emu/releases/latest).
3. Install dependencies from the project root:

    ```bash
    npm install
    ```

4. Add an extracted `jci/` firmware dump to the project root. It is not
   included in the repository.

Expected structure:

```text
mzd-emu/
├── jci/          # firmware dump you add — the only thing not in the repo
├── server/
├── ...
```

## Running

Both servers must be running at the same time. From the project root:

```bash
npm start
```

This runs [`server/launcher/start-all.js`](server/launcher/start-all.js), which starts both
servers together in one terminal and stops both together on Ctrl+C.

After the servers start, the console prints the GUI address and your default
browser opens <http://localhost:8080/jci/gui/index.html> automatically. If it doesn't open, use the printed address.

You can also run them separately (e.g. in two terminals, to see each one's
logs on its own):

```bash
npm run mmui   # WebSocket MMUI/UIA transport
npm run ui     # firmware GUI HTTP server
```

## Controls

The real head unit is operated with a rotary controller you tilt in 4
directions, push, and rotate, plus a separate Back button. The keyboard maps
to that same controller, matching the firmware's own input handling in
`jci/gui/common/js/Multicontroller.js`.

| Key(s)          | Emulates                                                       |
| --------------- | -------------------------------------------------------------- |
| `←` `→` `↑` `↓` | Tilting the rotary knob in that direction                      |
| `Enter`         | Pushing (clicking) the rotary knob                             |
| `N`             | Rotating the knob counter-clockwise                            |
| `M`             | Rotating the knob clockwise                                    |
| `Backspace`     | Pressing the dedicated **Back** button next to the rotary knob |

**Home button:** there is no keyboard shortcut for it — click the on-screen
Home icon in the status bar instead.

## Configuration

The emulator has three separate, independent configuration layers. Each one
covers a different concern, and none of them overlap.

### Runtime ports

[`server/config/runtime.json`](server/config/runtime.json) controls which
local ports the servers listen on. Edit it and restart the servers to
change a port.

| Key          | Default | Used for                                |
| ------------ | ------- | --------------------------------------- |
| `uiPort`     | `8080`  | HTTP server serving the firmware GUI    |
| `guiifmPort` | `2700`  | WebSocket transport — GUI context/focus |
| `appsdkPort` | `2800`  | WebSocket transport — App SDK           |
| `dbapiPort`  | `2766`  | WebSocket transport — DB API            |
| `audioPort`  | `2950`  | WebSocket to the browser that plays the USB music |
| `mapTileUrl` | OpenStreetMap | Tile server of the navigation map (`{z}/{x}/{y}`); empty = no map tiles |
| `mapAttribution` | © OpenStreetMap contributors | Credit drawn on the map |
| `routingUrl` | OSRM demo server | Route service of the navigation screen; empty = no routing |
| `geocodeUrl` | Nominatim | Destination search of the navigation screen; empty = no search |

### USB drive (music)

A directory of your computer plays the role of a USB flash drive plugged into
USB port A. [`server/config/usb.json`](server/config/usb.json) names it:

```json
{ "musicDir": "usb", "deviceName": "USB FLASH DRIVE" }
```

`musicDir` is relative to the project root (or absolute). The environment
variable `MZD_USB_DIR` overrides it, for example
`MZD_USB_DIR=~/Music npm start` (use an absolute path; `~` is expanded by the
shell). If the directory does not exist the USB entry in the Entertainment menu
stays unavailable.

In the GUI choose **Entertainment → USB**. Playback starts with the first file
and Now Playing shows the title, artist, album and cover from the file's tags
(ID3, FLAC and MP4 tags are read; otherwise the file name is shown). **Folder**
in the source menu browses the directory tree. Play/pause, next/previous (hold
to wind), the progress slider, repeat and shuffle work. Music keeps playing when
you leave the USB screens. Supported files: mp3, m4a, aac, wav, flac, ogg, opus
(whatever your browser can decode). The directory is read when the servers
start, so restart them after adding files.

Only the folder view exists. The Playlist, Artist, Album, Song and Genre
entries stay greyed out because the emulated drive reports that metadata
browsing is not possible. The sound is made by the browser tab that shows the
GUI; the browser may need one click on the page before it lets sound play.

### Display off and system sounds

- **Settings → Display → Turn display off** blacks out the screen; **Turn display
  off and show clock** leaves only the clock. A mouse click (or a key) on the dark
  screen brings back the screen you left, and a notification lights the display
  while it is up.
- **System sounds:** the touch and key beeps are played in the browser, over the
  music, when the **Beep** setting (Settings → Sound) is on. It is on by default.
  On the car the amplifier makes these tones and the firmware holds no sample of
  them, so the tones here (a short and a long beep) only approximate them.
  Alert tones of the instrument cluster (turn signals, door chimes) belong to the
  car, not to the head unit, and are not played.

### Vehicle warnings

**Applications → Warning Guidance** shows the warnings the car reports, with the
counter next to it in the Applications menu. The 111 warnings, their priority,
icons and English texts are the firmware's own table. A high priority warning
(for example Engine Coolant Temperature High) also opens the pop-up on whatever
screen is showing; OK returns to that screen.

Choose which warnings are active in one of two ways:

- at start, in [`server/config/warnings.json`](server/config/warnings.json):
  `{ "active": [41, 80] }` (warning numbers, see
  `server/vehicle/warningCatalog.json`);
- while running, with the **Vehicle warnings** section of the emulator controls
  panel (set `emulatorControls` to `true` in `server/config/runtime.json`): pick a
  warning, **Raise warning**, remove it with the × or **Clear all**.

The pop-up is skipped while the boot video or the disclaimer is showing; the
warning is still in the list.

### Bluetooth (virtual phone)

A browser cannot act as a car's Bluetooth hands-free unit: Web Bluetooth only
speaks BLE, not the classic profiles (A2DP audio, HFP calls, PBAP phonebook) a
phone uses with a car. So the emulator provides a **virtual phone** that is
paired with the head unit and connected whenever Bluetooth is switched on in the
settings. [`server/config/bluetooth.json`](server/config/bluetooth.json)
describes it:

```json
{
    "phone": { "name": "Mock Phone", "address": "AA:BB:CC:DD:EE:01",
               "batteryLevel": 4, "signalStrength": 4, "network": "Mock Network" },
    "musicDir": ""
}
```

- **Status:** the phone's name appears in the paired devices list and on the
  Bluetooth entry of the Entertainment menu; the status bar shows its battery
  and signal (0 to 5).
- **Bluetooth audio:** **Entertainment → Bluetooth** plays the phone's music with
  title, artist, album, cover, progress bar, play/pause, next/previous (hold to
  wind), repeat and shuffle. `musicDir` is the phone's music directory; empty
  means the same music as the USB drive (`MZD_BT_MUSIC_DIR` overrides it). With
  Bluetooth switched off the source shows its "disconnected" screen.
- **One speaker:** USB and Bluetooth share it. Starting one pauses the other,
  and the play/next/previous keys act on the source that plays.

Not emulated yet: phone calls, the phone book and call history, text messages,
and the pairing flows (add, disconnect, delete a device). The paired devices list
and the Bluetooth settings screens still work as before.

### Navigation (browser GPS, routing and guidance)

Choosing **Navigation** on the Home screen starts the browser's GPS (the browser
asks for location permission) and opens the map screen, if the vehicle profile
has `navigationSdCard` set to `On`:

- **Map:** OpenStreetMap tiles around you, with a position arrow. Drag to pan,
  scroll to zoom, use the **+**, **-** and **GPS** buttons (GPS follows your
  position again).
- **Destination:** the **Destination** button opens a search box (press Enter or
  **Search**; the geocoder's usage policy forbids search-as-you-type). Pick a
  result and confirm with **Start**. A right click on the map picks that spot.
- **Guidance:** the route is drawn on the map; the next manoeuvre, the distance
  to it, the time and distance left and the arrival time are shown. The position
  is followed with the GPS; a position away from the route for three fixes
  calculates a new route; arriving ends the guidance. Prompts are spoken with the
  browser's speech synthesis (**Voice** switches them off), in the unit of the
  distance setting.
- **Simulate:** drives the route at about 50 km/h without a GPS, as the navigation
  software's own simulator does.
- **Compass:** the firmware's Compass screen is filled with your latitude,
  longitude, altitude and heading (the `SelectCompass` event of the `emnavi`
  application).

Routes come from an OSRM-compatible server and searches from Nominatim; both are
set in [`server/config/runtime.json`](server/config/runtime.json) (`routingUrl`,
`geocodeUrl`; an empty value switches that part off). The defaults are the public
OpenStreetMap-based demo servers, meant for light use: point them at your own
servers (OSRM, or any server with the same route API) for anything heavier.

The browser only gives location to `https` pages and to `localhost`, so open the
emulator as `http://localhost:8080`, not by IP address. The map tiles, routes and
searches need an internet connection.

**What is and is not the original.** On the car the map, search and guidance are
done by the NNG navigation engine, which is in the firmware dump
(`jci/nng/jci-linux_imx6_volans-release`, an ARM binary) with its Mazda skin
(`jci/nng/ux/_skin_jci_mazda.zip`). This emulator does not run it: it needs a
navigation SD card with valid licenses (the maps are not in the dump), and the
skin's images are in NNG's own compressed bitmap format, which is not decoded
here. The navigation screen is therefore a re-creation after the look of the
skin (dark panels, yellow arrows), not the original screens, and the position
arrow is not the Mazda vehicle symbol. The shell around it (status bar, Compass
screen, buttons of the other applications) is the firmware's own.

### Vehicle profile

[`server/config/vehicle.json`](server/config/vehicle.json) describes the
virtual car itself: region, vehicle model, HUD type, and which hardware
features are fitted (navigation SD card, Bose audio, Apple CarPlay, Android
Auto). This is fixed vehicle identity, not something the driver changes from
the UI — edit it to simulate a different market or equipment level, then
restart the servers.

### User settings

Everything the driver can actually change from the GUI (language, units,
door lock behavior, HUD brightness, driving-assist toggles, maintenance
distances, audio levels, etc.) is user settings, not vehicle configuration.

- These are saved automatically to
  [`server/data/user-settings.json`](server/data/user-settings.json)
  whenever you change something in the UI.
- They persist across restarts — closing and restarting the servers, or
  your browser, keeps whatever you last set.
- Delete the file (or edit values in it directly) to reset settings back to
  the emulator's defaults; it will be recreated on the next change.

## Reading the terminal log

Each line is `time LEVEL scope message`. By default (`info`) you see what happens
on the screen, not every message on the wire:

```
19:54:00 INFO  screen        system/Disclaimer
19:54:08 INFO  setting       SetBrightness {"brightnessSetting":5}
19:54:10 OK    settings      saved timeFormat="24h"
19:54:15 INFO  temperature   Display too hot (92 C)
```

- `screen` is a screen change, `setting` a change made in the GUI, `settings`
  the file being saved, `boot` the simulated start-up, `temperature` the
  display temperature service.
- `MZD_LOG_LEVEL=debug npm start` also shows every event received and message
  sent (identical lines are collapsed into "repeated N more times").
  `MZD_LOG_LEVEL=warn` shows only warnings and errors.

## `server/` structure

- `mmui-server.js` is the native MMUI/UIA transport entry point.
- `ui-server.js` serves the GUI and injects polyfills.
- `launcher/` starts both servers and stops them together (`start-all.js`) and
  opens the browser (`open-browser.js`).
- `client/` (next to `server/`) holds the files that run in the browser, not on the server:
  the compatibility shims (`ui-polyfills.html`) and the emulator-only scripts
  that play the boot videos (`ui-wayland.js`) and show the controls panel
  (`ui-controls.js`).
- `mmui/` is the stand-in for the head unit's MMUI process:
    - `uia/` has one handler per application, named after the firmware `uiaId`
      values from `jci/mmui/mmui_config.xml` (`system`, `syssettings`,
      `vehsettings`, `audiosettings`, `btpairing`, `netmgmt`, `sysupdate`,
      `schedmaint`, `ecoenergy`), plus `commonApp.js` for the shared `Global.*`
      events. Each exports an `events` table that `dispatcher.js` looks up.
    - `services/` holds what the firmware does in separate services: settings,
      vehicle configuration, temperature, the cold-start clock.
    - `state/` keeps the navigation (go-back) stack.
- Tests sit next to the code they test (`systemApp.test.js` beside `systemApp.js`);
  shared test helpers are in `testing/`.
- See [`docs/NATIVE_MAP.md`](docs/NATIVE_MAP.md) for which firmware component
  each file stands in for.
- `config/` and `data/` hold the configuration described above.

### How patching works

`jci/` is a read-only firmware dump and is never modified on disk. Instead,
when `ui-server.js` serves `jci/gui/index.html`, it reads the file, inserts
the contents of `client/ui-polyfills.html` right before `</head>`, and serves that
combined HTML in the HTTP response — the original file on disk is untouched.
`client/ui-polyfills.html` does not change any GUI logic; it only adds polyfills
(shims) for old browser APIs the firmware's Presto-era JavaScript relies on,
so that unmodified GUI code can run in a modern browser like Chrome.

`ui-server.js` serves only `jci/` (at `/jci/`) and `client/` (at `/emulator/`); every
other path, including the server code, settings and `.git`, answers 404.

## Checks and formatting

Run all project checks with:

```bash
npm run check
```

This runs Prettier, ESLint, and the Node.js test suite. Individual commands
are also available:

```bash
npm run format
npm run format:check
npm run lint
npm run test
```

Both servers print their logs to the console while running.

## Disclaimer

This is an unofficial, community-developed emulator created for
interoperability, research, and learning purposes. It is not affiliated
with, endorsed by, sponsored by, or in any way associated with Mazda Motor
Corporation, Visteon, or any of their subsidiaries or affiliates. "Mazda",
"Mazda Connect", and any other trademarks mentioned are used only
descriptively, to identify the hardware/software this project is compatible
with — no trademark rights are claimed.

This repository does not contain or distribute any Mazda/JCI-IHU firmware.
Use this project at your own risk; it is provided "as is", without warranty
of any kind, under the [MIT License](LICENSE).
