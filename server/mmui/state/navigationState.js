const state = {
    goBackStack: [],
    // The context the GUI shows now (set by protocol.sendContextChange), for the applications
    // that must know where they are when a shared event such as Global.GoBack arrives.
    current: { uiaId: null, ctxtId: null, params: undefined }
};

module.exports = state;
