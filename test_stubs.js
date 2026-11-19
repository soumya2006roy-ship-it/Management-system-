const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.ORION_DB_PATH = path.join(os.tmpdir(), `orion-stubs-test-${process.pid}.db`);
try { fs.rmSync(process.env.ORION_DB_PATH, { force: true }); } catch (_error) {}

const { BackendData } = require('./backend_data');
const { BackendServices, ApiError } = require('./backend_services');

async function expectError(work, status, text) {
    await assert.rejects(work, (error) => {
        const matchesStatus = error instanceof ApiError && error.status === status;
        const matchesText = !text || (error.message && error.message.toLowerCase().includes(text.toLowerCase()));
        if (!matchesStatus || !matchesText) {
            console.error('Unexpected error:', error);
        }
        return matchesStatus && matchesText;
    }, `Expected ApiError with status ${status}${text ? ` matching "${text}"` : ''}`);
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
    const data = new BackendData();
    await data.init();
    const services = new BackendServices(data);

    try {
        console.log('--- TEST SUITE: Backend Stubs Unstubbing (Issue 2) ---');

        // Setup base users
        const creator1 = await createUser(services, 'founder@agency.test');
        const worker1 = await createUser(services, 'worker1@agency.test');
        const worker2 = await createUser(services, 'worker2@agency.test');
        const worker3 = await createUser(services, 'worker3@agency.test');
        const worker4 = await createUser(services, 'worker4@agency.test');

        // ==========================================
        // 1. addInstitution: Success
        // ==========================================
        console.log('--- Test 1: addInstitution Success (creator becomes admin/manager, approved institution created) ---');
        const inst1 = await services.addInstitution({
            name: 'National Space Agency',
            type: 'Government',
            contact: 'contact@nsa.gov',
            creatorId: creator1.id
        });

        assert.ok(inst1 && inst1.id, 'Institution ID should be returned');
        assert.strictEqual(inst1.name, 'National Space Agency');
        assert.strictEqual(inst1.type, 'Government');
        assert.strictEqual(inst1.contact, 'contact@nsa.gov');
        assert.strictEqual(inst1.verificationStatus, 'approved');

        // Verify creator user was updated to role='manager' and organizationId=inst1.id
        const updatedCreator = await data.get('SELECT id, name, role, organizationId FROM users WHERE id = ?', [creator1.id]);
        assert.strictEqual(updatedCreator.role, 'manager', 'Creator role should be updated to manager');
        assert.strictEqual(updatedCreator.organizationId, inst1.id, 'Creator organizationId should match institution ID');

        // Verify organization_memberships record
        const creatorMembership = await data.get('SELECT * FROM organization_memberships WHERE userId = ? AND organizationId = ?', [creator1.id, inst1.id]);
        assert.ok(creatorMembership, 'Creator membership must exist in organization_memberships');
        assert.strictEqual(creatorMembership.role, 'admin', 'Creator membership role must be admin');

        // Verify activity log
        const updates = await data.all('SELECT * FROM updates WHERE organizationId = ?', [inst1.id]);
        assert.ok(updates.some(u => u.text.includes('Registered institution "National Space Agency"')), 'Activity log must record institution registration');

        // addInstitution without creatorId
        const instNoCreator = await services.addInstitution({
            name: 'Autonomous Research Institute',
            type: 'Research Institute',
            contact: 'contact@ari.org'
        });
        assert.ok(instNoCreator && instNoCreator.id);
        assert.strictEqual(instNoCreator.verificationStatus, 'approved');

        // ==========================================
        // 2. addInstitution: Duplicate Name (409)
        // ==========================================
        console.log('--- Test 2: addInstitution Duplicate Name Rejection (409) ---');
        // Exact duplicate
        await expectError(
            () => services.addInstitution({ name: 'National Space Agency', type: 'Public agency' }),
            409,
            'already exists'
        );

        // Case-insensitive duplicate
        await expectError(
            () => services.addInstitution({ name: 'national space agency', type: 'Defence' }),
            409,
            'already exists'
        );

        // Duplicate with leading/trailing whitespace
        await expectError(
            () => services.addInstitution({ name: '  National Space Agency  ', type: 'Contractor' }),
            409,
            'already exists'
        );

        // ==========================================
        // 3. addInstitution: Invalid Input (400)
        // ==========================================
        console.log('--- Test 3: addInstitution Invalid Input (400) ---');
        // Missing name
        await expectError(() => services.addInstitution({ type: 'Government' }), 400, 'name is required');
        // Empty name
        await expectError(() => services.addInstitution({ name: '   ', type: 'Government' }), 400, 'name is required');
        // Name too long (>200)
        await expectError(() => services.addInstitution({ name: 'A'.repeat(201), type: 'Government' }), 400, '200 characters');
        // Missing type
        await expectError(() => services.addInstitution({ name: 'Valid Name' }), 400, 'type is required');
        // Empty type
        await expectError(() => services.addInstitution({ name: 'Valid Name', type: '   ' }), 400, 'type is required');
        // Type too long (>100)
        await expectError(() => services.addInstitution({ name: 'Valid Name', type: 'T'.repeat(101) }), 400, '100 characters');
        // Contact too long (>254)
        await expectError(() => services.addInstitution({ name: 'Valid Name', type: 'Gov', contact: 'C'.repeat(255) }), 400, '254 characters');

        // ==========================================
        // 4. joinOrganization: Success via Invite Code
        // ==========================================
        console.log('--- Test 4: joinOrganization Success via Invite Code ---');
        const invite = await services.createOrganizationInvite(creator1.id, { maxUses: 2, expiresInDays: 7 });
        assert.ok(invite && invite.code, 'Invite code must be generated');

        const joinCodeResult = await services.joinOrganization({
            userId: worker1.id,
            code: invite.code
        });
        assert.ok(joinCodeResult && joinCodeResult.success);
        assert.strictEqual(joinCodeResult.organization.id, inst1.id);
        assert.strictEqual(joinCodeResult.organization.name, 'National Space Agency');

        // Verify worker1 DB state
        const updatedWorker1 = await data.get('SELECT organizationId FROM users WHERE id = ?', [worker1.id]);
        assert.strictEqual(updatedWorker1.organizationId, inst1.id);
        const worker1Membership = await data.get('SELECT role FROM organization_memberships WHERE userId = ? AND organizationId = ?', [worker1.id, inst1.id]);
        assert.ok(worker1Membership && worker1Membership.role === 'member');

        // ==========================================
        // 5. joinOrganization: Rejection via institutionId (SEC-01) & Success via Invite Code
        // ==========================================
        console.log('--- Test 5: joinOrganization Rejection via institutionId (SEC-01) ---');
        await expectError(
            () => services.joinOrganization({ userId: worker2.id, institutionId: inst1.id }),
            400,
            'invitation code'
        );
        const invite2 = await services.createOrganizationInvite(creator1.id, {
            organizationId: inst1.id,
            maxUses: 1,
            expiresInHours: 24
        });
        const joinIdResult = await services.joinOrganization({
            userId: worker2.id,
            code: invite2.code
        });
        assert.ok(joinIdResult && joinIdResult.success);
        assert.strictEqual(joinIdResult.organization.id, inst1.id);
        assert.strictEqual(joinIdResult.organization.name, 'National Space Agency');

        // Verify worker2 DB state
        const updatedWorker2 = await data.get('SELECT organizationId FROM users WHERE id = ?', [worker2.id]);
        assert.strictEqual(updatedWorker2.organizationId, inst1.id);
        const worker2Membership = await data.get('SELECT role FROM organization_memberships WHERE userId = ? AND organizationId = ?', [worker2.id, inst1.id]);
        assert.ok(worker2Membership && worker2Membership.role === 'member');

        // Verify activity log for join
        const joinUpdates = await data.all('SELECT * FROM updates WHERE organizationId = ?', [inst1.id]);
        assert.ok(joinUpdates.some(u => u.text.includes('Joined National Space Agency')), 'Activity log must record join event');

        // ==========================================
        // 6. joinOrganization: Duplicate Membership Rejection (409)
        // ==========================================
        console.log('--- Test 6: joinOrganization Duplicate Membership Rejection (409) ---');
        // Worker1 is already in NSA; try joining again via institutionId
        await expectError(
            () => services.joinOrganization({ userId: worker1.id, institutionId: inst1.id }),
            409,
            'already a member'
        );

        // Worker1 tries to join another institution via code
        await expectError(
            () => services.joinOrganization({ userId: worker1.id, code: invite.code }),
            409,
            'already a member'
        );

        // Worker2 is already in NSA; try joining Autonomous Research Institute
        await expectError(
            () => services.joinOrganization({ userId: worker2.id, institutionId: instNoCreator.id }),
            409,
            'already a member'
        );

        // ==========================================
        // 7. joinOrganization: Expired, Revoked, and Invalid Code Handling (400)
        // ==========================================
        console.log('--- Test 7: joinOrganization Expired/Revoked/Invalid Code Handling (400) ---');
        // Expired code
        const expiredInvite = await services.createOrganizationInvite(creator1.id, { maxUses: 1, expiresInDays: 1 });
        const crypto = require('crypto');
        const expiredHash = crypto.createHash('sha256').update(expiredInvite.code).digest('hex');
        await data.run('UPDATE organization_invites SET expiresAt = ? WHERE codeHash = ?', [Date.now() - 1000, expiredHash]);

        await expectError(
            () => services.joinOrganization({ userId: worker3.id, code: expiredInvite.code }),
            400,
            'invalid, expired'
        );

        // Revoked code
        const revokedInvite = await services.createOrganizationInvite(creator1.id, { maxUses: 1, expiresInDays: 1 });
        await services.revokeOrganizationInvite(creator1.id, revokedInvite.inviteId);
        await expectError(
            () => services.joinOrganization({ userId: worker3.id, code: revokedInvite.code }),
            400,
            'invalid, expired'
        );

        // Invalid code format
        await expectError(
            () => services.joinOrganization({ userId: worker3.id, code: 'short' }),
            400,
            'valid invite code'
        );

        // Non-existent invite code
        await expectError(
            () => services.joinOrganization({ userId: worker3.id, code: 'x'.repeat(30) }),
            400,
            'invalid, expired'
        );

        // ==========================================
        // 8. joinOrganization: Rejection of institutionId (SEC-01)
        // ==========================================
        console.log('--- Test 8: joinOrganization Rejection of institutionId (SEC-01) ---');
        // Any attempt to join via institutionId without a code is rejected
        await expectError(
            () => services.joinOrganization({ userId: worker3.id, institutionId: 999999 }),
            400,
            'invitation code'
        );

        await expectError(
            () => services.joinOrganization({ userId: worker3.id, institutionId: 'invalid' }),
            400,
            'invitation code'
        );

        // ==========================================
        // 9. joinOrganization: Missing Input / User (400, 404)
        // ==========================================
        console.log('--- Test 9: joinOrganization Missing User or Input (400, 404) ---');
        // Missing userId
        await expectError(
            () => services.joinOrganization({ code: invite.code }),
            400,
            'user id is required'
        );

        // Non-existent user
        await expectError(
            () => services.joinOrganization({ userId: 999999, code: invite.code }),
            404,
            'user not found'
        );

        // Neither code nor institutionId provided
        await expectError(
            () => services.joinOrganization({ userId: worker3.id }),
            400,
            'invitation code is required'
        );

        // Worker3 now successfully joins Autonomous Research Institute via invite code
        const inst3Admin = await services.registerUser({
            username: 'inst3_admin',
            password: 'Password123!',
            name: 'Inst 3 Admin',
            role: 'manager'
        });
        await data.run('UPDATE users SET organizationId = ? WHERE id = ?', [instNoCreator.id, inst3Admin.id]);
        await data.run("INSERT INTO organization_memberships (userId, organizationId, role, createdAt) VALUES (?, ?, 'admin', ?)", [inst3Admin.id, instNoCreator.id, Date.now()]);

        const invite3 = await services.createOrganizationInvite(inst3Admin.id, {
            organizationId: instNoCreator.id,
            maxUses: 1,
            expiresInHours: 24
        });
        const worker3Join = await services.joinOrganization({ userId: worker3.id, code: invite3.code });
        assert.ok(worker3Join.success);
        assert.strictEqual(worker3Join.organization.id, instNoCreator.id);

        console.log('ALL BACKEND STUB UNSTUBBING TESTS PASSED SUCCESSFULLY!');
    } finally {
        await data.close();
        try { fs.rmSync(process.env.ORION_DB_PATH, { force: true }); } catch (_e) {}
    }
}

run().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
