const WebSocketServer = require('ws').Server;
const logger = require('../logger');
const temperatureService = require('./services/temperatureService');
const vehicleWarnings = require('./services/vehicleWarnings');
const { getPhone } = require('./services/btPhone');

// WebSocket endpoint for the emulator's own controls (the panel next to the GUI in the browser).
// It is deliberately separate from the guiifm socket: the GUI from jci/ must only see what the
// head unit would send, while these controls only exist in the emulator.
function createControlServer(port) {
    const server = new WebSocketServer({ port: port });

    server.on('connection', (ws) => {
        const send = (state) => ws.send(JSON.stringify({ type: 'temperature', state: state }));
        send(temperatureService.getState());
        const unsubscribe = temperatureService.onChange(send);
        ws.on('close', unsubscribe);

        // The warning catalog once, then the list of active warnings with every change.
        ws.send(
            JSON.stringify({
                type: 'warningCatalog',
                catalog: vehicleWarnings.catalog.map((e) => ({
                    no: e.no,
                    label: e.label,
                    priority: e.priority
                }))
            })
        );
        const sendWarnings = (state) =>
            ws.send(JSON.stringify({ type: 'warnings', active: state.active }));
        sendWarnings(vehicleWarnings.getState());
        ws.on('close', vehicleWarnings.onChange(sendWarnings));
        ws.on('error', (error) => logger.error('control', 'WebSocket error: %s', error.message));
        ws.on('message', (raw) => {
            let data;
            try {
                data = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (data && data.type === 'setTemperature') {
                temperatureService.setTemperature(data.value);
            } else if (data && data.type === 'setWarning') {
                vehicleWarnings.setWarning(Number(data.no), data.active === true);
            } else if (data && data.type === 'clearWarnings') {
                vehicleWarnings.clearAll();
            } else if (data && data.type === 'emergency') {
                // the SOS button, or a collision (an accident)
                const phone = getPhone();
                phone.emergency.trigger(data.kind === 'collision' ? 'collision' : 'sos');
            } else if (data && data.type === 'incomingCall') {
                // a call to the virtual phone (only while it is connected)
                const phone = getPhone();
                if (phone.phoneOn()) {
                    phone.calls.incoming(String(data.number || '').slice(0, 32));
                }
            }
        });
    });

    return server;
}

module.exports = { createControlServer: createControlServer };
