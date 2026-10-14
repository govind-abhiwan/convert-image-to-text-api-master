const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

process.env.PORT = '0';

const { app } = require('../index');
const ocr = require('../service/ocr');

const IMAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'receipt.jpg'));
const DATA_URL = `data:image/jpeg;base64,${IMAGE.toString('base64')}`;

let base;
let server;

test.before(async () => {
    server = app.listen(0);
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
    await ocr.shutdown();
    server.close();
    await once(server, 'close');
});

function post(body, headers = {}) {
    return fetch(`${base}/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

test('rejects a missing file field with 400', async () => {
    const res = await post({ notfile: 'x' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).status, 'error');
});

test('rejects a non-string file with 400', async () => {
    assert.equal((await post({ file: 42 })).status, 400);
});

test('rejects an empty body with 400', async () => {
    assert.equal((await post({})).status, 400);
});

test('rejects malformed base64 with 400', async () => {
    assert.equal((await post({ file: '!!!not-base64!!!' })).status, 400);
});

test('rejects an empty image with 400', async () => {
    assert.equal((await post({ file: 'data:image/png;base64,' })).status, 400);
});

test('rejects a non-JSON content type with 400', async () => {
    assert.equal((await post('file=abc', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 400);
});

test('rejects an invalid language code with 400', async () => {
    assert.equal((await post({ file: DATA_URL, lang: '../../etc' })).status, 400);
});

test('extracts text from a data URL', async () => {
    const res = await post({ file: DATA_URL });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.response.text.length > 0, 'expected non-empty text');
    assert.ok(body.response.confidence >= 0 && body.response.confidence <= 100);
    assert.equal(body.response.language, 'eng');
});

test('extracts the same text from a bare base64 payload', async () => {
    const [a, b] = await Promise.all([post({ file: DATA_URL }), post({ file: IMAGE.toString('base64') })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal((await a.json()).response.text, (await b.json()).response.text);
});

test('reuses the worker across requests', async () => {
    const started = process.hrtime.bigint();
    await post({ file: DATA_URL });
    const warm = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(warm < 5000, `warm request took ${Math.round(warm)}ms`);
});

test('returns JSON 404 for unknown routes', async () => {
    const res = await fetch(`${base}/nope`, { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).message, 'Not found');
});
