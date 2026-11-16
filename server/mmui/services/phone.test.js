const test = require('node:test');
const assert = require('node:assert/strict');
const { PhoneCalls } = require('./phoneCalls');
const { Phonebook, sameNumber } = require('./phonebook');
const dbapi = require('./dbapiService');

function fakeClock() {
    let time = 1_000_000;
    const timers = [];
    return {
        now: () => time,
        setTimeoutFn: (fn, ms) => { const t = { fn, at: time + ms }; timers.push(t); return t; },
        clearTimeoutFn: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
        advance(ms) {
            time += ms;
            timers.filter((t) => t.at <= time).forEach((t) => { timers.splice(timers.indexOf(t), 1); t.fn(); });
        }
    };
}

const CONTACTS = [
    { firstName: 'Ben', lastName: 'Jansen', numbers: [{ category: 'Mobile', number: '+31687654321' }] },
    { firstName: 'Anna', lastName: 'de Vries', numbers: [
        { category: 'Mobile', number: '+31612345678' }, { category: 'Work', number: '+31201234567' }] },
    { firstName: '', lastName: '', numbers: [] }
];

test('numbers match by their last digits, whatever the formatting', () => {
    assert.equal(sameNumber('+31 6 12345678', '0612345678'), true);
    assert.equal(sameNumber('+31612345678', '+31687654321'), false);
    assert.equal(sameNumber('', '123'), false);
});

test('the phone book is sorted by name, numbered from 1, and finds contacts by number', () => {
    const book = new Phonebook(CONTACTS);
    assert.deepEqual(book.all().map((c) => [c.contactId, c.displayName]), [[1, 'Anna de Vries'], [2, 'Ben Jansen']]);
    assert.equal(book.nameOf('0612345678'), 'Anna de Vries');
    assert.equal(book.nameOf('+3100000'), '');
    assert.equal(book.byId(2).displayName, 'Ben Jansen');
});

test('an outgoing call rings, is answered after a while, and ends in the history', () => {
    const clock = fakeClock();
    const calls = new PhoneCalls({ answerMs: 3000, ...clock });
    const seen = [];
    ['dialing', 'active', 'ended'].forEach((name) => calls.on(name, () => seen.push(name)));
    assert.equal(calls.dial(''), false);
    assert.equal(calls.dial('+31 6 111'), true);
    assert.equal(calls.dial('999'), false); // busy
    clock.advance(3000);
    assert.equal(calls.call.phase, 'active');
    clock.advance(65000);
    calls.hangup();
    assert.deepEqual(seen, ['dialing', 'active', 'ended']);
    assert.equal(calls.call, null);
    assert.deepEqual(
        { number: calls.history[0].number, direction: calls.history[0].direction, duration: calls.history[0].duration },
        { number: '+31 6 111', direction: 'dialed', duration: 65 }
    );
    assert.equal(calls.lastDialed(), '+31 6 111');
});

test('an incoming call can be answered, ignored, or missed by itself', () => {
    const clock = fakeClock();
    const calls = new PhoneCalls({ ringMs: 30000, ...clock });
    calls.incoming('123');
    calls.answer();
    assert.equal(calls.call.phase, 'active');
    clock.advance(10000);
    calls.hangup();
    assert.equal(calls.history[0].direction, 'received');
    assert.equal(calls.history[0].duration, 10);

    calls.incoming('456');
    calls.reject();
    assert.equal(calls.history[0].direction, 'missed');

    calls.incoming('789');
    clock.advance(30001);
    assert.equal(calls.call, null);
    assert.equal(calls.history[0].number, '789');
    assert.equal(calls.history[0].direction, 'missed');
});

test('mute and the audio route toggle only during a call', () => {
    const calls = new PhoneCalls(fakeClock());
    calls.toggleMute();
    assert.equal(calls.call, null);
    calls.incoming('1');
    calls.toggleMute(); // still ringing
    assert.equal(calls.call.muted, false);
    calls.answer();
    calls.toggleMute();
    calls.toggleAudio();
    assert.equal(calls.call.muted, true);
    assert.equal(calls.call.audio, 'Handset');
});

test('the history is seeded from the config, newest first', () => {
    const clock = fakeClock();
    const calls = new PhoneCalls(clock);
    calls.seedHistory([
        { number: '1', direction: 'missed', minutesAgo: 100 },
        { number: '2', direction: 'received', minutesAgo: 5, duration: 30 },
        { number: '3', direction: 'bogus' }
    ]);
    assert.deepEqual(calls.history.map((h) => h.number), ['2', '1']);
});

function request(methodName, params) {
    return { msgType: 'method', msgContent: { api: 'pb', methodName, reqId: 9, params } };
}
function fakePhone() {
    const calls = new PhoneCalls(fakeClock());
    calls.seedHistory([
        { number: '+31612345678', direction: 'received', minutesAgo: 5, duration: 20 },
        { number: '+31687654321', direction: 'missed', minutesAgo: 50 },
        { number: '+31000', direction: 'dialed', minutesAgo: 500 }
    ]);
    return { phonebook: new Phonebook(CONTACTS), calls };
}

test('the DB API answers with the request id and opens its databases', () => {
    const reply = dbapi.handleRequest(request('OpenContactsDb', { deviceId: 1 }), fakePhone());
    assert.equal(reply.msgType, 'methodResponse');
    assert.equal(reply.msgContent.reqId, 9);
    assert.equal(reply.msgContent.methodName, 'OpenContactsDb');
    assert.equal(reply.msgContent.params.eCode, 0);
    assert.equal(dbapi.handleRequest({ msgType: 'other' }, fakePhone()), null);
});

test('contacts are paged; a number finds its contact, an unknown one fails', () => {
    const phone = fakePhone();
    const page = dbapi.handleRequest(request('GetContacts', { limit: 1, offset: 1 }), phone).msgContent.params;
    assert.equal(page.totalCount, 2);
    assert.deepEqual(page.contacts.map((c) => c.displayName), ['Ben Jansen']);
    const found = dbapi.handleRequest(request('GetContactByMatchedNumber', { number: '0612345678' }), phone);
    assert.equal(found.msgContent.params.contacts[0].displayName, 'Anna de Vries');
    const none = dbapi.handleRequest(request('GetContactByMatchedNumber', { number: '555' }), phone);
    assert.equal(none.msgContent.params.eCode, 1);
    const details = dbapi.handleRequest(request('GetContactDetails', { contactId: 1 }), phone).msgContent.params;
    assert.equal(details.numbers.length, 2);
});

test('the call history has names, categories and can be filtered', () => {
    const phone = fakePhone();
    const all = dbapi.handleRequest(request('GetCallHistory', { category: 'LastAll', limit: 10, offset: 0 }), phone).msgContent.params;
    assert.deepEqual(all.callHistories.map((c) => [c.displayName, c.category]), [
        ['Anna de Vries', 'Received'], ['Ben Jansen', 'Missed'], ['', 'Dialled']
    ]);
    const missed = dbapi.handleRequest(request('GetCallHistory', { category: 'Missed' }), phone).msgContent.params;
    assert.equal(missed.totalCount, 1);
    assert.ok(all.callHistories[0].timestamp > 0);
});
