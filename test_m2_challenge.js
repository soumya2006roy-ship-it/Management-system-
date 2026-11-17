const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.ORION_DB_PATH = path.join(os.tmpdir(), `orion-challenge-m2-${process.pid}.db`);
process.env.SESSION_SECRET = 'challenge-test-session-secret-32-chars-long';
try { fs.rmSync(process.env.ORION_DB_PATH, { force: true }); } catch (_error) {}

const { BackendData } = require('./backend_data');
const { BackendServices, ApiError } = require('./backend_services');
const { registerApiRoutes } = require('./backend_routes');

async function expectError(work, status, text) {
    let thrown = false;
    try {
        await work();
    } catch (error) {
        thrown = true;
        assert.ok(error instanceof ApiError, `Expected ApiError, got ${error.name}: ${error.message}`);
        assert.strictEqual(error.status, status, `Expected HTTP status ${status}, got ${error.status} (msg: ${error.message})`);
        if (text) {
            const hasText = error.message.toLowerCase().includes(text.toLowerCase());
            assert.ok(hasText, `Expected error message to include "${text}", but got "${error.message}"`);
        }
    }
    assert.ok(thrown, `Expected function to throw ApiError(${status}), but it completed successfully`);
}

async function createUser(services, email, role = 'worker') {
    const user = await services.registerUser({
        email,
        username: email,
        name: email.split('@')[0],
        password: 'correct-horse-42',
        role
    });
    return user;
}

