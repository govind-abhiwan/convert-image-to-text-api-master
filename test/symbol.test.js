const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { classifyPng, SymbolError } = require('../service/symbol');

function canvas(w, h, rgba = [0, 0, 0, 0]) {
    const png = new PNG({ width: w, height: h });
    for (let i = 0; i < png.width * png.height; i++) {
        png.data[i * 4] = rgba[0];
        png.data[i * 4 + 1] = rgba[1];
        png.data[i * 4 + 2] = rgba[2];
        png.data[i * 4 + 3] = rgba[3];
    }
    return png;
}

function stroke(png, pts, thickness = 8, color = [20, 20, 20, 255]) {
    for (let i = 0; i < pts.length - 1; i++) {
        line(png, pts[i], pts[i + 1], thickness, color);
    }
    return png;
}

function line(png, [x0, y0], [x1, y1], thickness, color) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 3);
    const r = thickness / 2;
    for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const cx = x0 + (x1 - x0) * t;
        const cy = y0 + (y1 - y0) * t;
        for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
            for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
                if (dx * dx + dy * dy > r * r) continue;
                const x = Math.round(cx + dx);
                const y = Math.round(cy + dy);
                if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
                const i = (y * png.width + x) * 4;
                png.data[i] = color[0];
                png.data[i + 1] = color[1];
                png.data[i + 2] = color[2];
                png.data[i + 3] = color[3];
            }
        }
    }
}

function circlePoints(cx, cy, r, from = 0, to = Math.PI * 2, wobble = 0) {
    const pts = [];
    const steps = 220;
    for (let i = 0; i <= steps; i++) {
        const a = from + ((to - from) * i) / steps;
        const rr = r + Math.sin(a * 3.3) * wobble;
        pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    return pts;
}

const letterO = (opts = {}) =>
    stroke(
        canvas(opts.w ?? 300, opts.h ?? 300, opts.bg),
        circlePoints(opts.cx ?? 150, opts.cy ?? 150, opts.r ?? 100, 0, Math.PI * 2, opts.wobble ?? 0),
        opts.thickness ?? 12,
        opts.color
    );

const letterX = (opts = {}) =>
    stroke(canvas(opts.w ?? 300, opts.h ?? 300), [
        [opts.x0 ?? 50, opts.y0 ?? 50],
        [opts.x1 ?? 250, opts.y1 ?? 250],
    ], opts.thickness ?? 12)
        && stroke(
            canvas(opts.w ?? 300, opts.h ?? 300),
            [
                [opts.x0 ?? 250, opts.y0 ?? 50],
                [opts.x1 ?? 50, opts.y1 ?? 250],
            ],
            opts.thickness ?? 12
        );

function bufferOf(png) {
    return PNG.sync.write(png);
}

test('classifies a clean O as 0', () => {
    const r = classifyPng(bufferOf(letterO()));
    assert.equal(r.label, 'O');
    assert.equal(r.result, 0);
});

test('classifies a clean X as 1', () => {
    const r = classifyPng(bufferOf(letterX()));
    assert.equal(r.label, 'X');
    assert.equal(r.result, 1);
});

test('handles a small drawing in a large canvas', () => {
    const small = letterO({ r: 30, thickness: 6 });
    const r = classifyPng(bufferOf(small));
    assert.equal(r.result, 0);
});

test('handles a thick O', () => {
    assert.equal(classifyPng(bufferOf(letterO({ thickness: 34 }))).result, 0);
});

test('handles a thin O', () => {
    assert.equal(classifyPng(bufferOf(letterO({ thickness: 4 }))).result, 0);
});

test('handles a wobbly hand-drawn O', () => {
    assert.equal(classifyPng(bufferOf(letterO({ wobble: 9 }))).result, 0);
});

test('handles an off-centre O', () => {
    assert.equal(classifyPng(bufferOf(letterO({ cx: 90, cy: 180 }))).result, 0);
});

test('handles an O with a gap in the loop', () => {
    const o = stroke(canvas(300, 300), circlePoints(150, 150, 100, 0.35, Math.PI * 2 - 0.35), 12);
    assert.equal(classifyPng(bufferOf(o)).result, 0);
});

test('handles a thick X', () => {
    assert.equal(classifyPng(bufferOf(letterX({ thickness: 34 }))).result, 1);
});

test('handles a small X that does not span the canvas', () => {
    const x = stroke(canvas(300, 300), [
        [120, 120],
        [180, 180],
    ], 10);
    stroke(x, [
        [180, 120],
        [120, 180],
    ], 10);
    assert.equal(classifyPng(bufferOf(x)).result, 1);
});

test('handles an off-centre X', () => {
    const x = stroke(canvas(300, 300), [
        [60, 200],
        [160, 90],
    ], 11);
    stroke(x, [
        [160, 200],
        [60, 90],
    ], 11);
    assert.equal(classifyPng(bufferOf(x)).result, 1);
});

test('handles a hairline X', () => {
    assert.equal(classifyPng(bufferOf(letterX({ thickness: 3 }))).result, 1);
});

test('handles a hairline O', () => {
    assert.equal(classifyPng(bufferOf(letterO({ thickness: 3 }))).result, 0);
});

test('works on an opaque white canvas with black ink', () => {
    const o = letterO({ bg: [255, 255, 255, 255], color: [0, 0, 0, 255] });
    assert.equal(classifyPng(bufferOf(o)).result, 0);
});

test('works on an opaque dark canvas with light chalk', () => {
    const x = letterX({ bg: [30, 30, 30, 255], color: [240, 240, 240, 255] });
    assert.equal(classifyPng(bufferOf(x)).result, 1);
});

test('reports confidence and features', () => {
    const r = classifyPng(bufferOf(letterO()));
    assert.ok(r.confidence > 50 && r.confidence <= 100);
    assert.equal(typeof r.needsRetry, 'boolean');
    assert.ok(r.features.holes > 0);
});

test('rejects a blank canvas', () => {
    assert.throws(() => classifyPng(bufferOf(canvas(200, 200))), (e) => e instanceof SymbolError && e.status === 422);
});

test('rejects non-PNG bytes', () => {
    assert.throws(
        () => classifyPng(Buffer.from('this is not an image')),
        (e) => e instanceof SymbolError && e.status === 415
    );
});

const { app } = require('../index');
const { once } = require('node:events');

let base;
let server;

test.after(async () => {
    if (!server) return;
    server.close();
    await once(server, 'close');
});

test.before(async () => {
    server = app.listen(0);
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api`;
});

test('accepts raw PNG bytes the way Unity sends them', async () => {
    const res = await fetch(`${base}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: bufferOf(letterX()),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.response.result, 1);
    assert.equal(body.response.label, 'X');
});

test('accepts octet-stream PNG bytes', async () => {
    const res = await fetch(`${base}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bufferOf(letterO()),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).response.result, 0);
});

test('accepts a base64 JSON body', async () => {
    const res = await fetch(`${base}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: `data:image/png;base64,${bufferOf(letterO()).toString('base64')}` }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).response.result, 0);
});

test('returns 400 when no image is sent', async () => {
    const res = await fetch(`${base}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).status, 'error');
});

test('returns 422 for an empty canvas', async () => {
    const res = await fetch(`${base}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: bufferOf(canvas(200, 200)),
    });
    assert.equal(res.status, 422);
});
