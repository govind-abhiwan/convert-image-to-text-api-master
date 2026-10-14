const express = require('express');
const cors = require('cors');
const app = express();
const ocrService = require('./service/ocr');

app.use(express.json({ limit: process.env.BODY_LIMIT || '7mb' }));
app.use(cors());

app.use('/api', require('./handlers/ocr'));
app.use('/api', require('./handlers/symbol'));

app.use((req, res) => {
    res.status(404).json({ status: 'error', message: 'Not found' });
});

app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({
        status: 'error',
        message: err.expose || status < 500 ? err.message : 'Internal server error',
    });
});

function start() {
    const port = Number(process.env.PORT || 5000);
    const server = app.listen(port, () => console.log(`listening at port: ${port}`));

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            server.close(async () => {
                await ocrService.shutdown();
                process.exit(0);
            });
        });
    }

    return server;
}

if (require.main === module) start();

module.exports = { app, start };
