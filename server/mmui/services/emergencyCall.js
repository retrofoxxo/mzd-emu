const { EventEmitter } = require('node:events');

// Mobile 911 (emergency call assist): a call to the emergency services through the connected
// phone. It starts in one of two ways: the SOS button (the call is placed at once), or a
// collision (the unit counts down, so that a false alarm can be cancelled, and then places the
// call). The phone must be connected; otherwise the unit says there is no phone.
//
// States: 'idle', 'countdown', 'searching', 'noPhone', 'noConnection', 'connecting',
// 'connected', 'handset'. Events: 'state' ({ state, reason }), 'ended'.
class EmergencyCall extends EventEmitter {
    constructor({
        phone,
        countdownS = 10,
        searchMs = 2000,
        connectMs = 4000,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout
    }) {
        super();
        this.phone = phone;
        this.countdownS = countdownS;
        this.searchMs = searchMs;
        this.connectMs = connectMs;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.state = 'idle';
        this.reason = null; // 'sos' or 'collision'
        this.timer = null;
    }

    isActive() {
        return this.state !== 'idle';
    }

    setTimer(action, ms) {
        this.clearTimer();
        this.timer = this.setTimeoutFn(action, ms);
    }

    clearTimer() {
        if (this.timer) {
            this.clearTimeoutFn(this.timer);
            this.timer = null;
        }
    }

    setState(state) {
        this.state = state;
        this.emit('state', { state: state, reason: this.reason });
    }

    // kind: 'sos' or 'collision'. Returns false while an emergency call is already going on.
    trigger(kind) {
        if (this.isActive()) {
            return false;
        }
        this.reason = kind === 'collision' ? 'collision' : 'sos';
        if (this.reason === 'collision') {
            this.setState('countdown');
            this.setTimer(() => this.search(), this.countdownS * 1000);
        } else {
            this.search();
        }
        return true;
    }

    // Looking for the phone, then connecting through it.
    search() {
        this.setState('searching');
        this.setTimer(() => {
            if (!this.phone.phoneOn()) {
                this.setState('noPhone');
            } else if (this.phone.config.signalStrength === 0) {
                this.setState('noConnection');
            } else {
                this.connecting();
            }
        }, this.searchMs);
    }

    connecting() {
        this.setState('connecting');
        this.setTimer(() => this.setState('connected'), this.connectMs);
    }

    // The user tries again after "no connection".
    retry() {
        if (this.state === 'noConnection' || this.state === 'noPhone') {
            this.search();
        }
    }

    // The call moves to the phone itself and back.
    transferToHandset() {
        if (this.state === 'connecting' || this.state === 'connected') {
            this.setState('handset');
        }
    }

    transferFromHandset() {
        if (this.state === 'handset') {
            this.setState('connected');
        }
    }

    // Hang up, or cancel while it can still be cancelled (the countdown, the search).
    hangup() {
        if (!this.isActive()) {
            return;
        }
        this.clearTimer();
        const wasConnected = ['connecting', 'connected', 'handset'].includes(this.state);
        const reason = this.reason;
        this.state = 'idle';
        this.reason = null;
        this.emit('ended', { reason: reason, placed: wasConnected });
    }
}

module.exports = { EmergencyCall };