async function run() {
    console.log('================================================================');
    console.log('STARTING EMPIRICAL ADVERSARIAL CHALLENGE SUITE: MILESTONE 2 (ISSUE 2)');
    console.log('================================================================');

    const data = new BackendData();
    await data.init();
    const services = new BackendServices(data);

    try {
        // ====================================================================
        // PART 1: addInstitution ADVERSARIAL CHALLENGES
        // ====================================================================
        console.log('\n--- PART 1: addInstitution Empirical Challenges ---');

        const creatorA = await createUser(services, 'creatorA@adversary.test');
        const creatorB = await createUser(services, 'creatorB@adversary.test');

        // 1.1 Baseline registration
        console.log('[1.1] Baseline registration');
        const baselineInst = await services.addInstitution({
            name: 'Acme Corporation',
            type: 'Defense Contractor',
            contact: 'hq@acme.test',
            creatorId: creatorA.id
        });
        assert.ok(baselineInst && baselineInst.id, 'Baseline institution must have an ID');
        assert.strictEqual(baselineInst.name, 'Acme Corporation');
        assert.strictEqual(baselineInst.verificationStatus, 'approved');

        // 1.2 Duplicate name collisions across case variations (must reject with 409)
        console.log('[1.2] Duplicate name collisions across case variations (reject with 409)');
        
        // Exact duplicate
        await expectError(
            () => services.addInstitution({ name: 'Acme Corporation', type: 'Any' }),
            409,
            'already exists'
        );

        // ALL UPPERCASE
        await expectError(
            () => services.addInstitution({ name: 'ACME CORPORATION', type: 'Any' }),
            409,
            'already exists'
        );

        // all lowercase
        await expectError(
            () => services.addInstitution({ name: 'acme corporation', type: 'Any' }),
            409,
            'already exists'
        );

        // Mixed Case
        await expectError(
            () => services.addInstitution({ name: 'aCmE cOrPoRaTiOn', type: 'Any' }),
            409,
            'already exists'
        );

        // Surrounding whitespace (leading/trailing spaces)
        await expectError(
            () => services.addInstitution({ name: '   Acme Corporation   ', type: 'Any' }),
            409,
            'already exists'
        );

        // Surrounding whitespace with tabs and newlines
        await expectError(
            () => services.addInstitution({ name: '\t\nacme corporation\n\t', type: 'Any' }),
            409,
            'already exists'
        );

        // Collision attempt by a different creator
        await expectError(
            () => services.addInstitution({ name: 'ACME CORPORATION', type: 'Any', creatorId: creatorB.id }),
            409,
            'already exists'
        );

        // Verify no duplicate row was created in DB
        const acmeRows = await data.all('SELECT * FROM institutions WHERE lower(name) = lower(?)', ['Acme Corporation']);
        assert.strictEqual(acmeRows.length, 1, 'Exactly 1 row must exist for Acme Corporation');

        // 1.3 Whitespace and boundary checks (empty strings, length limits -> reject with 400)
        console.log('[1.3] Whitespace and boundary checks');

        // Name empty / whitespace / missing
        await expectError(() => services.addInstitution({ name: '', type: 'Tech' }), 400, 'name is required');
        await expectError(() => services.addInstitution({ name: '   ', type: 'Tech' }), 400, 'name is required');
        await expectError(() => services.addInstitution({ name: '\t\n\r ', type: 'Tech' }), 400, 'name is required');
        await expectError(() => services.addInstitution({ name: null, type: 'Tech' }), 400, 'name is required');
        await expectError(() => services.addInstitution({ type: 'Tech' }), 400, 'name is required');
        await expectError(() => services.addInstitution({ name: [], type: 'Tech' }), 400, 'name is required');

        // Name length boundary: 1 char valid, 200 chars valid, 201 chars reject
        const inst1Char = await services.addInstitution({ name: 'X', type: 'SingleChar' });
        assert.strictEqual(inst1Char.name, 'X');

        const inst200Chars = await services.addInstitution({ name: 'N'.repeat(200), type: 'MaxLen200' });
        assert.strictEqual(inst200Chars.name.length, 200);

        await expectError(
            () => services.addInstitution({ name: 'N'.repeat(201), type: 'Exceeds200' }),
            400,
            '200 characters'
        );

        // Type empty / whitespace / missing
        await expectError(() => services.addInstitution({ name: 'ValidName1', type: '' }), 400, 'type is required');
        await expectError(() => services.addInstitution({ name: 'ValidName2', type: '   ' }), 400, 'type is required');
        await expectError(() => services.addInstitution({ name: 'ValidName3', type: null }), 400, 'type is required');
        await expectError(() => services.addInstitution({ name: 'ValidName4' }), 400, 'type is required');

        // Type length boundary: 1 char valid, 100 chars valid, 101 chars reject
        const instType1Char = await services.addInstitution({ name: 'TypeTest1', type: 'T' });
        assert.strictEqual(instType1Char.type, 'T');

        const instType100Chars = await services.addInstitution({ name: 'TypeTest2', type: 'T'.repeat(100) });
        assert.strictEqual(instType100Chars.type.length, 100);

        await expectError(
            () => services.addInstitution({ name: 'TypeTest3', type: 'T'.repeat(101) }),
            400,
            '100 characters'
        );

        // Contact boundary: optional (null/undefined/""), 254 chars valid, 255 chars reject
        const instContactEmpty = await services.addInstitution({ name: 'ContactTest1', type: 'General', contact: '' });
        assert.strictEqual(instContactEmpty.contact, '');

        const instContactNull = await services.addInstitution({ name: 'ContactTest2', type: 'General', contact: null });
        assert.strictEqual(instContactNull.contact, '');

        const instContactSpaces = await services.addInstitution({ name: 'ContactTest3', type: 'General', contact: '   ' });
        assert.strictEqual(instContactSpaces.contact, '');

        const instContact254 = await services.addInstitution({ name: 'ContactTest4', type: 'General', contact: 'c'.repeat(254) });
        assert.strictEqual(instContact254.contact.length, 254);

        await expectError(
            () => services.addInstitution({ name: 'ContactTest5', type: 'General', contact: 'c'.repeat(255) }),
            400,
            '254 characters'
        );

        // 1.4 SQL injection attacks in name, type, and contact
        console.log('[1.4] SQL injection in name, type, and contact');

        // Payload 1 in name: Classic quote + drop table
        const sqliName = "InjectedOrg'); DROP TABLE institutions;--";
        const instSqli1 = await services.addInstitution({
            name: sqliName,
            type: 'ExploitTest',
            contact: 'sqli@test.org'
        });
        assert.strictEqual(instSqli1.name, sqliName, 'Payload must be treated as literal string');

        // Verify table still exists and query returns data safely
        const tableCheck = await data.get("SELECT name FROM sqlite_master WHERE type='table' AND name='institutions'");
        assert.ok(tableCheck, 'institutions table must not be dropped by SQL injection');

        // Verify duplicate check works for SQLi name
        await expectError(
            () => services.addInstitution({ name: sqliName, type: 'DuplicateSqli' }),
            409,
            'already exists'
        );

        // Payload 2 in name: Tautology payload
        const tautologyName = "' OR '1'='1";
        const instSqli2 = await services.addInstitution({
            name: tautologyName,
            type: 'ExploitTest'
        });
        assert.strictEqual(instSqli2.name, tautologyName);

        // Duplicate check on tautology name
        await expectError(
            () => services.addInstitution({ name: tautologyName.toLowerCase(), type: 'ExploitTest' }),
            409,
            'already exists'
        );

        // Payload 3 in type: UPDATE exploit
        const sqliType = "Gov'; UPDATE users SET role='exec' WHERE 1=1;--";
        const instSqli3 = await services.addInstitution({
            name: 'Safe Org With Sqli Type',
            type: sqliType
        });
        assert.strictEqual(instSqli3.type, sqliType);

        // Verify users role was not escalated
        const creatorBCheck = await data.get('SELECT role FROM users WHERE id = ?', [creatorB.id]);
        assert.strictEqual(creatorBCheck.role, 'worker', 'Users table must not be altered by SQL injection in type');

        // Payload 4 in contact: DELETE exploit
        const sqliContact = "admin@example.com'; DELETE FROM users;--";
        const instSqli4 = await services.addInstitution({
            name: 'Safe Org With Sqli Contact',
            type: 'Gov',
            contact: sqliContact
        });
        assert.strictEqual(instSqli4.contact, sqliContact);

        // Verify users still exist
        const allUsers = await data.all('SELECT id FROM users');
        assert.ok(allUsers.length >= 2, 'Users table must not be deleted by SQL injection in contact');

        // 1.5 Creator user promotion and membership verification
        console.log('[1.5] Creator user promotion and organization_memberships verification');

        // creatorA created baselineInst ('Acme Corporation')
        // Check user record
        const userA = await data.get('SELECT id, name, role, organizationId FROM users WHERE id = ?', [creatorA.id]);
        assert.strictEqual(userA.role, 'manager', 'Creator user role must be promoted to manager');
        assert.strictEqual(userA.organizationId, baselineInst.id, 'Creator organizationId must point to created institution');

        // Check organization_memberships record
        const membershipA = await data.get('SELECT * FROM organization_memberships WHERE userId = ? AND organizationId = ?', [creatorA.id, baselineInst.id]);
        assert.ok(membershipA, 'Membership record must exist in organization_memberships');
        assert.strictEqual(membershipA.role, 'admin', 'Membership role for creator must be admin');
        assert.ok(membershipA.createdAt > 0, 'Membership createdAt must be set');

        // Check activity log in updates
        const updatesA = await data.all('SELECT * FROM updates WHERE organizationId = ?', [baselineInst.id]);
        assert.ok(
            updatesA.some(u => u.text.includes('Registered institution "Acme Corporation"') && u.author === userA.name),
            'Activity log must record institution creation with author name'
        );

        // Verify institution without creatorId creates record with author Admin and touches no users
        const countUsersBefore = (await data.all('SELECT id FROM users')).length;
        const instNoCreator = await services.addInstitution({
            name: 'Autonomous Institute',
            type: 'Research'
        });
        assert.ok(instNoCreator && instNoCreator.id);
        const countUsersAfter = (await data.all('SELECT id FROM users')).length;
        assert.strictEqual(countUsersBefore, countUsersAfter, 'No users should be modified when creatorId is omitted');

        // 1.6 Concurrency on duplicate name registration (TOCTOU Stress Test)
        console.log('[1.6] Concurrent addInstitution duplicate race condition test (TOCTOU)');
        const concResults = await Promise.allSettled([
            services.addInstitution({ name: 'Quantum Leap Labs', type: 'Research' }),
            services.addInstitution({ name: 'quantum leap labs', type: 'Research' })
        ]);
        const concFulfilled = concResults.filter(r => r.status === 'fulfilled');
        const concRejected = concResults.filter(r => r.status === 'rejected');
        console.log(`  -> Concurrent addInstitution results: ${concFulfilled.length} fulfilled, ${concRejected.length} rejected`);
        // Check database row count for Quantum Leap Labs
        const quantumRows = await data.all('SELECT * FROM institutions WHERE lower(name) = lower(?)', ['Quantum Leap Labs']);
        console.log(`  -> Institutions in DB matching 'Quantum Leap Labs': ${quantumRows.length}`);
        if (quantumRows.length > 1) {
            console.warn('  [VULNERABILITY DETECTED]: addInstitution allows duplicate institutions under concurrent requests due to lack of UNIQUE constraint and pre-transaction check (TOCTOU).');
        }

        // 1.7 Platform Executive demotion challenge
        console.log('[1.7] Testing if platform executive (exec) is demoted to manager');
        const execUser = await createUser(services, 'exec_user@adversary.test');
        await data.run("UPDATE users SET role = 'exec' WHERE id = ?", [execUser.id]);
        const beforeRole = (await data.get('SELECT role FROM users WHERE id = ?', [execUser.id])).role;
        assert.strictEqual(beforeRole, 'exec');

        await services.addInstitution({
            name: 'Executive Created Agency',
            type: 'Federal',
            creatorId: execUser.id
        });

        const afterRole = (await data.get('SELECT role FROM users WHERE id = ?', [execUser.id])).role;
        console.log(`  -> Exec role before: ${beforeRole}, after: ${afterRole}`);
        if (afterRole === 'manager') {
            console.warn('  [FINDING]: addInstitution unconditionally overrides creator role to "manager", demoting platform executives (exec) to manager.');
        }

        console.log('PART 1 PASSED: All sequential addInstitution challenges verified.');

        // ====================================================================
        // PART 2: joinOrganization ADVERSARIAL CHALLENGES
        // ====================================================================
        console.log('\n--- PART 2: joinOrganization Empirical Challenges ---');

        const workerM1 = await createUser(services, 'workerM1@adversary.test');
        const workerM2 = await createUser(services, 'workerM2@adversary.test');
        const workerM3 = await createUser(services, 'workerM3@adversary.test');
        const workerM4 = await createUser(services, 'workerM4@adversary.test');

        // 2.1 Duplicate membership prevention (409 rejection)
        console.log('[2.1] Duplicate membership prevention (reject with 409)');

        // First, workerM1 joins Acme Corporation via institutionId
        const join1 = await services.joinOrganization({
            userId: workerM1.id,
            institutionId: baselineInst.id
        });
        assert.ok(join1 && join1.success);
        assert.strictEqual(join1.organization.id, baselineInst.id);

        // Verify workerM1 DB state
        const dbWorkerM1 = await data.get('SELECT organizationId FROM users WHERE id = ?', [workerM1.id]);
        assert.strictEqual(dbWorkerM1.organizationId, baselineInst.id);
        const memberRowM1 = await data.get('SELECT role FROM organization_memberships WHERE userId = ? AND organizationId = ?', [workerM1.id, baselineInst.id]);
        assert.strictEqual(memberRowM1.role, 'member');

        // Challenge 2.1a: Attempt to join same institution again via institutionId -> 409
        await expectError(
            () => services.joinOrganization({ userId: workerM1.id, institutionId: baselineInst.id }),
            409,
            'already a member'
        );

        // Challenge 2.1b: Attempt to join a different institution via institutionId -> 409
        await expectError(
            () => services.joinOrganization({ userId: workerM1.id, institutionId: instNoCreator.id }),
            409,
            'already a member'
        );

        // Challenge 2.1c: Attempt to join via invite code when already in an org -> 409
        const testInvite = await services.createOrganizationInvite(creatorA.id, { maxUses: 5, expiresInDays: 7 });
        await expectError(
            () => services.joinOrganization({ userId: workerM1.id, code: testInvite.code }),
            409
        );

        // Challenge 2.1d: User has organizationId = null in users table, but has row in organization_memberships -> 409
        const workerGhost = await createUser(services, 'ghost@adversary.test');
        await data.run("INSERT INTO organization_memberships (userId, organizationId, role, createdAt) VALUES (?, ?, 'member', ?)", [workerGhost.id, baselineInst.id, Date.now()]);
        // Note: ghost user.organizationId is still null in users table!
        const ghostUser = await data.get('SELECT organizationId FROM users WHERE id = ?', [workerGhost.id]);
        assert.strictEqual(ghostUser.organizationId, null);

        await expectError(
            () => services.joinOrganization({ userId: workerGhost.id, institutionId: instNoCreator.id }),
            409,
            'already a member'
        );

        // Challenge 2.1e: Creator user (manager/admin) attempts to join another org -> 409
        await expectError(
            () => services.joinOrganization({ userId: creatorA.id, institutionId: instNoCreator.id }),
            409,
            'already a member'
        );

        // 2.2 Joining unapproved or non-existent institutions (404 rejection)
        console.log('[2.2] Joining unapproved or non-existent institutions (reject with 404)');

        // Non-existent ID (large integer)
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, institutionId: 999999 }),
            404,
            'not found or not approved'
        );

        // Non-existent ID (0)
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, institutionId: 0 }),
            404,
            'not found or not approved'
        );

        // Negative ID
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, institutionId: -10 }),
            404,
            'not found or not approved'
        );

        // Non-numeric string ID
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, institutionId: 'not-an-id' }),
            404,
            'not found or not approved'
        );

        // Unapproved institution: 'unverified'
        const unverified = await data.run("INSERT INTO institutions (name, type, verificationStatus) VALUES ('Unverified Inc', 'Tech', 'unverified')");
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, institutionId: unverified.lastID }),
            404,
            'not found or not approved'
        );

        // Unapproved institution: 'pending_verification'
        const pending = await data.run("INSERT INTO institutions (name, type, verificationStatus) VALUES ('Pending Org', 'Tech', 'pending_verification')");
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, institutionId: pending.lastID }),
            404,
            'not found or not approved'
        );

        // Unapproved institution: 'rejected'
        const rejectedOrg = await data.run("INSERT INTO institutions (name, type, verificationStatus) VALUES ('Rejected LLC', 'Tech', 'rejected')");
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, institutionId: rejectedOrg.lastID }),
            404,
            'not found or not approved'
        );

        // 2.3 Joining with invalid, expired, or revoked invite codes (400 rejection)
        console.log('[2.3] Joining with invalid, expired, revoked, or exhausted invite codes (reject with 400)');

        // Malformed code: too short
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, code: 'tiny' }),
            400,
            'valid invite code'
        );

        // Malformed code: special characters
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, code: 'code!@#$%^&*()_+~`|}{[]:;?><,.' }),
            400,
            'valid invite code'
        );

        // Non-existent invite code (proper length/characters, but doesn't exist)
        const fakeCode = 'A'.repeat(32);
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, code: fakeCode }),
            400,
            'invalid, expired'
        );

        // Expired invite code
        const expInvite = await services.createOrganizationInvite(creatorA.id, { maxUses: 1, expiresInDays: 1 });
        const expHash = crypto.createHash('sha256').update(expInvite.code).digest('hex');
        await data.run('UPDATE organization_invites SET expiresAt = ? WHERE codeHash = ?', [Date.now() - 5000, expHash]);
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, code: expInvite.code }),
            400,
            'invalid, expired'
        );

        // Revoked invite code
        const revInvite = await services.createOrganizationInvite(creatorA.id, { maxUses: 1, expiresInDays: 1 });
        await services.revokeOrganizationInvite(creatorA.id, revInvite.inviteId);
        await expectError(
            () => services.joinOrganization({ userId: workerM2.id, code: revInvite.code }),
            400,
            'invalid, expired'
        );

        // Exhausted invite code (maxUses: 1 redeemed by workerM2, then attempted by workerM3)
        const singleUseInvite = await services.createOrganizationInvite(creatorA.id, { maxUses: 1, expiresInDays: 1 });
        const joinSingle = await services.joinOrganization({ userId: workerM2.id, code: singleUseInvite.code });
        assert.ok(joinSingle.success);
        assert.strictEqual(joinSingle.organization.id, baselineInst.id);

        // workerM3 attempts to redeem the same single-use code
        await expectError(
            () => services.joinOrganization({ userId: workerM3.id, code: singleUseInvite.code }),
            400,
            'invalid, expired, revoked, or already used'
        );

        // Invite code for an institution that gets unapproved/rejected later
        const tempOrg = await services.addInstitution({ name: 'Temp Org For Invite', type: 'Tech' });
        // Create invite for tempOrg by adding an admin user first
        const tempAdmin = await createUser(services, 'tempAdmin@adversary.test');
        await data.run("UPDATE users SET organizationId = ?, role = 'manager' WHERE id = ?", [tempOrg.id, tempAdmin.id]);
        await data.run("INSERT INTO organization_memberships (userId, organizationId, role, createdAt) VALUES (?, ?, 'admin', ?)", [tempAdmin.id, tempOrg.id, Date.now()]);
        const tempInvite = await services.createOrganizationInvite(tempAdmin.id, { maxUses: 2, expiresInDays: 1 });
        // Set tempOrg verificationStatus to 'rejected'
        await data.run("UPDATE institutions SET verificationStatus = 'rejected' WHERE id = ?", [tempOrg.id]);

        await expectError(
            () => services.joinOrganization({ userId: workerM3.id, code: tempInvite.code }),
            400,
            'not currently verified'
        );

        // 2.4 Missing both code and institutionId (400 rejection)
        console.log('[2.4] Missing both code and institutionId (reject with 400)');

        await expectError(() => services.joinOrganization({ userId: workerM3.id }), 400, 'either institutionid or invite code');
        await expectError(() => services.joinOrganization({ userId: workerM3.id, code: null, institutionId: null }), 400, 'either institutionid or invite code');
        await expectError(() => services.joinOrganization({ userId: workerM3.id, code: undefined, institutionId: undefined }), 400, 'either institutionid or invite code');
        await expectError(() => services.joinOrganization({ userId: workerM3.id, code: '', institutionId: '' }), 400, 'either institutionid or invite code');
        await expectError(() => services.joinOrganization({ userId: workerM3.id, code: '   ', institutionId: '   ' }), 400, 'either institutionid or invite code');

        // 2.5 Non-existent user ID (404 rejection) or missing user ID (400 rejection)
        console.log('[2.5] Non-existent user ID (404) and missing user ID (400)');

        // Missing userId
        await expectError(() => services.joinOrganization({ institutionId: baselineInst.id }), 400, 'user id is required');
        await expectError(() => services.joinOrganization({ userId: null, institutionId: baselineInst.id }), 400, 'user id is required');
        await expectError(() => services.joinOrganization({ userId: '', institutionId: baselineInst.id }), 400, 'user id is required');
        await expectError(() => services.joinOrganization({ userId: 0, institutionId: baselineInst.id }), 400, 'user id is required');

        // Non-existent userId
        await expectError(
            () => services.joinOrganization({ userId: 999999, institutionId: baselineInst.id }),
            404,
            'user not found'
        );

        const validInviteForNonExistent = await services.createOrganizationInvite(creatorA.id, { maxUses: 2, expiresInDays: 1 });
        await expectError(
            () => services.joinOrganization({ userId: 999999, code: validInviteForNonExistent.code }),
            404,
            'user not found'
        );

        // 2.6 Successful Join Verification for workerM3
        console.log('[2.6] Successful Join Verification');
        const join3 = await services.joinOrganization({ userId: workerM3.id, institutionId: baselineInst.id });
        assert.ok(join3 && join3.success);
        assert.strictEqual(join3.organization.id, baselineInst.id);

        const dbWorkerM3 = await data.get('SELECT organizationId FROM users WHERE id = ?', [workerM3.id]);
        assert.strictEqual(dbWorkerM3.organizationId, baselineInst.id);
        const memberRowM3 = await data.get('SELECT role FROM organization_memberships WHERE userId = ? AND organizationId = ?', [workerM3.id, baselineInst.id]);
        assert.strictEqual(memberRowM3.role, 'member');

        const updatesM3 = await data.all('SELECT * FROM updates WHERE organizationId = ?', [baselineInst.id]);
        assert.ok(updatesM3.some(u => u.text.includes('Joined Acme Corporation')), 'Join update must be recorded');

        // 2.7 Concurrent joinOrganization race condition test (TOCTOU)
        console.log('[2.7] Concurrent joinOrganization race condition test (TOCTOU)');
        const workerRace = await createUser(services, 'race@adversary.test');
        const orgAlt = await services.addInstitution({ name: 'Alternative Corp', type: 'Defense' });
        const raceResults = await Promise.allSettled([
            services.joinOrganization({ userId: workerRace.id, institutionId: baselineInst.id }),
            services.joinOrganization({ userId: workerRace.id, institutionId: orgAlt.id })
        ]);
        const raceFulfilled = raceResults.filter(r => r.status === 'fulfilled');
        const raceRejected = raceResults.filter(r => r.status === 'rejected');
        console.log(`  -> Concurrent joinOrganization results: ${raceFulfilled.length} fulfilled, ${raceRejected.length} rejected`);
        const membershipsForRace = await data.all('SELECT * FROM organization_memberships WHERE userId = ?', [workerRace.id]);
        console.log(`  -> Memberships in DB for workerRace: ${membershipsForRace.length}`);
        if (membershipsForRace.length > 1) {
            console.warn('  [VULNERABILITY DETECTED]: joinOrganization allows dual organization membership under concurrent requests (TOCTOU).');
        }

        console.log('PART 2 PASSED: All sequential joinOrganization challenges verified.');

        // ====================================================================
        // PART 3: HTTP ROUTE LEVEL AUTHORIZATION & VALIDATION CHALLENGES
        // ====================================================================
        console.log('\n--- PART 3: HTTP Route Level Authorization & Integration Challenges ---');

        // Capture registered route handlers from registerApiRoutes
        const routes = {};
        const mockApp = {
            use() {},
            get(path, ...handlers) { routes[`GET ${path}`] = handlers; },
            post(path, ...handlers) { routes[`POST ${path}`] = handlers; },
            patch(path, ...handlers) { routes[`PATCH ${path}`] = handlers; },
            delete(path, ...handlers) { routes[`DELETE ${path}`] = handlers; }
        };
        registerApiRoutes(mockApp, services);

        function createMockRes() {
            const res = {
                statusCode: 200,
                status(code) {
                    this.statusCode = code;
                    return this;
                },
                json(payload) {
                    this.body = payload;
                    return this;
                }
            };
            return res;
        }

        // Test 3.1: POST /api/institutions role check
        console.log('[3.1] POST /api/institutions role authorization');
        const instRouteHandlers = routes['POST /api/institutions'];
        assert.ok(instRouteHandlers && instRouteHandlers.length > 0, 'POST /api/institutions route must be registered');
        // The main handler is the last handler in the chain
        const instHandler = instRouteHandlers[instRouteHandlers.length - 1];

        // Worker tries to register an institution -> 403 Forbidden
        const reqWorker = {
            user: { id: workerM4.id, role: 'worker' },
            body: { name: 'Unauthorized Org', type: 'Tech' }
        };
        const resWorker = createMockRes();
        await instHandler(reqWorker, resWorker);
        assert.strictEqual(resWorker.statusCode, 403, 'Workers must be forbidden from creating institutions');
        assert.ok(resWorker.body.error.includes('Only managers or executives'));

        // Manager registers an institution -> 200 OK
        const reqManager = {
            user: { id: workerM4.id, role: 'manager', name: 'Manager Bob' },
            body: { name: 'Manager Registered Org', type: 'Government Agency', contact: 'manager@gov.test' }
        };
        const resManager = createMockRes();
        await instHandler(reqManager, resManager);
        assert.strictEqual(resManager.statusCode, 200, 'Managers must be allowed to register institutions');
        assert.strictEqual(resManager.body.name, 'Manager Registered Org');
        assert.strictEqual(resManager.body.verificationStatus, 'approved');

        // Duplicate registration via route handler -> 409 Conflict
        const reqDuplicate = {
            user: { id: creatorB.id, role: 'exec' },
            body: { name: '  manager registered org  ', type: 'Any' }
        };
        const resDuplicate = createMockRes();
        await instHandler(reqDuplicate, resDuplicate);
        assert.strictEqual(resDuplicate.statusCode, 409, 'Duplicate via route handler must return 409');
        assert.ok(resDuplicate.body.error.includes('already exists'));

        // Invalid input via route handler -> 400 Bad Request
        const reqInvalid = {
            user: { id: creatorB.id, role: 'exec' },
            body: { name: '', type: 'Any' }
        };
        const resInvalid = createMockRes();
        await instHandler(reqInvalid, resInvalid);
        assert.strictEqual(resInvalid.statusCode, 400, 'Invalid name via route handler must return 400');

        // Test 3.2: POST /api/users/:id/organization authorization
        console.log('[3.2] POST /api/users/:id/organization user matching & joining');
        const userOrgRouteHandlers = routes['POST /api/users/:id/organization'];
        assert.ok(userOrgRouteHandlers && userOrgRouteHandlers.length > 0, 'POST /api/users/:id/organization route must be registered');
        const userOrgHandler = userOrgRouteHandlers[userOrgRouteHandlers.length - 1];

        const unassignedWorker = await createUser(services, 'unassigned@adversary.test');

        // User A tries to join organization on behalf of User B -> 403 Forbidden
        const reqImpersonate = {
            user: { id: 9999, role: 'worker' },
            params: { id: String(unassignedWorker.id) },
            body: { institutionId: baselineInst.id }
        };
        const resImpersonate = createMockRes();
        await userOrgHandler(reqImpersonate, resImpersonate);
        assert.strictEqual(resImpersonate.statusCode, 403, 'Users cannot join organizations for other users');
        assert.ok(resImpersonate.body.error.includes('Cannot join organization for another user'));

        // User joins their own organization -> 200 OK
        const reqJoinSelf = {
            user: { id: unassignedWorker.id, role: 'worker', name: 'Unassigned Worker' },
            params: { id: String(unassignedWorker.id) },
            body: { institutionId: baselineInst.id }
        };
        const resJoinSelf = createMockRes();
        await userOrgHandler(reqJoinSelf, resJoinSelf);
        assert.strictEqual(resJoinSelf.statusCode, 200, 'User can join organization for themselves');
        assert.strictEqual(resJoinSelf.body.success, true);
        assert.strictEqual(resJoinSelf.body.organization.id, baselineInst.id);

        // User attempts duplicate join via route -> 409 Conflict
        const reqDuplicateJoin = {
            user: { id: unassignedWorker.id, role: 'worker', name: 'Unassigned Worker' },
            params: { id: String(unassignedWorker.id) },
            body: { institutionId: baselineInst.id }
        };
        const resDuplicateJoin = createMockRes();
        await userOrgHandler(reqDuplicateJoin, resDuplicateJoin);
        assert.strictEqual(resDuplicateJoin.statusCode, 409, 'Duplicate join via route must return 409');
        assert.ok(resDuplicateJoin.body.error.includes('already a member'));

        console.log('PART 3 PASSED: All HTTP route level challenges verified.');

        console.log('\n================================================================');
        console.log('ALL EMPIRICAL ADVERSARIAL CHALLENGES COMPLETED AND PASSED (100%)');
        console.log('================================================================');
    } finally {
        await data.close();
        try { fs.rmSync(process.env.ORION_DB_PATH, { force: true }); } catch (_e) {}
    }
}

run().catch((err) => {
    console.error('CHALLENGE FAILED WITH ERROR:', err);
    process.exit(1);
});
