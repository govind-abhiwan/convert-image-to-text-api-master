const express = require('express');
const router = express.Router();
const ocrService = require('../service/ocr');

async function convertPhotoToText(req, res, next) {
    try {
        const result = await ocrService.extractText(req.body?.file, {
            lang: req.query.lang || req.body?.lang,
        });
        res.json({ status: 'ok', response: result });
    } catch (err) {
        next(err);
    }
}

router.post('/ocr', convertPhotoToText);

module.exports = router;
