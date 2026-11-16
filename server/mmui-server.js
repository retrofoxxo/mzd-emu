const WebSocketServer = require('ws').Server;

const logger = require('./logger');
const startup = require('./mmui/services/startup');
const temperatureService = require('./mmui/services/temperatureService');
const { createControlServer } = require('./mmui/controlPanel');
const handleMmuiEvent = require('./mmui/dispatcher');
const usbmsService = require('./mmui/services/usbmsService');
const dbapiService = require('./mmui/services/dbapiService');
const vehicleWarnings = require('./mmui/services/vehicleWarnings');
const phoneApp = require('./mmui/uia/phoneApp');
const mobile911App = require('./mmui/uia/mobile911App');
const { createSpeakerServer } = require('./mmui/services/speakerServer');

const runtime = require('./config/runtime.json');

const PORTS = {
    guiifm: runtime.guiifmPort,
    appsdk: runtime.appsdkPort,
    dbapi: runtime.dbapiPort,
    control: runtime.controlPort,
    audio: runtime.audioPort
};

function parseMessage(message, scope) {
    try {
        return JSON.parse(message.toString());
    } catch (error) {
        logger.error(scope, 'Invalid JSON message: %s', error.message);
        return null;
    }
}

function attachPassiveEndpoint(server, scope) {
    server.on('connection', (ws) => {
        // These sockets carry nothing the emulator acts on; only note them for debugging.
        logger.debug(scope, 'Client connected');
        ws.on('error', (error) => logger.error(scope, 'WebSocket error: %s', error.message));
        ws.on('close', () => logger.debug(scope, 'Client disconnected'));
        ws.on('message', (message) => {
            const data = parseMessage(message, scope);
            if (data) {
                logger.debug(scope, 'Received message type=%s', data.msgType || 'unknown');
            }
        });
    });
}

function createGuiifmServer() {
    const server = new WebSocketServer({ port: PORTS.guiifm });

    server.on('connection', (ws) => {
        logger.success('gui', 'connected');
        if (runtime.emulatorControls) {
            temperatureService.attach(ws);
        }
        vehicleWarnings.attach(ws);
        phoneApp.attach(ws);
        mobile911App.attach(ws);
        startup.sendCurrentTimeEpoch(ws);

        const clockSyncIntervalId =
            startup.CLOCK_SYNC_INTERVAL_MS > 0
                ? setInterval(
                      () => startup.sendCurrentTimeEpoch(ws),
                      startup.CLOCK_SYNC_INTERVAL_MS
                  )
                : null;

        ws.on('error', (error) => logger.error('guiifm', 'WebSocket error: %s', error.message));
        ws.on('close', () => {
            if (clockSyncIntervalId) {
                clearInterval(clockSyncIntervalId);
            }
            logger.info('gui', 'disconnected');
        });
        ws.on('message', (message) => {
            const data = parseMessage(message, 'guiifm');
            if (!data) {
                return;
            }
            if (typeof data.uiaId !== 'string' || typeof data.eventId !== 'string') {
                logger.warn('guiifm', 'Ignored message without uiaId/eventId');
                return;
            }
            logger.debug('guiifm', 'Received event=%s uiaId=%s', data.eventId, data.uiaId);
            handleMmuiEvent(ws, data.uiaId, data.eventId, data.params);
        });
    });

    return server;
}

// The AppSDK socket answers the USB audio browsing requests (usbms service); the rest of the
// AppSDK is not emulated.
function attachAppsdkEndpoint(server) {
    server.on('connection', (ws) => {
        logger.debug('appsdk', 'Client connected');
        ws.on('error', (error) => logger.error('appsdk', 'WebSocket error: %s', error.message));
        ws.on('close', () => logger.debug('appsdk', 'Client disconnected'));
        ws.on('message', (message) => {
            const data = parseMessage(message, 'appsdk');
            if (!data) {
                return;
            }
            logger.debug('appsdk', 'Request %s.%s', data.serviceName, data.methodName);
            const reply = usbmsService.handleRequest(data);
            if (reply) {
                ws.send(JSON.stringify(reply));
            }
        });
    });
}

// The DB API socket answers the phone book requests (contacts and call history of the virtual
// phone); everything else is not emulated.
function attachDbapiEndpoint(server) {
    server.on('connection', (ws) => {
        logger.debug('dbapi', 'Client connected');
        ws.on('error', (error) => logger.error('dbapi', 'WebSocket error: %s', error.message));
        ws.on('close', () => logger.debug('dbapi', 'Client disconnected'));
        ws.on('message', (message) => {
            const data = parseMessage(message, 'dbapi');
            if (!data) {
                return;
            }
            const reply = dbapiService.handleRequest(data);
            if (reply) {
                logger.debug('dbapi', 'Reply %s', JSON.stringify(reply.msgContent.params).slice(0, 300));
                ws.send(JSON.stringify(reply));
            }
        });
    });
}

// The GUI socket and the emulator controls matter to the user; the other two are never used.
const QUIET_SCOPES = ['appsdk', 'dbapi'];

function listen(server, scope, port) {
    const log = QUIET_SCOPES.includes(scope) ? logger.debug : logger.info;
    server.on('listening', () => log(scope, 'Listening on ws://localhost:%d', port));
    server.on('error', (error) => logger.error(scope, 'Server error: %s', error.message));
}

const servers = [
    { scope: 'guiifm', server: createGuiifmServer(), port: PORTS.guiifm },
    { scope: 'appsdk', server: new WebSocketServer({ port: PORTS.appsdk }), port: PORTS.appsdk },
    { scope: 'dbapi', server: new WebSocketServer({ port: PORTS.dbapi }), port: PORTS.dbapi },
    { scope: 'audio', server: createSpeakerServer(PORTS.audio), port: PORTS.audio }
];

// The emulator's own controls (temperature slider) are off unless runtime.json asks for them.
if (runtime.emulatorControls) {
    servers.push({
        scope: 'control',
        server: createControlServer(PORTS.control),
        port: PORTS.control
    });
}

attachAppsdkEndpoint(servers[1].server);
attachDbapiEndpoint(servers[2].server);
servers.forEach(({ server, scope, port }) => listen(server, scope, port));

function close() {
    return Promise.all(
        servers.map(
            ({ server }) =>
                new Promise((resolve) => {
                    server.close(() => resolve());
                    // ws does not close connected clients itself; without this close() waits
                    // for them forever and the process (and its clock sync timers) stays alive.
                    server.clients.forEach((client) => client.terminate());
                })
        )
    );
}

async function shutdown(signal) {
    logger.info('mmui', 'Stopping after %s', signal);
    await close();
}

process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));

module.exports = {
    PORTS,
    parseMessage,
    close
};
