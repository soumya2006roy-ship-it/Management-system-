const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');

const testDbPath = path.join(os.tmpdir(), `test_export_${process.pid}.db`);
process.env.ORION_DB_PATH = testDbPath;
try { fs.rmSync(testDbPath, { force: true }); } catch (_error) {}

const { BackendData } = require('./backend_data');
const { BackendServices, ApiError } = require('./backend_services');

// Helper to capture streamed output in memory
class MemoryStream extends Writable {
    constructor() {
        super();
        this.chunks = [];
    }
    _write(chunk, encoding, callback) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        callback();
    }
    toString(encoding = 'utf8') {
        return Buffer.concat(this.chunks).toString(encoding);
    }
    toBuffer() {
        return Buffer.concat(this.chunks);
    }
}

async function runExportTests() {
    console.log('=== STARTING DATA EXPORT TEST SUITE (Issue 5) ===\n');

    const db = new BackendData();
    await db.init();
    const services = new BackendServices(db);

    // Setup Organizations and Users
    const managerVikram = await services.registerUser({
        name: 'Vikram Sarabhai',
        email: 'vikram@isro.export',
        username: 'vikram_export',
        password: 'Password123!',
        role: 'manager'
    });

    const isroInst = await services.addInstitution({
        name: 'ISRO Export Test Org',
        type: 'Autonomous Body',
        contact: 'contact@isro.export',
        creatorId: managerVikram.id
    });
    const isro = isroInst.id;

    const outsideManager = await services.registerUser({
        name: 'DRDO Director',
        email: 'director@drdo.export',
        username: 'drdo_export',
        password: 'Password123!',
        role: 'manager'
    });

    const drdoInst = await services.addInstitution({
        name: 'DRDO Export Test Org',
        type: 'R&D',
        contact: 'contact@drdo.export',
        creatorId: outsideManager.id
    });
    const drdo = drdoInst.id;

    const workerPriya = await services.registerUser({
        name: 'Priya Sharma',
        email: 'priya@isro.export',
        username: 'priya_export',
        password: 'Password123!',
        role: 'worker'
    });
    await db.run('UPDATE users SET organizationId = ? WHERE id = ?', [isro, workerPriya.id]);

    // Setup Project in ISRO
    const project = await services.createProject({
        name: 'Chandrayaan-4 Missions',
        creatorId: managerVikram.id
    });

    // -------------------------------------------------------------
    // Test 5.1: CSV Formula Injection Prevention (CWE-1236)
    // -------------------------------------------------------------
    console.log('--- Test 5.1: CSV Formula Injection Sanitization ---');
    // Create tasks with dangerous spreadsheet formulas
    await services.createTask({
        projectId: project.id,
        title: '=1+1',
        description: '+1234567890 phone number',
        assignedTo: workerPriya.id,
        deadline: Date.now() + 86400000,
        priority: 'high',
        createdBy: managerVikram.id
    });

    await services.createTask({
        projectId: project.id,
        title: "@SUM(1, 2) Test",
        description: "-999 negative debt",
        assignedTo: workerPriya.id,
        deadline: Date.now() + 86400000,
        priority: 'normal',
        createdBy: managerVikram.id
    });

    await services.createTask({
        projectId: project.id,
        title: '=cmd|\' /C calc\'!A0',
        description: 'Dangerous DDE formula injection payload',
        assignedTo: workerPriya.id,
        deadline: Date.now() + 86400000,
        priority: 'urgent',
        createdBy: managerVikram.id
    });

    const csvStream = new MemoryStream();
    await services.exportTasksCsv(managerVikram.id, { projectId: project.id }, csvStream);
    const csvContent = csvStream.toString('utf8');

    // Verify UTF-8 BOM is present
    assert.strictEqual(csvContent.charCodeAt(0), 0xFEFF, 'CSV must start with UTF-8 BOM for Excel compatibility');

    // Verify headers
    assert.ok(csvContent.includes('Task ID,Title,Description,Status,Priority,Progress (%),Assignee,Project,Deadline'));

    // Verify formula cells are sanitized with prepended single quote (')
    assert.ok(csvContent.includes("'=1+1"), 'Cells starting with = must be prefixed with single quote');
    assert.ok(csvContent.includes("'+1234567890"), 'Cells starting with + must be prefixed with single quote');
    assert.ok(csvContent.includes("'@SUM"), 'Cells starting with @ must be prefixed with single quote');
    assert.ok(csvContent.includes("'-999"), 'Cells starting with - must be prefixed with single quote');
    assert.ok(csvContent.includes("'=cmd|"), 'Malicious DDE payload must be safely sanitized');
    console.log('[PASS] CSV formula injection sanitization verified: all dangerous prefixes escaped.\n');

    // -------------------------------------------------------------
    // Test 5.2: CSV Projects & Members Export
    // -------------------------------------------------------------
    console.log('--- Test 5.2: CSV Projects & Members Export ---');
    const projStream = new MemoryStream();
    await services.exportProjectsCsv(managerVikram.id, {}, projStream);
    const projCsv = projStream.toString('utf8');
    assert.ok(projCsv.includes('Project ID,Name,Status,Progress (%)'));
    assert.ok(projCsv.includes('Chandrayaan-4 Missions'));

    const membersStream = new MemoryStream();
    await services.exportMembersCsv(managerVikram.id, {}, membersStream);
    const membersCsv = membersStream.toString('utf8');
    assert.ok(membersCsv.includes('Member ID,Name,Username,Role'));
    assert.ok(membersCsv.includes('Vikram Sarabhai'));
    assert.ok(membersCsv.includes('Priya Sharma'));
    assert.ok(!membersCsv.includes('DRDO Director'), 'Must not export members from other organizations');
    console.log('[PASS] Projects and members CSV export verified with tenant scoping.\n');

    // -------------------------------------------------------------
    // Test 5.3: Server-Side PDF Project Report
    // -------------------------------------------------------------
    console.log('--- Test 5.3: Server-Side PDF Project Report ---');
    const pdfStream = new MemoryStream();
    await services.exportProjectPdf(managerVikram.id, project.id, pdfStream);
    const pdfBuffer = pdfStream.toBuffer();

    // Verify PDF Magic Bytes (%PDF-)
    const pdfHeader = pdfBuffer.slice(0, 5).toString('ascii');
    assert.strictEqual(pdfHeader, '%PDF-', 'PDF stream must begin with valid PDF-1.x magic bytes');
    assert.ok(pdfBuffer.length > 1000, `PDF must have substantial size (actual: ${pdfBuffer.length} bytes)`);
    console.log(`[PASS] Server-side PDF generation succeeded! Generated valid ${pdfBuffer.length} byte PDF document.\n`);

    // -------------------------------------------------------------
    // Test 5.4: Tenant Authorization on PDF Export
    // -------------------------------------------------------------
    console.log('--- Test 5.4: Tenant Authorization on Export ---');
    let foreignExportBlocked = false;
    try {
        const blockedPdfStream = new MemoryStream();
        await services.exportProjectPdf(outsideManager.id, project.id, blockedPdfStream);
    } catch (err) {
        foreignExportBlocked = true;
        assert.strictEqual(err.status, 404, 'Must not allow exporting a project from another organization');
    }
    assert.ok(foreignExportBlocked, 'Cross-org export must be blocked');
    console.log('[PASS] Cross-tenant export attempt properly rejected.\n');

    // -------------------------------------------------------------
    // Test 5.5: Scalability with 10,000 Tasks (Memory & Speed)
    // -------------------------------------------------------------
    console.log('--- Test 5.5: Streaming Scalability (10,000 tasks) ---');
    console.log('Seeding 10,000 tasks for streaming export benchmark...');
    const seedStart = Date.now();
    await db.withTransaction(async () => {
        for (let i = 0; i < 10000; i++) {
            await db.run(
                'INSERT INTO tasks (title, description, status, priority, progress, projectId, assignedTo, createdBy, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    `Scale Task ${i}`,
                    `Benchmarking streaming memory efficiency for row ${i}`,
                    i % 2 === 0 ? 'completed' : 'in_progress',
                    'normal',
                    i % 100,
                    project.id,
                    workerPriya.id,
                    managerVikram.id,
                    Date.now() + i * 1000
                ]
            );
        }
    });
    console.log(`Seeded 10,000 tasks in ${Date.now() - seedStart}ms.`);

    const largeStream = new MemoryStream();
    const exportStart = Date.now();
    await services.exportTasksCsv(managerVikram.id, { projectId: project.id }, largeStream);
    const exportDuration = Date.now() - exportStart;
    const totalBytes = largeStream.toBuffer().length;

    console.log(`Exported 10,000 tasks (${totalBytes} bytes) in ${exportDuration}ms.`);
    assert.ok(totalBytes > 500000, 'Must stream all 10,000 tasks');
    assert.ok(exportDuration < 5000, `Streaming 10,000 tasks must be fast (took ${exportDuration}ms)`);
    console.log('[PASS] 10,000+ tasks streaming export completed rapidly without crashing server.\n');

    // Cleanup
    await db.close();
    try {
        if (fs.existsSync(testDbPath)) {
            fs.unlinkSync(testDbPath);
        }
    } catch (_e) {}

    console.log('=== ALL DATA EXPORT TESTS PASSED SUCCESSFULLY! ===\n');
}

runExportTests().catch(err => {
    console.error('Export test suite failed:', err);
    process.exit(1);
});
