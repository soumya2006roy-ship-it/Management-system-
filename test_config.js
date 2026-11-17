const assert = require('assert');
const { createConfig } = require('./config');

const validProduction = {
    NODE_ENV: 'production',
    PORT: '8443',
    ORION_DB_PATH: '/srv/orion/orion.db',
    CORS_ORIGINS: 'https://orion.example.gov,https://admin.example.gov',
    SESSION_SECRET: 'A'.repeat(48),
    APP_BASE_URL: 'https://orion.example.gov',
    SMTP_HOST: 'smtp.example.gov',
    SMTP_USER: 'mailer',
    SMTP_PASSWORD: 'B'.repeat(32),
    SMTP_FROM: 'no-reply@example.gov'
};

assert.throws(() => createConfig({ NODE_ENV: 'production' }), /ORION_DB_PATH/);
assert.throws(() => createConfig({ ...validProduction, CORS_ORIGINS: '' }), /CORS_ORIGINS/);
assert.throws(() => createConfig({ ...validProduction, CORS_ORIGINS: 'http://orion.example.gov' }), /HTTPS/);
assert.throws(() => createConfig({ ...validProduction, CORS_ORIGINS: 'https://orion.example.gov/path' }), /exact origins/);
assert.throws(() => createConfig({ ...validProduction, SESSION_SECRET: 'short' }), /SESSION_SECRET/);
assert.throws(() => createConfig({ ...validProduction, PORT: '70000' }), /PORT/);
assert.throws(() => createConfig({ ...validProduction, SMTP_PASSWORD: '' }), /SMTP_HOST/);
assert.throws(() => createConfig({ ...validProduction, APP_BASE_URL: 'http://orion.example.gov' }), /APP_BASE_URL/);
assert.throws(() => createConfig({ ...validProduction, TRUST_PROXY: 'true' }), /TRUST_PROXY/);
assert.throws(() => createConfig({ ...validProduction, SMTP_PORT: '70000' }), /SMTP_PORT/);

assert.throws(() => createConfig({ ...validProduction, SESSION_SECRET: 'replace-with-a-random-secret-at-least-32-characters-long' }), /SESSION_SECRET/);
assert.strictEqual(createConfig(validProduction).enableDemoAccounts, false);
assert.strictEqual(createConfig({ ...validProduction, ENABLE_DEMO_ACCOUNTS: 'true' }).enableDemoAccounts, true);
assert.strictEqual(createConfig({ ...validProduction, ENABLE_DEMO_ACCOUNTS: 'false' }).enableDemoAccounts, false);

const config = createConfig(validProduction);
assert.strictEqual(config.nodeEnv, 'production');
assert.strictEqual(config.port, 8443);
assert.strictEqual(config.corsOrigins.length, 2);
assert.strictEqual(config.databasePath.endsWith('orion.db'), true);
assert.strictEqual(createConfig({ ...validProduction, TRUST_PROXY: '1' }).trustProxy, 1);

const development = createConfig({ NODE_ENV: 'test' });
assert.strictEqual(development.isProduction, false);
assert.strictEqual(development.port, 3000);
assert.ok(development.sessionSecret.length >= 32);

console.log('Configuration tests passed.');
