const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');

const DEFAULT_LANG = process.env.OCR_LANG || 'eng';
const TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 30_000);
const MAX_BYTES = Number(process.env.OCR_MAX_BYTES || 5 * 1024 * 1024);
const CACHE_DIR = process.env.OCR_CACHE_DIR || path.join(__dirname, '..', '.tesseract-cache');

const DATA_URL_RE = /^data:[\w.+-]+\/[\w.+-]+(?:;[\w-]+=[\w-]+)*;base64,/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const workers = new Map();

class OcrError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'OcrError';
        this.status = status;
        this.expose = true;
    }
}

function getWorker(lang) {
    let pending = workers.get(lang);
    if (!pending) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        pending = createWorker(lang, 1, { cachePath: CACHE_DIR }).catch((err) => {
            workers.delete(lang);
            throw err;
        });
        workers.set(lang, pending);
    }
    return pending;
}

function decodeImage(input) {
    if (Buffer.isBuffer(input)) {
        return assertSize(input);
    }

    if (typeof input !== 'string' || input.trim() === '') {
        throw new OcrError(
            'Missing image. Send JSON body { "file": "data:image/jpeg;base64,..." } with Content-Type: application/json.'
        );
    }

    const raw = input.trim();
    const payload = DATA_URL_RE.test(raw) ? raw.slice(raw.indexOf(',') + 1) : raw;
    const base64 = payload.replace(/\s+/g, '');

    if (!base64 || base64.length % 4 !== 0 || !BASE64_RE.test(base64)) {
        throw new OcrError('`file` is not valid base64 image data.');
    }

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) {
        throw new OcrError('`file` decoded to an empty image.');
    }

    return assertSize(buffer);
}

function assertSize(buffer) {
    if (buffer.length > MAX_BYTES) {
        throw new OcrError(`Image is too large. Max size is ${MAX_BYTES} bytes.`, 413);
    }
    return buffer;
}

async function extractText(input, options = {}) {
    const lang = normalizeLang(options.lang);
    const image = decodeImage(input);

    let worker;
    try {
        worker = await getWorker(lang);
    } catch {
        throw new OcrError('Could not start the OCR engine. Run `npm run precache` to verify it can start.', 503);
    }

    let timer;
    try {
        const { data } = await Promise.race([
            worker.recognize(image),
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new OcrError(`OCR timed out after ${TIMEOUT_MS}ms.`, 504)),
                    TIMEOUT_MS
                );
            }),
        ]);
        return {
            text: (data.text || '').trim(),
            confidence: Math.round(data.confidence ?? 0),
            language: lang,
        };
    } catch (err) {
        if (err instanceof OcrError) throw err;
        console.error('OCR failure:', err.message);
        await dropWorker(lang);
        throw new OcrError('OCR engine failed to process the image.', 500);
    } finally {
        clearTimeout(timer);
    }
}

function normalizeLang(lang) {
    const value = String(lang || DEFAULT_LANG).trim().toLowerCase();
    if (!/^[a-z0-9_+-]{2,32}$/.test(value)) {
        throw new OcrError('Invalid language code.');
    }
    return value;
}

async function warmup(langs = [DEFAULT_LANG]) {
    for (const lang of [...new Set(langs.map(normalizeLang))]) {
        await getWorker(lang);
        console.log(`ready: ${lang}`);
    }
}

async function dropWorker(lang) {
    const pending = workers.get(lang);
    if (!pending) return;
    workers.delete(lang);
    try {
        const worker = await pending;
        await worker.terminate();
    } catch {
        /* worker never started or already gone */
    }
}

async function shutdown() {
    await Promise.all([...workers.keys()].map(dropWorker));
}

module.exports = { extractText, warmup, shutdown, OcrError };
