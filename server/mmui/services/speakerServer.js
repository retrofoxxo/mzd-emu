const WebSocketServer = require('ws').Server;
const logger = require('../../logger');
const speaker = require('./speaker');
const audioFocus = require('./audioFocus');

// WebSocket to the browser that makes the sound (client/ui-usb-audio.js). Commands go to the
// newest connected browser only, so a second tab does not play the same music twice.
function createSpeakerServer(port) {
    const server = new WebSocketServer({ port: port });
    let active = null;

    speaker.attach((command) => {
        if (!active || active.readyState !== 1) {
            return false;
        }
        active.send(JSON.stringify(command));
        return true;
    });

    server.on('connection', (ws) => {
        if (active && active !== ws && active.readyState === 1) {
            active.send(JSON.stringify({ cmd: 'stop' }));
        }
        active = ws;
        logger.debug('audio', 'Browser speaker connected');
        // A reloaded page picks the music up where it was.
        audioFocus.resync();
        ws.on('error', (error) => logger.error('audio', 'WebSocket error: %s', error.message));
        ws.on('close', () => {
            if (active === ws) {
                active = null;
            }
        });
        ws.on('message', (message) => {
            try {
                audioFocus.dispatch(JSON.parse(message.toString()));
            } catch (error) {
                logger.error('audio', 'Invalid message: %s', error.message);
            }
        });
    });
    return server;
}

module.exports = { createSpeakerServer };
