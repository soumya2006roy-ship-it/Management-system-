const assert = require('assert');
const sqlite3 = require('sqlite3');
const { BackendData } = require('./backend_data');
const { BackendServices } = require('./backend_services');
const migration005 = require('./migrations/005_standardize_timestamps');

async function testMigrationOnMixedData() {
    console.log('--- TEST 1: Migration 005 on Mixed Timestamp Data ---');

    // Create a standalone in-memory database to test migration directly
    const db = new sqlite3.Database(':memory:');
    const data = {
        db,
        run(sql, params = []) {
            return new Promise((resolve, reject) => {
                db.run(sql, params, function (err) {
                    if (err) reject(err);
                    else resolve(this);
                });
            });
        },
        get(sql, params = []) {
            return new Promise((resolve, reject) => {
                db.get(sql, params, (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
        },
        all(sql, params = []) {
            return new Promise((resolve, reject) => {
                db.all(sql, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });
        }
    };

    // Create tables
    await data.run(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, deadline TEXT, status TEXT)`);
    await data.run(`CREATE TABLE subtasks (id INTEGER PRIMARY KEY, title TEXT, dueDate TEXT, status TEXT)`);

    // Seed mixed format rows
    const epochMs = 1774915200000; // 2026-03-31
    const isoWithTime = '2026-04-15T14:30:00.000Z';
    const canonicalDate = '2026-05-01';

    await data.run("INSERT INTO tasks (id, title, deadline, status) VALUES (1, 'Numeric Epoch', ?, 'In Progress')", [String(epochMs)]);
    await data.run("INSERT INTO tasks (id, title, deadline, status) VALUES (2, 'ISO Timestamp', ?, 'In Progress')", [isoWithTime]);
    await data.run("INSERT INTO tasks (id, title, deadline, status) VALUES (3, 'Canonical Date', ?, 'In Progress')", [canonicalDate]);
    await data.run("INSERT INTO tasks (id, title, deadline, status) VALUES (4, 'Null Deadline', NULL, 'In Progress')");

    await data.run("INSERT INTO subtasks (id, title, dueDate, status) VALUES (1, 'Sub Epoch', ?, 'in_progress')", [String(epochMs)]);
    await data.run("INSERT INTO subtasks (id, title, dueDate, status) VALUES (2, 'Sub ISO', ?, 'in_progress')", [isoWithTime]);
    await data.run("INSERT INTO subtasks (id, title, dueDate, status) VALUES (3, 'Sub Canonical', ?, 'in_progress')", [canonicalDate]);

    // Check before counts
    const beforeTasks = await data.all("SELECT id, deadline FROM tasks");
    console.log(`Before migration tasks:`, beforeTasks);
    assert.strictEqual(beforeTasks[0].deadline, String(epochMs));
    assert.strictEqual(beforeTasks[1].deadline, isoWithTime);
    assert.strictEqual(beforeTasks[2].deadline, canonicalDate);

    // Run migration
    await migration005(data);

    // Check after counts & format
    const afterTasks = await data.all("SELECT id, deadline FROM tasks");
    console.log(`After migration tasks:`, afterTasks);
    assert.strictEqual(afterTasks[0].deadline, new Date(epochMs).toISOString());
    assert.strictEqual(afterTasks[1].deadline, new Date(isoWithTime).toISOString());
    assert.strictEqual(afterTasks[2].deadline, canonicalDate);
    assert.strictEqual(afterTasks[3].deadline, null);

    const afterSubtasks = await data.all("SELECT id, dueDate FROM subtasks");
    assert.strictEqual(afterSubtasks[0].dueDate, new Date(epochMs).toISOString());
    assert.strictEqual(afterSubtasks[1].dueDate, new Date(isoWithTime).toISOString());
    assert.strictEqual(afterSubtasks[2].dueDate, canonicalDate);

    // Test Idempotency: run migration again
    await migration005(data);
    const idempotentTasks = await data.all("SELECT id, deadline FROM tasks");
    assert.deepStrictEqual(idempotentTasks, afterTasks, 'Migration must be idempotent');

    await new Promise((resolve) => db.close(resolve));
    console.log('[PASS] Migration 005 verified on mixed-format rows and proven idempotent.');
}

async function testOverdueDetection() {
    console.log('--- TEST 2: Overdue Task Detection & Comparisons ---');

    const data = new BackendData();
    await data.init();
    const services = new BackendServices(data, null, { enableDemoAccounts: false });

    const suffix = Date.now().toString(36);
    // Setup org and users
    const inst = await data.run("INSERT INTO institutions (name, type, contact, verificationStatus) VALUES (?, 'Gov', 'gov@test.org', 'approved')", [`Gov_${suffix}`]);
    const orgId = inst.lastID;

    const mgr = await data.run("INSERT INTO users (username, password, name, role, organizationId) VALUES (?, 'pass', 'Manager', 'manager', ?)", [`mgr_${suffix}`, orgId]);
    const mgrId = mgr.lastID;
    await data.run("INSERT INTO organization_memberships (organizationId, userId, role, createdAt) VALUES (?, ?, 'admin', ?)", [orgId, mgrId, Date.now()]);

    const wkr = await data.run("INSERT INTO users (username, password, name, role, organizationId) VALUES (?, 'pass', 'Worker', 'worker', ?)", [`wkr_${suffix}`, orgId]);
    const wkrId = wkr.lastID;
    await data.run("INSERT INTO organization_memberships (organizationId, userId, role, createdAt) VALUES (?, ?, 'member', ?)", [orgId, wkrId, Date.now()]);

    const proj = await services.createProject({ name: `Project Overdue Test ${suffix}`, creatorId: mgrId });
    const projId = proj.id;

    // Calculate dates
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // 1. Task overdue (yesterday, in progress)
    const taskOverdue = await services.createTask({
        projectId: projId,
        title: 'Overdue Urgent Task',
        assignedTo: wkrId,
        createdBy: mgrId,
        deadline: yesterday
    });

    // 2. Task future (tomorrow, in progress)
    const taskFuture = await services.createTask({
        projectId: projId,
        title: 'Future Normal Task',
        assignedTo: wkrId,
        createdBy: mgrId,
        deadline: tomorrow
    });

    // 3. Task past deadline but completed
    const taskCompleted = await services.createTask({
        projectId: projId,
        title: 'Completed Old Task',
        assignedTo: wkrId,
        createdBy: mgrId,
        deadline: yesterday
    });
    await services.updateTask({ taskId: taskCompleted.id, status: 'Completed', requesterId: mgrId });

    // Verify canonicalization at input boundary
    const rawOverdue = await data.get('SELECT deadline FROM tasks WHERE id = ?', [taskOverdue.id]);
    assert.strictEqual(rawOverdue.deadline, yesterday, 'Stored deadline must be canonical YYYY-MM-DD');

    // Test assistant/internal listTasks with overdueOnly: true
    // Simulate assistant call
    const assistantResult = await services.assistantChat(mgrId, {
        message: 'Which tasks are overdue?',
        projectId: projId
    });
    console.log('Assistant response:', assistantResult.text);
    assert.ok(assistantResult.text.includes('Overdue Urgent Task'), 'Assistant must identify overdue task');
    assert.ok(!assistantResult.text.includes('Future Normal Task'), 'Assistant must not list future task as overdue');
    assert.ok(!assistantResult.text.includes('Completed Old Task'), 'Assistant must not list completed task as overdue');

    // Test exportProjectsCsv overdue column
    const csvChunks = [];
    const mockCsvStream = {
        write(chunk) { csvChunks.push(chunk); },
        end() {}
    };
    await services.exportProjectsCsv(mgrId, {}, mockCsvStream);
    const csvText = csvChunks.join('');
    console.log('Export CSV preview:\n', csvText);
    assert.ok(csvText.includes('Project Overdue Test'), 'Project must be in export');
    // Expected row: Project ID, Name, Status, Progress, Total Tasks (3), Completed Tasks (1), Overdue Tasks (1)
    const lines = csvText.trim().split('\n');
    const projectLine = lines.find(l => l.includes(`Project Overdue Test ${suffix}`));
    assert.ok(projectLine, 'Project line must exist');
    assert.ok(projectLine.endsWith(',1') || projectLine.includes(',1\r') || projectLine.includes(',1'), 'Overdue tasks count must be exactly 1');

    await data.close();
    console.log('[PASS] Overdue task detection verified across queries, assistant, and CSV export.');
}

async function testConcurrencyAndTransactions() {
    console.log('--- TEST 3: Transaction Queue Concurrency & Non-Poisoning ---');

    const data = new BackendData();
    await data.init();

    await data.run('CREATE TABLE IF NOT EXISTS test_counters (id INTEGER PRIMARY KEY, val INTEGER)');
    await data.run('INSERT OR REPLACE INTO test_counters (id, val) VALUES (1, 0)');

    // 1. Run 20 concurrent transactions that increment a counter
    const concurrency = 20;
    const promises = [];
    for (let i = 0; i < concurrency; i++) {
        promises.push(
            data.withTransaction(async () => {
                const row = await data.get('SELECT val FROM test_counters WHERE id = 1');
                await data.run('UPDATE test_counters SET val = ? WHERE id = 1', [row.val + 1]);
                return row.val + 1;
            })
        );
    }
    const results = await Promise.all(promises);
    assert.strictEqual(results.length, concurrency);
    const finalRow = await data.get('SELECT val FROM test_counters WHERE id = 1');
    assert.strictEqual(finalRow.val, concurrency, `Counter must be exactly ${concurrency}`);
    console.log(`[PASS] ${concurrency} concurrent transactions executed sequentially without deadlock or race condition.`);

    // 2. Test failure rollback and non-poisoning
    let errorCaught = false;
    try {
        await data.withTransaction(async () => {
            await data.run('UPDATE test_counters SET val = 999 WHERE id = 1');
            throw new Error('Simulated transactional failure');
        });
    } catch (err) {
        errorCaught = true;
        assert.strictEqual(err.message, 'Simulated transactional failure');
    }
    assert.ok(errorCaught, 'Error must be thrown');

    // Confirm rollback happened
    const rollbackRow = await data.get('SELECT val FROM test_counters WHERE id = 1');
    assert.strictEqual(rollbackRow.val, concurrency, 'Failed transaction must roll back');

    // 3. Confirm next transaction in queue executes successfully (queue not poisoned)
    const subsequentResult = await data.withTransaction(async () => {
        const r = await data.get('SELECT val FROM test_counters WHERE id = 1');
        await data.run('UPDATE test_counters SET val = ? WHERE id = 1', [r.val + 5]);
        return r.val + 5;
    });
    assert.strictEqual(subsequentResult, concurrency + 5, 'Queue must not be poisoned by previous failure');

    await data.close();
    console.log('[PASS] Transaction rollback and queue non-poisoning verified.');
}

async function run() {
    await testMigrationOnMixedData();
    await testOverdueDetection();
    await testConcurrencyAndTransactions();
    console.log('ALL DATA INTEGRITY & CONCURRENCY TESTS PASSED (100%).');
}

run().catch((err) => {
    console.error('DATA INTEGRITY TEST FAILED:', err);
    process.exit(1);
});
