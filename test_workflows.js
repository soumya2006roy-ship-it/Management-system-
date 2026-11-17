const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.ORION_DB_PATH = path.join(os.tmpdir(), `orion-workflows-${process.pid}.db`);
try { fs.rmSync(process.env.ORION_DB_PATH, { force: true }); } catch (_error) {}

const { BackendData } = require('./backend_data');
const { BackendServices, ApiError } = require('./backend_services');

async function expectError(work, status, text) {
    await assert.rejects(work, (error) => error instanceof ApiError && error.status === status && (!text || error.message.includes(text)));
}

async function createUser(services, email, role = 'worker') {
    const user = await services.registerUser({ email, username: email, name: email.split('@')[0], password: 'correct-horse-42', role });
    assert.strictEqual(user.role, 'worker', 'public signup must always create a worker');
    return user;
}

async function run() {
    const data = new BackendData();
    await data.init();
    const services = new BackendServices(data);
    try {
        const applicant = await createUser(services, 'owner@example.test', 'manager');
        const platformAdmin = await createUser(services, 'platform-admin@example.test');
        await data.run("UPDATE users SET role='exec' WHERE id=?", [platformAdmin.id]);
        await services.loadPlatformAdmins();
        await expectError(() => services.createPlatformAdmin(applicant.id, { email: 'blocked@example.test', name: 'Blocked', password: 'valid-password-123' }), 403, 'Platform administrator');
        const secondaryAdmin = await services.createPlatformAdmin(platformAdmin.id, { email: 'secondary-admin@example.test', name: 'Secondary Admin', password: 'valid-password-456' });
        assert.strictEqual(secondaryAdmin.isPlatformAdmin, true);
        assert.strictEqual(secondaryAdmin.password, undefined);
        assert.ok((await services.getPlatformAdmins(platformAdmin.id)).some((admin) => admin.id === secondaryAdmin.id));
        await expectError(() => services.createPlatformAdmin(platformAdmin.id, { email: 'secondary-admin@example.test', name: 'Duplicate', password: 'valid-password-456' }), 409, 'already exists');
        await expectError(() => services.registerUser({ email: 'bad-email', password: 'correct-horse-42', name: 'Bad' }), 400, 'valid email');
        await expectError(() => services.registerUser({ email: 'short@example.test', password: 'short', name: 'Short' }), 400);
        await expectError(() => services.registerUser({ email: 'owner@example.test', password: 'correct-horse-42', name: 'Duplicate' }), 409, 'already exists');

        const application = await services.submitOrganizationApplication(applicant.id, {
            legalName: 'Verified Agency Alpha', type: 'Government', officialEmail: 'contact@agency.test', contactName: 'A. Owner'
        });
        const outsider = await createUser(services, 'outsider@example.test');
        await expectError(() => services.getOrganizationApplications(outsider.id), 403);
        const decision = await services.reviewOrganizationApplication(application.id, platformAdmin.id, 'approve', 'Verified');
        assert.strictEqual(decision.status, 'approved');
        const owner = await services.getPublicUserById(applicant.id);
        assert.strictEqual(owner.role, 'manager');
        assert.strictEqual(owner.organizationId, decision.institutionId);
        assert.strictEqual(await services.isOrganizationAdmin(applicant.id, decision.institutionId), true);
        assert.strictEqual((await services.getInstitutions()).length, 1);

        const workerInvite = await services.createOrganizationInvite(applicant.id, { maxUses: 1, expiresInDays: 1 });
        const worker = await createUser(services, 'worker@example.test');
        await services.redeemOrganizationInvite(worker.id, workerInvite.code);
        const project = await services.createProject({ name: 'Alpha delivery', creatorId: applicant.id });
        const task = await services.createTask({ projectId: project.id, title: 'Deliver milestone', assignedTo: worker.id, createdBy: applicant.id });
        const subtask = await services.createSubtask(applicant.id, { parentTaskId: task.id, title: 'Complete signed package', assignedTo: worker.id, weight: 1 });
        const weightedSubtask = await services.createSubtask(applicant.id, { parentTaskId: task.id, title: 'Complete field validation', assignedTo: worker.id, weight: 3 });
        await expectError(() => services.createSubtask(worker.id, { parentTaskId: task.id, title: 'Unauthorized', assignedTo: worker.id }), 403);
        await expectError(() => services.reviewSubtask(subtask.id, applicant.id, 'approve'), 409, 'not awaiting review');
        await services.submitSubtask(subtask.id, worker.id, { submissionText: 'Package is ready.' });
        await expectError(() => services.submitSubtask(subtask.id, applicant.id, { submissionText: 'Wrong actor' }), 403);
        await expectError(() => services.submitReport({ taskId: task.id, submittedBy: worker.id, proposedProgress: 50, reportText: 'Bypass' }), 409, 'subtasks');
        await expectError(() => services.updateTaskLegacy({ taskId: task.id, progress: 100, requesterId: worker.id }), 410);
        const review = await services.reviewSubtask(subtask.id, applicant.id, 'approve', 'Accepted');
        assert.strictEqual(review.progress, 25, 'approved weight should determine partial task progress');
        assert.strictEqual(Number((await data.get('SELECT progress FROM tasks WHERE id=?', [task.id])).progress), 25);
        assert.strictEqual(Number((await data.get('SELECT progress FROM projects WHERE id=?', [project.id])).progress), 25);
        await services.submitSubtask(weightedSubtask.id, worker.id, { submissionText: 'Validation complete.' });
        const finalReview = await services.reviewSubtask(weightedSubtask.id, applicant.id, 'approve');
        assert.strictEqual(finalReview.progress, 100);
        assert.strictEqual(Number((await data.get('SELECT progress FROM projects WHERE id=?', [project.id])).progress), 100);
        await expectError(() => services.reviewSubtask(subtask.id, applicant.id, 'approve'), 409);

        const invite = await services.createOrganizationInvite(applicant.id, { maxUses: 1, expiresInDays: 1 });
        const inviteWorker = await createUser(services, 'invitee@example.test');
        const joined = await services.redeemOrganizationInvite(inviteWorker.id, invite.code);
        assert.strictEqual(joined.organization.id, decision.institutionId);
        await expectError(() => services.redeemOrganizationInvite(inviteWorker.id, invite.code), 409, 'already belong');
        const secondInvite = await services.createOrganizationInvite(applicant.id, { maxUses: 1, expiresInDays: 1 });
        const thirdWorker = await createUser(services, 'third@example.test');
        await data.run('UPDATE organization_invites SET expiresAt=? WHERE codeHash=?', [Date.now() - 1, require('crypto').createHash('sha256').update(secondInvite.code).digest('hex')]);
        await expectError(() => services.redeemOrganizationInvite(thirdWorker.id, secondInvite.code), 400, 'invalid, expired');
        const revokedInvite = await services.createOrganizationInvite(applicant.id, { maxUses: 2, expiresInDays: 1 });
        await expectError(() => services.revokeOrganizationInvite(worker.id, revokedInvite.inviteId), 403, 'administrator');
        await services.revokeOrganizationInvite(applicant.id, revokedInvite.inviteId);
        const fourthWorker = await createUser(services, 'fourth@example.test');
        await expectError(() => services.redeemOrganizationInvite(fourthWorker.id, revokedInvite.code), 400, 'invalid, expired');

        const secondOwner = await createUser(services, 'owner-two@example.test');
        const appTwo = await services.submitOrganizationApplication(secondOwner.id, { legalName: 'Verified Agency Beta', type: 'Public agency', officialEmail: 'contact@agency-two.test', contactName: 'B. Owner' });
        await services.reviewOrganizationApplication(appTwo.id, platformAdmin.id, 'approve');
        const betaProject = await services.createProject({ name: 'Beta confidential', creatorId: secondOwner.id });
        await expectError(() => services.createTask({ projectId: betaProject.id, title: 'Cross tenant assignment', assignedTo: worker.id, createdBy: secondOwner.id }), 403, 'another organization');
        const alphaDashboard = await services.getDashboard(applicant.id);
        assert(!alphaDashboard.projects.some((row) => row.id === betaProject.id), 'tenant dashboard must not include other organization projects');
        await expectError(() => services.createOrganizationInvite(worker.id, {}), 403, 'administrator');

        const legacyApplicant = await createUser(services, 'legacy-owner@example.test');
        const legacyInstitution = await data.run("INSERT INTO institutions (name,type,contact,verificationStatus) VALUES ('Legacy Agency','Government','legacy@example.test','unverified')");
        const legacyApplication = await services.submitOrganizationApplication(legacyApplicant.id, { legalName: 'Legacy Agency', type: 'Government', officialEmail: 'legacy@example.test', contactName: 'Legacy Owner' });
        const legacyApproval = await services.reviewOrganizationApplication(legacyApplication.id, platformAdmin.id, 'approve');
        assert.strictEqual(legacyApproval.institutionId, legacyInstitution.lastID, 'verification should reuse the legacy institution record');
        assert.strictEqual((await data.get('SELECT verificationStatus FROM institutions WHERE id=?', [legacyInstitution.lastID])).verificationStatus, 'approved');

        const bucket = `workflow-${process.pid}`;
        assert.strictEqual((await services.consumeRateLimit(bucket, 2, 60000)).allowed, true);
        assert.strictEqual((await services.consumeRateLimit(bucket, 2, 60000)).allowed, true);
        const limited = await services.consumeRateLimit(bucket, 2, 60000);
        assert.strictEqual(limited.allowed, false);
        assert.ok(limited.retryAfter > 0);
        console.log('Workflow tests passed: verification, invites, subtasks, approvals, isolation, validation, and rate limits.');
    } finally {
        await data.close();
        try { fs.rmSync(process.env.ORION_DB_PATH, { force: true }); } catch (_error) {}
    }
}

run().catch((error) => {
    console.error('Workflow test failed:', error);
    process.exit(1);
});
