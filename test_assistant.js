const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `test_assistant_${process.pid}.db`);
process.env.ORION_DB_PATH = testDbPath;
try { fs.rmSync(testDbPath, { force: true }); } catch (_error) {}

const { BackendData } = require('./backend_data');
const { BackendServices, ApiError } = require('./backend_services');

async function runAssistantTests() {
    console.log('=== STARTING AI ASSISTANT TEST SUITE (Issue 4) ===\n');

    const db = new BackendData();
    await db.init();
    const services = new BackendServices(db);

    // Setup Manager & Organizations
    const managerVikram = await services.registerUser({
        name: 'Vikram Sarabhai',
        email: 'vikram@isro.test',
        username: 'vikram_mgr',
        password: 'Password123!',
        role: 'manager'
    });

    const isroInst = await services.addInstitution({
        name: 'ISRO Test Space Org',
        type: 'Autonomous Body',
        contact: 'contact@isro.test',
        creatorId: managerVikram.id
    });
    const isro = isroInst.id;

    const outsideManager = await services.registerUser({
        name: 'DRDO Director',
        email: 'director@drdo.test',
        username: 'drdo_dir',
        password: 'Password123!',
        role: 'manager'
    });

    const drdoInst = await services.addInstitution({
        name: 'DRDO Test Defense Org',
        type: 'R&D',
        contact: 'contact@drdo.test',
        creatorId: outsideManager.id
    });
    const drdo = drdoInst.id;

    // Setup Workers
    const workerPriya = await services.registerUser({
        name: 'Priya Sharma',
        email: 'priya@isro.test',
        username: 'priya_worker',
        password: 'Password123!',
        role: 'worker'
    });
    await db.run('UPDATE users SET organizationId = ? WHERE id = ?', [isro, workerPriya.id]);

    const workerRohan = await services.registerUser({
        name: 'Rohan Verma',
        email: 'rohan@isro.test',
        username: 'rohan_worker',
        password: 'Password123!',
        role: 'worker'
    });
    await db.run('UPDATE users SET organizationId = ? WHERE id = ?', [isro, workerRohan.id]);

    const outsideUser = await services.registerUser({
        name: 'External Defense Officer',
        email: 'officer@drdo.test',
        username: 'drdo_officer',
        password: 'Password123!',
        role: 'worker'
    });
    await db.run('UPDATE users SET organizationId = ? WHERE id = ?', [drdo, outsideUser.id]);

    // Setup Project in ISRO
    const project = await services.createProject({
        name: 'Chandrayaan-4 Lunar Lander',
        creatorId: managerVikram.id
    });

    const now = Date.now();
    const pastDeadline = now - 5 * 24 * 60 * 60 * 1000; // 5 days ago
    const futureDeadline = now + 10 * 24 * 60 * 60 * 1000; // 10 days in future

    // Setup Tasks
    // Task 1: Overdue, assigned to Rohan
    const task1 = await services.createTask({
        projectId: project.id,
        title: 'Design Propulsion Stage',
        description: 'Propulsion mechanics calibration',
        assignedTo: workerRohan.id,
        deadline: pastDeadline,
        priority: 'high',
        createdBy: managerVikram.id
    });

    // Task 2: Overdue, assigned to Priya
    const task2 = await services.createTask({
        projectId: project.id,
        title: 'Payload Thermal Shielding',
        description: 'Testing heat tiles under extreme conditions',
        assignedTo: workerPriya.id,
        deadline: pastDeadline,
        priority: 'urgent',
        createdBy: managerVikram.id
    });

    // Task 3: On schedule (future), assigned to Priya
    const task3 = await services.createTask({
        projectId: project.id,
        title: 'Solar Array Deployment Check',
        description: 'Electrical and mechanical deployment',
        assignedTo: workerPriya.id,
        deadline: futureDeadline,
        priority: 'normal',
        createdBy: managerVikram.id
    });

    // -------------------------------------------------------------
    // Test 4.1: Query Overdue Tasks via Assistant ("Which tasks are overdue in Chandrayaan-4?")
    // -------------------------------------------------------------
    console.log('--- Test 4.1: Overdue Tasks Query ---');
    const overdueQuery = await services.assistantChat(managerVikram.id, {
        message: 'Which tasks are overdue in Chandrayaan-4?',
        projectId: project.id
    });

    assert.ok(overdueQuery && overdueQuery.text, 'Assistant should return a textual response');
    console.log('[Assistant Reply]:\n' + overdueQuery.text);
    assert.ok(overdueQuery.text.includes('Design Propulsion Stage'), 'Should list Task 1 as overdue');
    assert.ok(overdueQuery.text.includes('Payload Thermal Shielding'), 'Should list Task 2 as overdue');
    assert.ok(!overdueQuery.text.includes('Solar Array Deployment Check'), 'Should NOT list Task 3 (not overdue)');
    console.log('[PASS] Overdue tasks query returned real database records correctly.\n');

    // -------------------------------------------------------------
    // Test 4.2: Propose Reassigning Task ("Reassign task <id> to Priya")
    // -------------------------------------------------------------
    console.log('--- Test 4.2: Destructive Action Confirmation Proposal ---');
    const reassignPrompt = `Reassign task ${task1.id} to Priya`;
    const reassignResponse = await services.assistantChat(managerVikram.id, {
        message: reassignPrompt,
        projectId: project.id
    });

    assert.ok(reassignResponse.proposal, 'Assistant must return an action confirmation proposal');
    assert.strictEqual(reassignResponse.proposal.type, 'reassign_task');
    assert.strictEqual(reassignResponse.proposal.taskId, task1.id);
    assert.strictEqual(reassignResponse.proposal.newAssigneeId, workerPriya.id);

    // Verify task is NOT yet reassigned before confirmation
    const taskBeforeConfirm = await db.get('SELECT assignedTo FROM tasks WHERE id = ?', [task1.id]);
    assert.strictEqual(taskBeforeConfirm.assignedTo, workerRohan.id, 'Task must not be reassigned before confirmation');
    console.log('[PASS] Assistant properly requested confirmation before executing reassign.\n');

    // -------------------------------------------------------------
    // Test 4.3: Execute Confirmed Reassign Action
    // -------------------------------------------------------------
    console.log('--- Test 4.3: Execute Confirmed Reassign Action ---');
    const confirmResponse = await services.assistantChat(managerVikram.id, {
        confirmedAction: reassignResponse.proposal,
        projectId: project.id
    });

    assert.strictEqual(confirmResponse.actionExecuted, true);
    const taskAfterConfirm = await db.get('SELECT assignedTo FROM tasks WHERE id = ?', [task1.id]);
    assert.strictEqual(taskAfterConfirm.assignedTo, workerPriya.id, 'Task must now be reassigned to Priya');
    console.log('[PASS] Confirmed action executed and task reassigned in DB.\n');

    // -------------------------------------------------------------
    // Test 4.4: Tenant Scoping & Isolation
    // -------------------------------------------------------------
    console.log('--- Test 4.4: Tenant Scoping & Data Isolation ---');
    // DRDO user tries to query ISRO's project
    let accessDeniedCaught = false;
    try {
        await services.assistantChat(outsideUser.id, {
            message: 'Show me overdue tasks',
            projectId: project.id
        });
    } catch (err) {
        accessDeniedCaught = true;
        assert.strictEqual(err.status, 403, 'Should reject access to outside project with 403');
    }
    assert.ok(accessDeniedCaught, 'Should block cross-organization project access');

    // DRDO user asks without projectId - should only see tasks in DRDO (which is empty)
    const drdoResponse = await services.assistantChat(outsideUser.id, {
        message: 'Which tasks are overdue?'
    });
    assert.ok(!drdoResponse.text.includes('Design Propulsion Stage'), 'DRDO user must not see ISRO tasks');
    console.log('[PASS] Tenant scoping verified. Cross-org data leakage blocked.\n');

    // -------------------------------------------------------------
    // Test 4.5: Unauthorized Worker Cannot Reassign
    // -------------------------------------------------------------
    console.log('--- Test 4.5: Authorization Enforcement on Mutations ---');
    const workerReassignProposal = await services.assistantChat(workerRohan.id, {
        message: `Reassign task ${task1.id} to Priya`
    });
    // Worker is not manager/admin, so assistant refuses
    assert.ok(workerReassignProposal.text.includes('Permission denied') || workerReassignProposal.text.includes('Only managers'), 'Worker should be denied reassign action');
    assert.ok(!workerReassignProposal.proposal, 'No proposal generated for unauthorized requester');
    console.log('[PASS] Non-manager cannot trigger reassign proposal.\n');

    // -------------------------------------------------------------
    // Test 4.6: Conversation History Persistence
    // -------------------------------------------------------------
    console.log('--- Test 4.6: Conversation History in DB ---');
    const convRows = await db.all(
        'SELECT * FROM assistant_conversations WHERE userId = ? ORDER BY createdAt ASC',
        [managerVikram.id]
    );
    assert.ok(convRows.length >= 4, 'Should record conversation messages in DB');
    const roles = convRows.map(r => r.role);
    assert.ok(roles.includes('user') && roles.includes('assistant'), 'Should contain both user and assistant roles');
    console.log(`[PASS] Recorded ${convRows.length} conversation turns in assistant_conversations table.\n`);

    // -------------------------------------------------------------
    // Test 4.7: Verify Client Bundle Has No API Keys
    // -------------------------------------------------------------
    console.log('--- Test 4.7: Client Bundle Security (No Leaked Keys) ---');
    const clientFiles = ['main.js', 'views.js', 'data_store.js', 'index.html', 'style.css'];
    for (const f of clientFiles) {
        const content = fs.readFileSync(path.join(__dirname, f), 'utf8');
        assert.ok(!content.includes('AIzaSy'), `Client file ${f} must not contain Google API key`);
        assert.ok(!content.includes('GEMINI_API_KEY'), `Client file ${f} must not expose GEMINI_API_KEY`);
        assert.ok(!content.includes('LLM_API_KEY'), `Client file ${f} must not expose LLM_API_KEY`);
    }
    console.log('[PASS] Client bundle checked: zero API keys exposed.\n');

    // Cleanup test db
    await db.close();
    try {
        if (fs.existsSync(testDbPath)) {
            fs.unlinkSync(testDbPath);
        }
    } catch (_e) {
        // Windows SQLite lock release delay
    }

    console.log('=== ALL AI ASSISTANT TESTS PASSED SUCCESSFULLY! ===\n');
}

runAssistantTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
