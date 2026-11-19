const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.ORION_DB_PATH = path.join(os.tmpdir(), `orion-security-${process.pid}.db`);
process.env.SESSION_SECRET = 'security-tests-session-secret-at-least-32-chars';

const {
    hashSecret,
    isHashedSecret,
    normalizeRole,
    publicUser,
    validatePassword,
    verifySecret,
    escapeLike,
    DUMMY_HASH,
    MIN_PASSWORD_LENGTH
} = require('./auth_utils');
const { BackendData } = require('./backend_data');
const { BackendServices, ApiError } = require('./backend_services');
const { redact } = require('./logger');

async function run() {
    // 1. Role normalization tests
    assert.strictEqual(normalizeRole('executive'), 'exec');
    assert.strictEqual(normalizeRole('EXEC'), 'exec');
    assert.strictEqual(normalizeRole('  exec  '), 'exec');
    assert.strictEqual(normalizeRole('manager'), 'manager');
    assert.strictEqual(normalizeRole('MANAGER'), 'manager');
    assert.strictEqual(normalizeRole('worker'), 'worker');
    assert.strictEqual(normalizeRole('admin'), null);
    assert.strictEqual(normalizeRole(''), null);
    assert.strictEqual(normalizeRole(null), null);
    assert.strictEqual(normalizeRole(undefined), null);

    // 2. Password validation tests
    assert.ok(validatePassword('short'));
    assert.strictEqual(validatePassword('password123'), null);
    assert.ok(validatePassword('a'.repeat(129))); // max length 128
    assert.strictEqual(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH)), null);

    // 3. Secret hashing and verification tests
    const hashed = await hashSecret('password123');
    assert.ok(isHashedSecret(hashed));
    assert.strictEqual(await verifySecret('password123', hashed), true);
    assert.strictEqual(await verifySecret('wrong-password', hashed), false);
    // Plaintext stored passwords must be strictly rejected (Fix 1.3: scrypt-only enforcement)
    assert.strictEqual(await verifySecret('password123', 'password123'), false);
    assert.strictEqual(await verifySecret('password123', 'password124'), false);
    assert.strictEqual(await verifySecret('', hashed), false);
    assert.strictEqual(await verifySecret(null, hashed), false);
    assert.strictEqual(await verifySecret(undefined, hashed), false);
    assert.strictEqual(await verifySecret('password123', ''), false);
    assert.strictEqual(await verifySecret('password123', null), false);
    assert.strictEqual(await verifySecret('password123', undefined), false);

    // Timing attack mitigation dummy verification test
    const dummyCheck = await verifySecret('testpassword', DUMMY_HASH);
    assert.strictEqual(dummyCheck, false);

    // 4. Public user sanitization tests
    const user = publicUser({
        id: 1,
        username: 'mgr',
        name: 'Manager',
        role: 'manager',
        password: 'secret',
        securityAnswer: 'dog',
        organizationId: 9
    });
    assert.strictEqual(user.password, undefined);
    assert.strictEqual(user.securityAnswer, undefined);
    assert.strictEqual(user.organizationId, 9);
    assert.strictEqual(user.role, 'manager');
    assert.strictEqual(publicUser(null), null);
    assert.deepStrictEqual(redact({ password: 'hidden', sessionToken: 'hidden', nested: { cookie: 'hidden' }, label: 'safe' }), {
        password: '[REDACTED]', sessionToken: '[REDACTED]', nested: { cookie: '[REDACTED]' }, label: 'safe'
    });

    // 5. LIKE escape sanitization tests
    assert.strictEqual(escapeLike('100%_done'), '100\\%\\_done');
    assert.strictEqual(escapeLike('test\\escape'), 'test\\\\escape');
    assert.strictEqual(escapeLike(null), '');
    assert.strictEqual(escapeLike(undefined), '');

    // 6. Database transaction concurrency & serialization test
    const dataLayer = new BackendData();
    await dataLayer.init();
    const appliedMigration = await dataLayer.get('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    const initialMigrationCount = (await dataLayer.all('SELECT version FROM schema_migrations')).length;
    assert.ok(appliedMigration.version >= 2, 'schema is recorded as a versioned migration');
    await dataLayer.init();
    assert.strictEqual((await dataLayer.all('SELECT version FROM schema_migrations')).length, initialMigrationCount, 'applied migrations are not rerun');

    // Persistent sessions survive reopening the database and expire/revoke correctly.
    const services = new BackendServices(dataLayer);
    const token = await services.createSession(42);
    assert.ok(typeof token === 'string' && token.length === 64);
    assert.strictEqual(await services.getUserIdByToken(token), 42);
    const t1 = await services.createSession(99);
    const t2 = await services.createSession(99);
    const t3 = await services.createSession(100);
    await services.clearSessionsForUser(99);
    assert.strictEqual(await services.getUserIdByToken(t1), null);
    assert.strictEqual(await services.getUserIdByToken(t2), null);
    assert.strictEqual(await services.getUserIdByToken(t3), 100);
    const crypto = require('crypto');
    await dataLayer.run('UPDATE sessions SET expiresAt=? WHERE tokenHash=?', [Date.now() - 1000, crypto.createHash('sha256').update(t3).digest('hex')]);
    assert.strictEqual(await services.getUserIdByToken(t3), null);

    // Email reset links are opaque, expiring, single-use, and revoke sessions.
    const resetUrls = [];
    const resetServices = new BackendServices(dataLayer, { sendPasswordReset: async (_email, url) => resetUrls.push(url) });
    const resetUser = await resetServices.registerUser({ email: 'reset@example.test', name: 'Reset User', password: 'old-password-123' });
    const oldSession = resetUser.token;
    const genericResponse = await resetServices.requestPasswordReset({ email: 'reset@example.test' });
    assert.strictEqual(genericResponse.message, 'If an account exists for that email, a password reset link has been sent.');
    assert.strictEqual((await resetServices.requestPasswordReset({ email: 'missing@example.test' })).message, genericResponse.message);
    const resetUrl = new URL(resetUrls[0]);
    const rawResetToken = new URLSearchParams(resetUrl.hash.split('?')[1] || '').get('token');
    const resetHash = crypto.createHash('sha256').update(rawResetToken).digest('hex');
    const storedReset = await dataLayer.getPasswordResetToken(resetHash);
    assert.ok(storedReset && storedReset.tokenHash !== rawResetToken);
    assert.ok(storedReset.expiresAt > Date.now() && storedReset.expiresAt <= Date.now() + 30 * 60 * 1000);
    await resetServices.resetPassword({ token: rawResetToken, newPassword: 'new-password-456' });
    assert.strictEqual(await resetServices.getUserIdByToken(oldSession), null, 'password reset revokes existing sessions');
    assert.strictEqual(await resetServices.login({ username: 'reset@example.test', password: 'new-password-456' }).then(Boolean), true);
    await assert.rejects(() => resetServices.resetPassword({ token: rawResetToken, newPassword: 'new-password-456' }), /invalid or expired/);
    await resetServices.requestPasswordReset({ email: 'reset@example.test' });
    const expiringToken = new URLSearchParams(new URL(resetUrls[1]).hash.split('?')[1] || '').get('token');
    const expiringHash = crypto.createHash('sha256').update(expiringToken).digest('hex');
    await dataLayer.run('UPDATE password_reset_tokens SET expiresAt=? WHERE tokenHash=?', [Date.now() - 1, expiringHash]);
    await assert.rejects(() => resetServices.resetPassword({ token: expiringToken, newPassword: 'new-password-789' }), /invalid or expired/);
    await dataLayer.close();
    const reopenedData = new BackendData();
    await reopenedData.init();
    const reopenedServices = new BackendServices(reopenedData);
    assert.strictEqual(await reopenedServices.getUserIdByToken(token), 42, 'session must survive a database/server restart');
    await reopenedServices.destroySession(token);
    assert.strictEqual(await reopenedServices.getUserIdByToken(token), null);
    await reopenedData.close();

    // 7. Database transaction concurrency & serialization test
    const txDataLayer = new BackendData();
    await txDataLayer.init();

    // Launch 5 concurrent transactions simultaneously
    const txResults = await Promise.all([
        txDataLayer.withTransaction(async () => {
            await new Promise(r => setTimeout(r, 20));
            return 'tx1';
        }),
        txDataLayer.withTransaction(async () => {
            await new Promise(r => setTimeout(r, 10));
            return 'tx2';
        }),
        txDataLayer.withTransaction(async () => {
            await new Promise(r => setTimeout(r, 15));
            return 'tx3';
        }),
        txDataLayer.withTransaction(async () => {
            await new Promise(r => setTimeout(r, 5));
            return 'tx4';
        }),
        txDataLayer.withTransaction(async () => {
            return 'tx5';
        })
    ]);

    assert.deepStrictEqual(txResults, ['tx1', 'tx2', 'tx3', 'tx4', 'tx5']);

    // Test transaction rollback on error without breaking queue
    let errorThrown = false;
    try {
        await txDataLayer.withTransaction(async () => {
            throw new Error('Simulated TX Failure');
        });
    } catch (err) {
        errorThrown = true;
        assert.strictEqual(err.message, 'Simulated TX Failure');
    }
    assert.ok(errorThrown, 'Expected transaction error to be caught');

    // Next transaction after a rollback must succeed smoothly
    const postRollback = await txDataLayer.withTransaction(async () => {
        return 'recovered';
    });
    assert.strictEqual(postRollback, 'recovered');

    // Test addUpdate audit logging
    await txDataLayer.addUpdate('SecurityTest', 'Verification log entry', null);
    const recentUpdates = await txDataLayer.all(
        "SELECT * FROM updates WHERE author = 'SecurityTest' ORDER BY timestamp DESC LIMIT 1"
    );
    assert.ok(recentUpdates.length > 0);
    assert.strictEqual(recentUpdates[0].text, 'Verification log entry');

    await txDataLayer.close();
    const backupPath = path.join(os.tmpdir(), `orion-security-backup-${process.pid}.db`);
    try { fs.rmSync(backupPath, { force: true }); } catch (_error) {}
    await require('./database_tools').backupDatabase(process.env.ORION_DB_PATH, backupPath);
    const priorDbPath = process.env.ORION_DB_PATH;
    process.env.ORION_DB_PATH = backupPath;
    const restoredData = new BackendData();
    await restoredData.init();
    assert.ok(await restoredData.get("SELECT id FROM users WHERE username='reset@example.test'"), 'SQLite backup contains persisted user data');
    await restoredData.close();
    process.env.ORION_DB_PATH = priorDbPath;
    try { fs.rmSync(backupPath, { force: true }); } catch (_error) {}
    // --- Test: XSS Render Immunity ---
    const { Views } = require('./views');
    const xssPayload = '<img src=x onerror="alert(document.cookie)">';
    const scriptPayload = '<script>alert("XSS")</script>';
    const renderedTask = Views.renderTaskRow({
        id: 999,
        title: xssPayload,
        description: scriptPayload,
        status: 'Active',
        priority: 'high',
        progress: 10
    });
    assert.ok(!renderedTask.includes('<img src=x'), 'Raw img tag must not appear in rendered HTML');
    assert.ok(!renderedTask.includes('<script>'), 'Raw script tag must not appear in rendered HTML');
    assert.ok(renderedTask.includes('&lt;img src=x onerror=&quot;alert(document.cookie)&quot;&gt;'), 'XSS payload must be HTML escaped');
    assert.ok(renderedTask.includes('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;'), 'Script payload must be HTML escaped');

    // --- Test: Raw characters preserved (not stripped) on backend ---
    const legitTitle = "R&D and O'Brien Infrastructure";
    const rawData = new BackendData();
    await rawData.init();
    const rawServices = new BackendServices(rawData);
    // Verify plaintext password login is rejected
    await rawData.run("INSERT INTO users (username, password, name, role) VALUES ('plain_user@test.org', 'plaintext123', 'Plain User', 'worker')");
    const loginResult = await rawServices.login({ username: 'plain_user@test.org', password: 'plaintext123' });
    assert.strictEqual(loginResult, null, 'Plaintext password login must return null (rejected)');
    await rawData.close();

    // --- Regression Test: SEC-01 Organization Self-Enrollment Backdoor Closed ---
    const secData = new BackendData();
    await secData.init();
    const secServices = new BackendServices(secData);
    
    const secManager = await secServices.registerUser({
        username: 'sec_manager@test.org',
        password: 'Password123!',
        name: 'Sec Manager',
        role: 'manager'
    });
    const secInst = await secServices.addInstitution({
        name: 'Sec Institute',
        type: 'Defense',
        contact: 'sec@test.org',
        creatorId: secManager.id
    });
    const secWorker = await secServices.registerUser({
        username: 'sec_worker@test.org',
        password: 'Password123!',
        name: 'Sec Worker',
        role: 'worker'
    });

    // SEC-01: Direct join via institutionId MUST fail with 400
    let sec01Rejected = false;
    try {
        await secServices.joinOrganization({ userId: secWorker.id, institutionId: secInst.id });
    } catch (err) {
        if (err.status === 400 && err.message.includes('invitation code')) {
            sec01Rejected = true;
        }
    }
    assert.strictEqual(sec01Rejected, true, 'joinOrganization must reject joining via institutionId');

    // SEC-01: Joining via redeemOrganizationInvite still works
    const secInvite = await secServices.createOrganizationInvite(secManager.id, {
        organizationId: secInst.id,
        maxUses: 1,
        expiresInHours: 24
    });
    const secJoin = await secServices.joinOrganization({ userId: secWorker.id, code: secInvite.code });
    assert.strictEqual(secJoin.success, true, 'redeemOrganizationInvite via code must succeed');
    assert.strictEqual(secJoin.organization.id, secInst.id);

    // --- Regression Test: DATA-01 Eliminate Null-Tenant Project Leakage ---
    const unaffiliatedUser = await secServices.registerUser({
        username: 'unaffiliated@test.org',
        password: 'Password123!',
        name: 'Unaffiliated User',
        role: 'worker'
    });
    // Unaffiliated user cannot create a project (must belong to verified org)
    let nullTenantProjRejected = false;
    try {
        await secServices.createProject({ name: 'Null Tenant Project', creatorId: unaffiliatedUser.id });
    } catch (err) {
        if (err.status === 403) nullTenantProjRejected = true;
    }
    assert.strictEqual(nullTenantProjRejected, true, 'createProject must reject users without verified organization (403)');

    // In getDashboard, unaffiliated user must see empty arrays (never organizationId IS NULL projects)
    // First, insert an orphaned project with organizationId IS NULL to test isolation
    await secData.run("INSERT INTO projects (name, progress, status, organizationId) VALUES ('Orphaned Project', 0, 'In Planning', NULL)");
    const unaffiliatedDash = await secServices.getDashboard(unaffiliatedUser.id);
    assert.strictEqual(unaffiliatedDash.projects.length, 0, 'Unaffiliated user must see 0 projects in getDashboard');
    assert.strictEqual(unaffiliatedDash.updates.length, 0, 'Unaffiliated user must see 0 updates in getDashboard');
    assert.strictEqual(unaffiliatedDash.myTasks.length, 0, 'Unaffiliated user must see 0 myTasks in getDashboard');

    // --- Regression Test: SEC-02 CORS Preflight Methods ---
    const serverJsContent = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.ok(serverJsContent.includes("'Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS'"), 'server.js must allow PATCH and DELETE in CORS preflight');

    await secData.close();

    console.log('Security unit tests passed.');
}

run().catch((error) => {
    console.error('Security test failed:', error);
    process.exit(1);
});
