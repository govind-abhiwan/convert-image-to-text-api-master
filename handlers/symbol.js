const express = require('express');
const router = express.Router();
const symbolService = require('../service/symbol');

const RAW_LIMIT = process.env.IMAGE_LIMIT || '6mb';

function readImage(req) {
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        return req.body;
    }

    const file = req.body?.file;
    if (typeof file === 'string' && file.trim() !== '') {
        const raw = file.trim();
        const comma = raw.indexOf(',');
        const base64 = (comma > -1 && raw.slice(0, comma).startsWith('data:') ? raw.slice(comma + 1) : raw).replace(
            /\s+/g,
            ''
        );
        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length === 0) {
            throw new symbolService.SymbolError('`file` decoded to an empty image.', 400);
        }
        return buffer;
    }

    throw new symbolService.SymbolError(
        'No image received. POST the canvas as image/png bytes, or JSON { "file": "data:image/png;base64,..." }.'
    );
}

async function classifyCanvas(req, res, next) {
    try {
        const result = symbolService.classifyPng(readImage(req));
        res.json({ status: 'ok', response: result });
    } catch (err) {
        next(err);
    }
}

router.post('/move', express.raw({ type: ['image/*', 'application/octet-stream'], limit: RAW_LIMIT }), classifyCanvas);

module.exports = router;
