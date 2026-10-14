const { warmup, shutdown } = require('../service/ocr');

const langs = (process.argv[2] || process.env.OCR_LANG || 'eng').split(',').map((l) => l.trim()).filter(Boolean);

warmup(langs)
    .then(() => console.log(`cache: ${require('path').join(__dirname, '..', '.tesseract-cache')}`))
    .catch((err) => {
        console.error('precache failed:', err.message);
        process.exitCode = 1;
    })
    .finally(shutdown);
