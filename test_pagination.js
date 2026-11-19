const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.ORION_DB_PATH = path.join(os.tmpdir(), `orion-pagination-${process.pid}.db`);
process.env.SESSION_SECRET = 'pagination-tests-session-secret-32-chars';

const { BackendData } = require('./backend_data');
const { BackendServices, ApiError } = require('./backend_services');

async function run() {
    console.log('=== STARTING PAGINATION & SCALING TEST SUITE (Issue 3) ===');

    const data = new BackendData();
    await data.init();
    const services = new BackendServices(data);

    // 1. Create test user (manager) and organization
    const manager = await services.registerUser({
        email: 'scalemanager@example.test',
        password: 'Password@123',
        name: 'Scale Manager'
    });

    const inst = await services.addInstitution({
        name: 'Scale Research Agency',
        type: 'Government',
        contact: 'contact@scale.test',
        creatorId: manager.id
    });

    const project = await services.createProject({
        name: '10K Scale Initiative',
        creatorId: manager.id
    });

    const worker = await services.registerUser({
        email: 'scaleworker@example.test',
        password: 'Password@123',
        name: 'Scale Worker'
    });
    const invite = await services.createOrganizationInvite(manager.id, { organizationId: inst.id, maxUses: 1, expiresInHours: 24 });
    await services.joinOrganization({ userId: worker.id, code: invite.code });

    // 2. Batch seed 10,000 tasks in a single SQLite transaction
    console.log('\n--- Seeding 10,000 tasks into test project ---');
    const startSeed = Date.now();
    await data.withTransaction(async () => {
        for (let i = 1; i <= 10000; i++) {
            const status = i % 3 === 0 ? 'Completed' : (i % 2 === 0 ? 'In Progress' : 'Pending');
            const priority = i % 5 === 0 ? 'urgent' : (i % 2 === 0 ? 'high' : 'normal');
            const title = `Task ${i} - ${priority.toUpperCase()} - Operations`;
            const desc = `Description for batch task ${i} with specific keywords for search testing`;
            await data.run(
                `INSERT INTO tasks (projectId, title, description, assignedTo, createdBy, status, priority, progress, deadline)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [project.id, title, desc, worker.id, manager.id, status, priority, status === 'Completed' ? 100 : 0, '2026-12-31']
            );
        }
    });
    const seedDuration = Date.now() - startSeed;
    console.log(`[PASS] Seeded 10,000 tasks in ${seedDuration}ms`);

    // Verify DB count
    const totalCount = await data.get('SELECT COUNT(*) as count FROM tasks WHERE projectId = ?', [project.id]);
    assert.strictEqual(Number(totalCount.count), 10000);
    console.log('[PASS] DB verified task count is exactly 10,000');

    // 3. Test Default Cursor-Based Pagination (Page 1)
    console.log('\n--- Test 3.1: Cursor-Based Pagination (Page 1: limit=20, default sort=id_desc) ---');
    const t0 = Date.now();
    const page1 = await services.getTasksPaginated(manager.id, { limit: 20, projectId: project.id });
    const p1Duration = Date.now() - t0;
    console.log(`Page 1 query completed in ${p1Duration}ms`);

    assert.strictEqual(page1.data.length, 20);
    assert.strictEqual(page1.pageInfo.limit, 20);
    assert.strictEqual(page1.pageInfo.hasMore, true);
    assert.strictEqual(page1.pageInfo.total, 10000);
    assert.ok(page1.pageInfo.nextCursor, 'nextCursor must be populated');
    assert.strictEqual(page1.data[0].id > page1.data[19].id, true, 'Tasks must be in descending ID order');
    assert.ok(p1Duration < 50, `Page 1 query must be sub-50ms (was ${p1Duration}ms)`);
    console.log('[PASS] Page 1 returned bounded 20 items with valid cursor in <50ms');

    // 4. Test Cursor Seek (Page 2)
    console.log('\n--- Test 3.2: Cursor Seek (Page 2 using nextCursor) ---');
    const t1 = Date.now();
    const page2 = await services.getTasksPaginated(manager.id, {
        limit: 20,
        cursor: page1.pageInfo.nextCursor,
        projectId: project.id
    });
    const p2Duration = Date.now() - t1;
    console.log(`Page 2 query completed in ${p2Duration}ms`);

    assert.strictEqual(page2.data.length, 20);
    assert.strictEqual(page2.pageInfo.hasMore, true);
    assert.ok(page2.pageInfo.nextCursor < page1.pageInfo.nextCursor, 'Cursor must strictly progress');

    // Verify zero overlap between page 1 and page 2
    const p1Ids = new Set(page1.data.map(t => t.id));
    for (const t of page2.data) {
        assert.ok(!p1Ids.has(t.id), `Task ${t.id} must not appear in both pages`);
    }
    assert.ok(p2Duration < 50, `Page 2 cursor seek must be sub-50ms (was ${p2Duration}ms)`);
    console.log('[PASS] Page 2 returned next 20 items with zero overlap in <50ms');

    // 5. Test Filtering with Pagination
    console.log('\n--- Test 3.3: Filtered Pagination (status=Completed) ---');
    const completedPage = await services.getTasksPaginated(manager.id, {
        limit: 25,
        status: 'Completed',
        projectId: project.id
    });
    assert.strictEqual(completedPage.data.length, 25);
    for (const t of completedPage.data) {
        assert.strictEqual(t.status, 'Completed');
    }
    assert.ok(completedPage.pageInfo.total > 0, 'Total completed count must be positive');
    console.log(`[PASS] Filtered completed tasks: ${completedPage.pageInfo.total} total, 25 returned on page 1`);

    // 6. Test Search Filtering with Pagination
    console.log('\n--- Test 3.4: Search Filtering with Pagination (search="Task 500") ---');
    const searchPage = await services.getTasksPaginated(manager.id, {
        limit: 10,
        search: 'Task 500',
        projectId: project.id
    });
    assert.ok(searchPage.data.length > 0, 'Search should find matching tasks');
    for (const t of searchPage.data) {
        assert.ok(t.title.includes('Task 500') || t.description.includes('Task 500'));
    }
    console.log(`[PASS] Search filter correctly matched ${searchPage.data.length} tasks`);

    // 7. Test Dashboard Boundedness (Prevent N+1 with 10,000 tasks)
    console.log('\n--- Test 3.5: Dashboard Load Scalability (Subtask Batching) ---');
    // Add subtasks to task 1
    const task1 = page1.data[0];
    await services.createSubtask(manager.id, {
        parentTaskId: task1.id,
        title: 'Scale Subtask A',
        assignedTo: worker.id
    });
    await services.createSubtask(manager.id, {
        parentTaskId: task1.id,
        title: 'Scale Subtask B',
        assignedTo: worker.id
    });

    const tDash = Date.now();
    const dashboard = await services.getDashboard(manager.id);
    const dashDuration = Date.now() - tDash;
    console.log(`Dashboard loaded in ${dashDuration}ms with 10,000 tasks in DB`);

    assert.ok(dashboard.allTasks.length <= 50, 'Dashboard allTasks must be bounded (<= 50)');
    const foundTask1 = dashboard.allTasks.find(t => t.id === task1.id);
    assert.ok(foundTask1, 'Task 1 must be present in dashboard tasks');
    assert.strictEqual(foundTask1.subtasks.length, 2, 'Subtasks must be attached via single batch query');
    assert.ok(dashDuration < 100, `Dashboard load with 10k tasks must be <100ms (was ${dashDuration}ms)`);
    console.log('[PASS] Dashboard load is bounded and fast with subtasks batching');

    // 8. Test Offset Pagination for Projects & Institutions
    console.log('\n--- Test 3.6: Offset Pagination for Projects & Institutions ---');
    const projectsPage = await services.getProjectsPaginated(manager.id, { page: 1, limit: 10 });
    assert.strictEqual(projectsPage.data.length >= 1, true);
    assert.strictEqual(projectsPage.pageInfo.page, 1);
    assert.strictEqual(projectsPage.pageInfo.limit, 10);
    assert.ok(projectsPage.pageInfo.total >= 1);
    console.log('[PASS] Projects offset pagination operates correctly');

    const instsPage = await services.getInstitutionsPaginated({ page: 1, limit: 10 });
    assert.strictEqual(instsPage.data.length >= 1, true);
    assert.strictEqual(instsPage.pageInfo.page, 1);
    assert.strictEqual(instsPage.pageInfo.limit, 10);
    assert.ok(instsPage.pageInfo.total >= 1);
    console.log('[PASS] Institutions offset pagination operates correctly');

    // 9. Test Keyset Pagination with deadline_asc and Composite Cursor (BE-01)
    console.log('\n--- Test 3.7: Keyset Pagination with deadline_asc and Composite Cursor (BE-01) ---');
    const deadlinePage1 = await services.getTasksPaginated(manager.id, {
        limit: 15,
        sort: 'deadline_asc',
        projectId: project.id
    });
    assert.strictEqual(deadlinePage1.data.length, 15, 'Page 1 must return 15 tasks');
    assert.ok(deadlinePage1.pageInfo.nextCursor, 'Must return nextCursor for pagination');
    assert.ok(String(deadlinePage1.pageInfo.nextCursor).includes('___'), 'Cursor must be composite format (deadline___id)');

    const deadlinePage2 = await services.getTasksPaginated(manager.id, {
        limit: 15,
        sort: 'deadline_asc',
        cursor: deadlinePage1.pageInfo.nextCursor,
        projectId: project.id
    });
    assert.strictEqual(deadlinePage2.data.length, 15, 'Page 2 must return 15 tasks');

    // Verify zero overlap
    const deadlineP1Ids = new Set(deadlinePage1.data.map(t => t.id));
    for (const t of deadlinePage2.data) {
        assert.ok(!deadlineP1Ids.has(t.id), `Task ID ${t.id} must not appear in both page 1 and page 2`);
    }

    // Verify ordering
    for (let i = 0; i < deadlinePage1.data.length - 1; i++) {
        const curr = deadlinePage1.data[i];
        const next = deadlinePage1.data[i + 1];
        if (curr.deadline !== null && next.deadline !== null) {
            assert.ok(curr.deadline <= next.deadline, 'Deadlines must be in ascending order');
        }
    }
    console.log('[PASS] Composite keyset pagination for deadline_asc operates cleanly with zero overlap.');

    // 10. Cleanup
    await data.close();
    try { fs.rmSync(process.env.ORION_DB_PATH, { force: true }); } catch (_e) {}
    console.log('\n=== ALL PAGINATION & SCALING TESTS PASSED SUCCESSFULLY (100%) ===\n');
}

run().catch((error) => {
    console.error('Pagination test failed:', error);
    process.exit(1);
});
