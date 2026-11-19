const express = require('express');
const path = require('path');
const { loadConfig } = require('./config');
const config = loadConfig();
const { BackendData } = require('./backend_data');
const { BackendServices } = require('./backend_services');
const { registerApiRoutes } = require('./backend_routes');
const { createMailer } = require('./mailer');
const helmet = require('helmet');
const crypto = require('crypto');
const { log, logError } = require('./logger');

const app = express();
const PORT = config.port;
app.set('trust proxy', config.trustProxy);
const PUBLIC_FILES = new Set([
    '/',
    '/index.html',
    '/style.css',
    '/main.js',
    '/views.js',
    '/router.js',
    '/data_store.js',
    '/hero.png'
]);

app.disable('x-powered-by');
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            scriptSrcAttr: ["'none'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'", ...config.corsOrigins, ...(!config.isProduction ? ['http://localhost:3000', 'http://127.0.0.1:3000'] : [])],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    req.startedAt = Date.now();
    res.setHeader('X-Request-ID', req.id);
    res.on('finish', () => log('info', 'http_request', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - req.startedAt,
        ip: req.ip
    }));
    next();
});
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const origin = req.headers.origin;
    const sameOrigin = !origin || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
    const isLocalDev = !config.isProduction && Boolean(origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    if (sameOrigin || isLocalDev || config.corsOrigins.includes(origin)) {
        if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Orion-Request');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
        res.status(403).json({ error: 'Origin is not allowed' });
        return;
    }
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    next();
});
const dataLayer = new BackendData();
const serviceLayer = new BackendServices(dataLayer, createMailer(), config);
registerApiRoutes(app, serviceLayer);

app.use(['/api/v1', '/api'], (_req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.get(['/', '/index.html'], (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.use('/public/vendor', express.static(path.join(__dirname, 'public', 'vendor'), {
    dotfiles: 'deny',
    index: false,
    maxAge: '1h',
    fallthrough: true
}));

app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
        next();
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.status(405).end();
        return;
    }
    const requestPath = req.path === '' ? '/' : req.path;
    if (!PUBLIC_FILES.has(requestPath)) {
        res.status(404).send('Not found');
        return;
    }
    next();
});

app.use(express.static(path.join(__dirname), {
    index: false,
    dotfiles: 'deny',
    fallthrough: false
}));

// Express global error handler
app.use((err, _req, res, _next) => {
    logError('unhandled_server_error', err);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

let serverInstance = null;

dataLayer
    .init()
    .then(async () => {
        await serviceLayer.loadPlatformAdmins();
        serverInstance = app.listen(PORT, () => {
            log('info', 'server_started', { port: PORT, nodeEnv: config.nodeEnv });
        });
    })
    .catch((error) => {
        logError('database_initialization_failed', error);
        process.exit(1);
    });

const shutdown = async () => {
    if (serverInstance) {
        serverInstance.close();
    }
    try {
        await dataLayer.close();
    } catch (_e) {}
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
