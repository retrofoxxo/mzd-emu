const test = require('node:test');
const assert = require('node:assert/strict');
const nav = require('../client/ui-navigation');

test('project and unproject are inverse and match known tile numbers', () => {
    const p = nav.project(52.3676, 4.9041, 16);
    const back = nav.unproject(p.x, p.y, 16);
    assert.ok(Math.abs(back.lat - 52.3676) < 1e-6);
    assert.ok(Math.abs(back.lon - 4.9041) < 1e-6);
    // (0, 0) is the middle of the world: the corner of the four middle tiles
    assert.deepEqual(nav.project(0, 0, 1), { x: 256, y: 256 });
    // Amsterdam at zoom 10 lies in tile 525 / 336 (OSM slippy-map numbering)
    const a = nav.project(52.3676, 4.9041, 10);
    assert.equal(Math.floor(a.x / 256), 525);
    assert.equal(Math.floor(a.y / 256), 336);
});

test('visible tiles cover the view, wrap around the date line and stay in the world', () => {
    const tiles = nav.visibleTiles(52.3676, 4.9041, 16, 800, 480);
    assert.ok(tiles.length >= 12 && tiles.length <= 20);
    const lefts = tiles.map((t) => t.left);
    assert.ok(Math.min(...lefts) <= 0 && Math.max(...lefts) + 256 >= 800);
    const tops = tiles.map((t) => t.top);
    assert.ok(Math.min(...tops) <= 0 && Math.max(...tops) + 256 >= 480);
    const wrapped = nav.visibleTiles(0, 179.99, 3, 800, 480);
    assert.ok(wrapped.every((t) => t.x >= 0 && t.x < 8));
    const pole = nav.visibleTiles(85, 0, 2, 800, 480);
    assert.ok(pole.every((t) => t.y >= 0 && t.y < 4));
});

test('meters per pixel and tile urls', () => {
    assert.ok(Math.abs(nav.metersPerPixel(0, 0) - 156543.03392) < 1e-6);
    assert.ok(nav.metersPerPixel(60, 10) < nav.metersPerPixel(0, 10));
    assert.equal(
        nav.tileUrl('https://t/{z}/{x}/{y}.png', { z: 5, x: 3, y: 9 }),
        'https://t/5/3/9.png'
    );
});
