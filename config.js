const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;

function parseOrigins(value, isProduction) {
    const entries = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
    const origins = [];

    for (const entry of entries) {
        let parsed;
        try {
            parsed = new URL(entry);
        } catch (_error) {
            throw new Error('CORS_ORIGINS must contain valid origin URLs.');
        }
        if (parsed.origin !== entry || parsed.username || parsed.password || (isProduction && parsed.protocol !== 'https:')) {
            throw new Error('CORS_ORIGINS must contain exact origins; production origins must use HTTPS.');
        }
        origins.push(parsed.origin);
    }
    return [...new Set(origins)];
}

function getDevelopmentSecret(env) {
    if (env.SESSION_SECRET) return env.SESSION_SECRET;
    if (env.NODE_ENV === 'test') return 'test-only-session-secret-not-for-production';

    const secretPath = path.join(APP_DIR, '.session-secret');
    try {
        const storedSecret = fs.readFileSync(secretPath, 'utf8').trim();
        if (storedSecret.length >= 32) return storedSecret;
    } catch (_error) {
        // Create a local-only key on first development startup.
    }
    const secret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(secretPath, `${secret}\n`, { flag: 'w', mode: 0o600 });
    return secret;
}

function createConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    if (!['development', 'test', 'production'].includes(nodeEnv)) {
        throw new Error('NODE_ENV must be development, test, or production.');
    }
    const isProduction = nodeEnv === 'production';

    const port = env.PORT == null || env.PORT === '' ? 3000 : Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be an integer between 1 and 65535.');
    }

    const trustProxyValue = String(env.TRUST_PROXY || '').trim().toLowerCase();
    let trustProxy = false;
    if (trustProxyValue) {
        if (/^\d+$/.test(trustProxyValue) && Number(trustProxyValue) <= 5) trustProxy = Number(trustProxyValue);
        else if (['loopback', 'linklocal', 'uniquelocal'].includes(trustProxyValue)) trustProxy = trustProxyValue;
        else throw new Error('TRUST_PROXY must be a hop count from 0 to 5 or loopback, linklocal, or uniquelocal.');
    }

    if (isProduction && !String(env.ORION_DB_PATH || '').trim()) {
        throw new Error('ORION_DB_PATH is required in production.');
    }
    const databasePath = path.resolve(APP_DIR, env.ORION_DB_PATH || 'orion.db');

    const corsOrigins = parseOrigins(env.CORS_ORIGINS, isProduction);
    if (isProduction && corsOrigins.length === 0) {
        throw new Error('CORS_ORIGINS must contain at least one allowed HTTPS origin in production.');
    }

    const sessionSecret = env.SESSION_SECRET || (isProduction ? '' : getDevelopmentSecret({ ...env, NODE_ENV: nodeEnv }));
    if (isProduction && (sessionSecret.length < 32 || /replace|example|change.?me|placeholder/i.test(sessionSecret))) {
        throw new Error('SESSION_SECRET must be a strong value of at least 32 characters in production.');
    }
    if (!sessionSecret) {
        throw new Error('SESSION_SECRET is required.');
    }

    const appBaseUrl = String(env.APP_BASE_URL || (isProduction ? '' : `http://localhost:${port}`)).replace(/\/$/, '');
    let parsedAppUrl;
    try { parsedAppUrl = new URL(appBaseUrl); } catch (_error) { throw new Error('APP_BASE_URL must be a valid URL.'); }
    if (isProduction && parsedAppUrl.protocol !== 'https:') throw new Error('APP_BASE_URL must use HTTPS in production.');
    if (isProduction && (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.SMTP_FROM)) {
        throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM are required in production.');
    }
    if (env.SMTP_PORT && (!Number.isInteger(Number(env.SMTP_PORT)) || Number(env.SMTP_PORT) < 1 || Number(env.SMTP_PORT) > 65535)) {
        throw new Error('SMTP_PORT must be an integer between 1 and 65535.');
    }

    const geminiApiKey = String(env.gemini_api_key || env.GEMINI_API_KEY || env.LLM_API_KEY || '').trim();
    const geminiModel = String(env.GEMINI_MODEL || 'gemini-2.0-flash').trim();
    const enableDemoAccounts = env.ENABLE_DEMO_ACCOUNTS !== undefined
        ? (String(env.ENABLE_DEMO_ACCOUNTS).trim().toLowerCase() === 'true' || String(env.ENABLE_DEMO_ACCOUNTS).trim() === '1')
        : !isProduction;

    return Object.freeze({
        nodeEnv,
        isProduction,
        port,
        databasePath,
        corsOrigins,
        sessionSecret,
        appBaseUrl,
        trustProxy,
        geminiApiKey,
        geminiModel,
        enableDemoAccounts
    });
}

function loadConfig() {
    if (!['production', 'test'].includes(process.env.NODE_ENV)) {
        require('dotenv').config({ path: path.join(APP_DIR, '.env') });
    }
    const config = createConfig(process.env);
    process.env.NODE_ENV = config.nodeEnv;
    process.env.ORION_DB_PATH = config.databasePath;
    process.env.SESSION_SECRET = config.sessionSecret;
    process.env.APP_BASE_URL = config.appBaseUrl;
    process.env.GEMINI_API_KEY = config.geminiApiKey;
    process.env.GEMINI_MODEL = config.geminiModel;
    process.env.ENABLE_DEMO_ACCOUNTS = String(config.enableDemoAccounts);
    return config;
}

module.exports = { createConfig, loadConfig };
