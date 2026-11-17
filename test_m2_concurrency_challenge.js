const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

process.env.ORION_DB_PATH = path.join(os.tmpdir(), `orion-m2-concurrency-${process.pid}.db`);
try { fs.rmSync(process.env.ORION_DB_PATH, { force: true }); } catch (_error) {}

const { BackendData } = require('./backend_data');
const { BackendServices, ApiError } = require('./backend_services');

async function createUser(services, email, role = 'worker', organizationId = null) {
    const user = await services.registerUser({
        email,
        username: email,
        name: email.split('@')[0],
        password: 'challenge-password-123!',
        role
    });
    if (organizationId) {
        await services.data.run('UPDATE users SET organizationId = ? WHERE id = ?', [organizationId, user.id]);
        await services.data.run(
            "INSERT OR REPLACE INTO organization_memberships (userId, organizationId, role, createdAt) VALUES (?, ?, ?, ?)",
            [user.id, organizationId, role === 'manager' ? 'admin' : 'member', Date.now()]
        );
        user.organizationId = organizationId;
    }
    return user;
}

async function run() {
    console.log('=== EMPIRICAL CHALLENGE SUITE (challenger_m2_2) ===');
    console.log('Target: Concurrency, Multi-Tenant Isolation, Activity Logging, and Regressions');

    const data = new BackendData();
    await data.init();
    const services = new BackendServices(data);

    let failures = [];

    // =========================================================================
    // 1. Concurrency: Concurrent join attempts by same user to two institutions
    // =========================================================================
    console.log('\n--- Challenge 1: Concurrency - Concurrent Join Attempts by Same User ---');
    try {
        const joinWorker = await createUser(services, 'concurrent_joiner@test.org');
        const instA = await services.addInstitution({
            name: 'Alpha Concurrency Corp',
            type: 'Research',
            contact: 'alpha@test.org'
        });
        const instB = await services.addInstitution({
            name: 'Beta Concurrency Corp',
            type: 'Defense',
            contact: 'beta@test.org'
        });

        console.log(`Triggering concurrent joinOrganization for userId ${joinWorker.id} to Inst A (${instA.id}) and Inst B (${instB.id})...`);
        const joinPromises = [
            services.joinOrganization({ userId: joinWorker.id, institutionId: instA.id }),
            services.joinOrganization({ userId: joinWorker.id, institutionId: instB.id })
        ];

        const joinResults = await Promise.allSettled(joinPromises);
        console.log('Join Results:');
        joinResults.forEach((res, i) => {
            if (res.status === 'fulfilled') {
                console.log(`  Call ${i + 1} SUCCESS:`, res.value);
            } else {
                console.log(`  Call ${i + 1} REJECTED:`, res.reason ? `${res.reason.status}: ${res.reason.message}` : res.reason);
            }
        });

        const successes = joinResults.filter(r => r.status === 'fulfilled');
        const conflicts = joinResults.filter(r => r.status === 'rejected' && r.reason instanceof ApiError && r.reason.status === 409);

        // Check DB state for memberships
        const memberships = await data.all('SELECT * FROM organization_memberships WHERE userId = ?', [joinWorker.id]);
        const userRow = await data.get('SELECT id, organizationId FROM users WHERE id = ?', [joinWorker.id]);
        console.log('DB State after concurrent joins:');
        console.log('  user.organizationId:', userRow.organizationId);
        console.log('  memberships count:', memberships.length, memberships);

        if (successes.length === 1 && conflicts.length === 1 && memberships.length === 1) {
            console.log('  [PASS] Exactly one succeeded and one failed with 409 conflict. Single membership preserved.');
        } else {
            const bugMsg = `CONCURRENCY BUG: Concurrent join allowed ${successes.length} successes, ${conflicts.length} 409s, resulting in ${memberships.length} memberships!`;
            console.error(`  [FAIL] ${bugMsg}`);
            failures.push({
                challenge: '1. Concurrent joinOrganization race condition',
                details: bugMsg,
                memberships,
                userRow
            });
        }
    } catch (err) {
        console.error('Unexpected error in Challenge 1:', err);
        failures.push({ challenge: '1. Concurrent joinOrganization crashed', error: err.message });
    }

    // =========================================================================
    // 2. Concurrency: Concurrent institution creations with identical names
    // =========================================================================
    console.log('\n--- Challenge 2: Concurrency - Concurrent Institution Creation with Identical Names ---');
    try {
        const creatorA = await createUser(services, 'creatorA@test.org');
        const creatorB = await createUser(services, 'creatorB@test.org');
        const duplicateName = 'Unique Aerospace Initiative';

        console.log(`Triggering concurrent addInstitution with identical name: "${duplicateName}"...`);
        const createPromises = [
            services.addInstitution({ name: duplicateName, type: 'Aerospace', contact: 'a@test.org', creatorId: creatorA.id }),
            services.addInstitution({ name: duplicateName, type: 'Aerospace', contact: 'b@test.org', creatorId: creatorB.id })
        ];

        const createResults = await Promise.allSettled(createPromises);
        console.log('Creation Results:');
        createResults.forEach((res, i) => {
            if (res.status === 'fulfilled') {
                console.log(`  Call ${i + 1} SUCCESS: id=${res.value.id}, name="${res.value.name}"`);
            } else {
                console.log(`  Call ${i + 1} REJECTED:`, res.reason ? `${res.reason.status}: ${res.reason.message}` : res.reason);
            }
        });

        const successes = createResults.filter(r => r.status === 'fulfilled');
        const conflicts = createResults.filter(r => r.status === 'rejected' && r.reason instanceof ApiError && r.reason.status === 409);

        const institutionsInDb = await data.all('SELECT * FROM institutions WHERE lower(name) = lower(?)', [duplicateName]);
        console.log('DB State after concurrent creations:');
        console.log('  Institutions matching name in DB:', institutionsInDb.length, institutionsInDb.map(i => ({ id: i.id, name: i.name })));

        if (successes.length === 1 && conflicts.length === 1 && institutionsInDb.length === 1) {
            console.log('  [PASS] Exactly one creation succeeded and second failed with 409. Single institution in DB.');
        } else {
            const bugMsg = `CONCURRENCY BUG: Concurrent addInstitution allowed ${successes.length} successes, ${conflicts.length} 409s, resulting in ${institutionsInDb.length} institutions in DB!`;
            console.error(`  [FAIL] ${bugMsg}`);
            failures.push({
                challenge: '2. Concurrent addInstitution race condition',
                details: bugMsg,
                institutionsCount: institutionsInDb.length
            });
        }
    } catch (err) {
        console.error('Unexpected error in Challenge 2:', err);
        failures.push({ challenge: '2. Concurrent addInstitution crashed', error: err.message });
    }

    // =========================================================================
    // 3. Multi-Tenant Isolation
    // =========================================================================
    console.log('\n--- Challenge 3: Multi-Tenant Isolation Verification ---');
    try {
        const managerA = await createUser(services, 'managerA@orgA.test', 'manager');
        const instA = await services.addInstitution({
            name: 'Organization A Corp',
            type: 'Gov',
            contact: 'admin@orga.test',
            creatorId: managerA.id
        });

        const managerB = await createUser(services, 'managerB@orgB.test', 'manager');
        const instB = await services.addInstitution({
            name: 'Organization B Corp',
            type: 'Gov',
            contact: 'admin@orgb.test',
            creatorId: managerB.id
        });

        const workerA = await createUser(services, 'workerA@orgA.test', 'worker');
        await services.joinOrganization({ userId: workerA.id, institutionId: instA.id });

        const workerB = await createUser(services, 'workerB@orgB.test', 'worker');
        await services.joinOrganization({ userId: workerB.id, institutionId: instB.id });

        // Create Project and Task in Org B
        const projB = await services.createProject({
            name: 'Classified Project B',
            creatorId: managerB.id
        });
        const taskB = await services.createTask({
            projectId: projB.id,
            title: 'Top Secret B Task',
            description: 'Org B confidential',
            priority: 'urgent',
            assignedTo: workerB.id,
            createdBy: managerB.id
        });

        // 3.1: Manager A attempts to reassign Task B -> must 403
        let crossReassignBlocked = false;
        try {
            await services.reassignTask({
                taskId: taskB.id,
                newAssigneeId: workerA.id,
                requesterId: managerA.id
            });
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) {
                crossReassignBlocked = true;
            }
        }

        // 3.2: Manager B attempts to reassign Task B to workerA (who belongs to Org A) -> must 403
        let crossOrgAssigneeBlocked = false;
        try {
            await services.reassignTask({
                taskId: taskB.id,
                newAssigneeId: workerA.id,
                requesterId: managerB.id
            });
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) {
                crossOrgAssigneeBlocked = true;
            }
        }

        // 3.3: Worker A attempts to view subtasks of Task B -> must 403
        let crossSubtaskViewBlocked = false;
        try {
            await services.getSubtasks(taskB.id, workerA.id);
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) {
                crossSubtaskViewBlocked = true;
            }
        }

        // 3.4: Manager A attempts to create invite for Org B -> must be scoped to Org A only
        let crossInviteCreateBlocked = false;
        try {
            await services.createOrganizationInvite(managerA.id, { maxUses: 5 });
            const invitesA = await services.getOrganizationInvites(managerA.id);
            const crossOrgInvite = invitesA.some(inv => inv.organizationId === instB.id);
            crossInviteCreateBlocked = !crossOrgInvite;
        } catch (err) {
            crossInviteCreateBlocked = true;
        }

        // 3.5: Worker A attempts to join Org B when already in Org A -> must 409
        let doubleJoinBlocked = false;
        try {
            await services.joinOrganization({ userId: workerA.id, institutionId: instB.id });
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
                doubleJoinBlocked = true;
            }
        }

        console.log('Tenant Isolation Checks:');
        console.log('  Cross-org reassign by unauthorized manager blocked (403):', crossReassignBlocked);
        console.log('  Reassign to worker of different org blocked (403):', crossOrgAssigneeBlocked);
        console.log('  Cross-org subtask view blocked (403):', crossSubtaskViewBlocked);
        console.log('  Cross-org invite leakage prevented:', crossInviteCreateBlocked);
        console.log('  Already-joined worker joining another org blocked (409):', doubleJoinBlocked);

        if (crossReassignBlocked && crossOrgAssigneeBlocked && crossSubtaskViewBlocked && crossInviteCreateBlocked && doubleJoinBlocked) {
            console.log('  [PASS] Multi-tenant isolation is strictly maintained across organizations.');
        } else {
            const bugMsg = `TENANT ISOLATION LEAK: ${JSON.stringify({ crossReassignBlocked, crossOrgAssigneeBlocked, crossSubtaskViewBlocked, crossInviteCreateBlocked, doubleJoinBlocked })}`;
            console.error(`  [FAIL] ${bugMsg}`);
            failures.push({ challenge: '3. Multi-tenant isolation breach', details: bugMsg });
        }
    } catch (err) {
        console.error('Unexpected error in Challenge 3:', err);
        failures.push({ challenge: '3. Multi-tenant isolation crashed', error: err.message });
    }

    // =========================================================================
    // 4. Audit & Activity Logging in `updates` Table
    // =========================================================================
    console.log('\n--- Challenge 4: Audit & Activity Logging in updates Table ---');
    try {
        const auditCreator = await createUser(services, 'audit_creator@test.org');
        const auditInst = await services.addInstitution({
            name: 'Audit Sentinel Institute',
            type: 'Audit',
            contact: 'sentinel@test.org',
            creatorId: auditCreator.id
        });

        // Check updates table for addInstitution
        const instUpdates = await data.all('SELECT * FROM updates WHERE organizationId = ?', [auditInst.id]);
        console.log(`Updates found for organizationId ${auditInst.id}:`, instUpdates);

        const instCreationLogged = instUpdates.some(u =>
            u.author === auditCreator.name &&
            u.text.includes('Registered institution "Audit Sentinel Institute"')
        );
        console.log('  Institution registration update logged correctly:', instCreationLogged);

        // Check join event logging
        const auditJoiner = await createUser(services, 'audit_joiner@test.org');
        await services.joinOrganization({ userId: auditJoiner.id, institutionId: auditInst.id });

        const updatedInstUpdates = await data.all('SELECT * FROM updates WHERE organizationId = ?', [auditInst.id]);
        console.log(`Updated updates found for organizationId ${auditInst.id}:`, updatedInstUpdates);

        const joinLogged = updatedInstUpdates.some(u =>
            u.author === auditJoiner.name &&
            u.text.includes(`Joined ${auditInst.name}`)
        );
        console.log('  Join organization update logged correctly:', joinLogged);

        if (instCreationLogged && joinLogged) {
            console.log('  [PASS] Activity logging in updates table verified for institution registration and member join.');
        } else {
            const bugMsg = `ACTIVITY LOGGING DEFICIENCY: instCreationLogged=${instCreationLogged}, joinLogged=${joinLogged}`;
            console.error(`  [FAIL] ${bugMsg}`);
            failures.push({ challenge: '4. Activity logging verification failure', details: bugMsg });
        }
    } catch (err) {
        console.error('Unexpected error in Challenge 4:', err);
        failures.push({ challenge: '4. Activity logging crashed', error: err.message });
    }

    // =========================================================================
    // 5. Regression Tests (Issue 1 Task CRUD & Workflows)
    // =========================================================================
    console.log('\n--- Challenge 5: Regression Testing (Task CRUD & Workflows) ---');
    try {
        console.log('Running Task CRUD regression...');
        execSync('node test_tasks_crud.js', { stdio: 'pipe' });
        console.log('  [PASS] Task CRUD tests pass cleanly.');

        console.log('Running Stubs regression...');
        execSync('node test_stubs.js', { stdio: 'pipe' });
        console.log('  [PASS] Stubs tests pass cleanly.');

        console.log('Running Workflows regression...');
        execSync('node test_workflows.js', { stdio: 'pipe' });
        console.log('  [PASS] Workflow tests pass cleanly.');

        console.log('Running Security regression...');
        execSync('node test_security.js', { stdio: 'pipe' });
        console.log('  [PASS] Security tests pass cleanly.');

        console.log('Running Config regression...');
        execSync('node test_config.js', { stdio: 'pipe' });
        console.log('  [PASS] Config tests pass cleanly.');
    } catch (regErr) {
        console.error('  [FAIL] Regression failure:', regErr.message);
        failures.push({ challenge: '5. Regression suite failure', error: regErr.message });
    }

    console.log('\n=== EMPIRICAL CHALLENGE SUMMARY ===');
    console.log(`Total failures detected: ${failures.length}`);
    if (failures.length > 0) {
        console.log('Detected Failures:');
        console.log(JSON.stringify(failures, null, 2));
    } else {
        console.log('ALL EMPIRICAL CHALLENGES PASSED!');
    }

    await data.close();
    try { fs.rmSync(process.env.ORION_DB_PATH, { force: true }); } catch (_e) {}

    return failures;
}

run()
    .then(failures => {
        if (failures.length > 0) {
            process.exit(1);
        } else {
            process.exit(0);
        }
    })
    .catch(err => {
        console.error('Fatal challenge runner error:', err);
        process.exit(1);
    });
