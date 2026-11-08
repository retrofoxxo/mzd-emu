const test = require('node:test');
const assert = require('node:assert/strict');
const nav = require('../client/nav-route');

const START = [4.3, 51.44];
const CORNER = [4.3, 51.44 + 500 / 111320];
const END = [CORNER[0] + 300 / (111320 * Math.cos((51.44 * Math.PI) / 180)), CORNER[1]];
const d1 = nav.distance(START, CORNER);
const d2 = nav.distance(CORNER, END);

const response = {
    routes: [
        {
            duration: 100,
            geometry: { coordinates: [START, [4.3, 51.442], CORNER, END] },
            legs: [
                {
                    steps: [
                        { name: 'Main Street', distance: d1, duration: 60,
                          maneuver: { type: 'depart', modifier: 'straight', bearing_after: 0, location: START } },
                        { name: 'Oak Avenue', distance: d2, duration: 40,
                          maneuver: { type: 'turn', modifier: 'right', location: CORNER } },
                        { name: '', distance: 0, duration: 0,
                          maneuver: { type: 'arrive', modifier: 'left', location: END } }
                    ]
                }
            ]
        }
    ]
};

test('parseRoute measures the line and places every manoeuvre along it', () => {
    const route = nav.parseRoute(response);
    assert.ok(Math.abs(route.distance - (d1 + d2)) < 0.5);
    assert.deepEqual(route.steps.map((s) => Math.round(s.startAlong)), [0, Math.round(d1), Math.round(d1 + d2)]);
    assert.equal(nav.parseRoute({ routes: [] }), null);
    assert.equal(nav.parseRoute(null), null);
    assert.equal(nav.parseRoute({ routes: [{ geometry: { coordinates: [START] } }] }), null);
});

test('snap finds the place along the route and how far off it is', () => {
    const route = nav.parseRoute(response);
    const onRoute = nav.snap(route, 4.3, 51.44 + 250 / 111320, 0);
    assert.ok(Math.abs(onRoute.along - 250) < 1);
    assert.ok(onRoute.offset < 1);
    // 50 m east of the first street
    const beside = nav.snap(route, 4.3 + 50 / (111320 * Math.cos((51.44 * Math.PI) / 180)), 51.44 + 100 / 111320, 0);
    assert.ok(Math.abs(beside.offset - 50) < 1);
    assert.ok(Math.abs(beside.along - 100) < 1);
});

test('snap uses the last position so a route crossing itself does not jump', () => {
    // a loop: out along the equator, up, back along the same line
    const loop = nav.parseRoute({
        routes: [{
            duration: 10,
            geometry: { coordinates: [[0, 0], [0.01, 0], [0.01, 0.001], [0, 0.001], [0, 0.0001], [0.01, 0.0001]] },
            legs: [{ steps: [{ name: 'x', distance: 1, duration: 1, maneuver: { type: 'depart' } }] }]
        }]
    });
    const late = nav.snap(loop, 0.005, 0.0001, loop.cum[4]);
    assert.ok(late.along > loop.cum[4], 'stays on the later pass, not the early one');
});

test('guidance names the next manoeuvre, what is left and when the trip ends', () => {
    const route = nav.parseRoute(response);
    let g = nav.guidanceAt(route, 100);
    assert.equal(g.maneuver.type, 'turn');
    assert.ok(Math.abs(g.distanceToManeuver - (d1 - 100)) < 0.5);
    assert.ok(Math.abs(g.remainingDistance - (d1 + d2 - 100)) < 0.5);
    assert.equal(g.streetName, 'Main Street');
    assert.equal(g.arrived, false);
    // after the turn the next manoeuvre is the arrival
    g = nav.guidanceAt(route, d1 + 50);
    assert.equal(g.maneuver.type, 'arrive');
    assert.equal(g.streetName, 'Oak Avenue');
    // remaining time: the rest of the current step plus the later ones
    assert.ok(Math.abs(g.remainingDuration - 40 * (1 - 50 / d2)) < 0.5);
    assert.equal(nav.guidanceAt(route, d1 + d2 - 10).arrived, true);
});

test('instructions read naturally', () => {
    assert.equal(nav.instruction({ type: 'turn', modifier: 'left', name: 'Oak Avenue' }), 'Turn left onto Oak Avenue');
    assert.equal(nav.instruction({ type: 'turn', modifier: 'slight right', name: '' }), 'Turn slight right');
    assert.equal(nav.instruction({ type: 'depart', bearingAfter: 92, name: 'Main Street' }), 'Head east on Main Street');
    assert.equal(nav.instruction({ type: 'arrive', modifier: 'right' }), 'You have arrived, the destination is on your right');
    assert.equal(nav.instruction({ type: 'roundabout', exit: 3, name: 'Ring' }), 'At the roundabout take exit 3 onto Ring');
    assert.equal(nav.instruction({ type: 'fork', modifier: 'slight left', name: '' }), 'Keep left at the fork');
    assert.equal(nav.instruction({ type: 'end of road', modifier: 'left', name: '' }), 'Turn left at the end of the road');
    assert.equal(nav.instruction({ type: 'new name', modifier: 'straight', name: 'A2' }), 'Continue onto A2');
});

test('distances and times follow the unit setting', () => {
    assert.deepEqual(nav.formatDistance(347, 'Kilometers'), { value: '350', unit: 'm' });
    assert.deepEqual(nav.formatDistance(42, 'Kilometers'), { value: '40', unit: 'm' });
    assert.deepEqual(nav.formatDistance(2430, 'Kilometers'), { value: '2.4', unit: 'km' });
    assert.deepEqual(nav.formatDistance(23500, 'Kilometers'), { value: '24', unit: 'km' });
    assert.deepEqual(nav.formatDistance(100, 'Miles'), { value: '330', unit: 'ft' });
    assert.deepEqual(nav.formatDistance(2414, 'Miles'), { value: '1.5', unit: 'mi' });
    assert.equal(nav.formatDuration(20), '1 min');
    assert.equal(nav.formatDuration(2700), '45 min');
    assert.equal(nav.formatDuration(3900), '1 h 05 min');
});

test('spoken prompts say how far, and just the instruction when it is now', () => {
    const turn = { type: 'turn', modifier: 'right', name: 'Oak Avenue' };
    assert.equal(nav.spokenPrompt(turn, 300, 'Kilometers'), 'In 300 meters, turn right onto Oak Avenue');
    assert.equal(nav.spokenPrompt(turn, 20, 'Kilometers'), 'Turn right onto Oak Avenue');
    assert.equal(nav.spokenPrompt({ type: 'arrive' }, 500, 'Kilometers'), 'You have arrived');
});

test('pointAt walks the route for the drive simulation', () => {
    const route = nav.parseRoute(response);
    const start = nav.pointAt(route, 0);
    assert.ok(Math.abs(start.heading - 0) < 1);
    const afterTurn = nav.pointAt(route, d1 + 100);
    assert.ok(Math.abs(afterTurn.heading - 90) < 1);
    const end = nav.pointAt(route, 1e9);
    assert.ok(nav.distance([end.lon, end.lat], END) < 1);
});
