// The loudspeaker of the emulated head unit is the browser that shows the GUI. This module is
// the seam between the player (usbPlayer.js) and the WebSocket to that browser
// (speakerServer.js): the transport registers itself here once the audio port is open.
const state = { transport: null };

module.exports = {
    // Sends a command to the browser; false when no browser is listening.
    send(command) {
        return state.transport ? state.transport(command) : false;
    },
    attach(transport) {
        state.transport = transport;
    }
};
