const assert = require('assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const { BackendData } = require('./backend_data');
const { BackendServices } = require('./backend_services');
const { registerApiRoutes } = require('./backend_routes');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-at-least-32-chars-long-1234567890';
process.env.NODE_ENV = 'test';
const testDbPath = path.join(os.tmpdir(), `orion-test-apiv1-${process.pid}-${Date.now()}.db`);
process.env.ORION_DB_PATH = testDbPath;
try { fs.rmSync(testDbPath, { force: true }); } catch (_e) {}

function request(server, method, path, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const options = {
            hostname: '127.0.0.1',
            port: addr.port,
            path,
            method,
            headers: { ...headers }
        };
        if (body && !options.headers['Content-Type']) {
            options.headers['Content-Type'] = 'application/json';
        }
        const req = http.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (_e) {}
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: json || text
                });
            });
        });
        req.on('error', reject);
        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

async function run() {
    console.log('--- RUNNING API V1 & STATUS CODE TEST SUITE ---');

    const app = express();
    app.use(express.json());

    const data = new BackendData();
    await data.init();

    // Use a unique database namespace/prefix
    const suffix = Date.now().toString(36);
    const services = new BackendServices(data, null, { enableDemoAccounts: false });

    registerApiRoutes(app, services);
    app.use(['/api/v1', '/api'], (_req, res) => res.status(404).json({ error: 'Not found' }));

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
        // 1. Health check on /api/v1 and legacy /api
        const h1 = await request(server, 'GET', '/api/v1/health');
        assert.strictEqual(h1.statusCode, 200, 'GET /api/v1/health must return 200');
        assert.strictEqual(h1.body.ok, true);

        const hLegacy = await request(server, 'GET', '/api/health');
        assert.strictEqual(hLegacy.statusCode, 200, 'GET /api/health must return 200 via legacy alias');
        assert.strictEqual(hLegacy.body.ok, true);

        // 2. 404 on unknown routes under /api/v1 and /api
        const notFoundV1 = await request(server, 'GET', '/api/v1/nonexistent-endpoint');
        assert.strictEqual(notFoundV1.statusCode, 404, 'GET /api/v1/nonexistent-endpoint must return 404');
        assert.strictEqual(notFoundV1.body.error, 'Not found');

        const notFoundLegacy = await request(server, 'GET', '/api/nonexistent-endpoint');
        assert.strictEqual(notFoundLegacy.statusCode, 404, 'GET /api/nonexistent-endpoint must return 404');

        // 3. CSRF token generation
        const csrfRes = await request(server, 'GET', '/api/v1/csrf');
        assert.strictEqual(csrfRes.statusCode, 200);
        const csrfToken = csrfRes.body.token;
        const setCookie = csrfRes.headers['set-cookie'];
        assert.ok(setCookie, 'Must set CSRF cookie');
        const csrfCookie = setCookie[0].split(';')[0];

        const commonHeaders = {
            'x-orion-request': '1',
            'x-csrf-token': csrfToken,
            'cookie': csrfCookie,
            'origin': 'http://127.0.0.1'
        };

        // 4. Deprecated POST /tasks/update must return 410 on both paths
        const depV1 = await request(server, 'POST', '/api/v1/tasks/update', commonHeaders, { taskId: 1 });
        assert.strictEqual(depV1.statusCode, 410, 'POST /api/v1/tasks/update must return 410 Gone');
        assert.ok(depV1.body.error.includes('deprecated'));

        const depLegacy = await request(server, 'POST', '/api/tasks/update', commonHeaders, { taskId: 1 });
        assert.strictEqual(depLegacy.statusCode, 410, 'POST /api/tasks/update must return 410 Gone');

        // 5. User registration returns 201 Created
        const regRes = await request(server, 'POST', '/api/v1/register', commonHeaders, {
            username: `v1_mgr_${suffix}`,
            password: 'password123',
            name: 'V1 Manager'
        });
        assert.strictEqual(regRes.statusCode, 201, 'POST /api/v1/register must return 201 Created');
        assert.strictEqual(regRes.body.username, `v1_mgr_${suffix}`);
        const sessionCookie = regRes.headers['set-cookie'].find(c => c.startsWith('orion_session=')).split(';')[0];

        // Elevate manager role for project/task creation tests
        const inst = await data.run("INSERT INTO institutions (name, type, contact, verificationStatus) VALUES (?, 'Test', 'test@example.com', 'approved')", [`Org_${suffix}`]);
        const orgId = inst.lastID;
        await data.run('UPDATE users SET role = ?, organizationId = ? WHERE id = ?', ['manager', orgId, regRes.body.id]);
        await data.run("INSERT INTO organization_memberships (organizationId, userId, role, createdAt) VALUES (?, ?, 'admin', ?)", [orgId, regRes.body.id, Date.now()]);

        const authHeaders = {
            ...commonHeaders,
            'cookie': `${csrfCookie}; ${sessionCookie}`
        };

        // 6. Project creation returns 201 Created
        const projRes = await request(server, 'POST', '/api/v1/projects', authHeaders, {
            name: `V1 Test Project ${suffix}`
        });
        assert.strictEqual(projRes.statusCode, 201, 'POST /api/v1/projects must return 201 Created');
        assert.ok(projRes.body.id, 'Project ID must be returned');
        assert.strictEqual(projRes.body.success, true);

        // Register worker
        const wkrRes = await request(server, 'POST', '/api/v1/register', commonHeaders, {
            username: `v1_wkr_${suffix}`,
            password: 'password123',
            name: 'V1 Worker'
        });
        assert.strictEqual(wkrRes.statusCode, 201, 'POST /api/v1/register (worker) must return 201');
        await data.run('UPDATE users SET organizationId = ? WHERE id = ?', [orgId, wkrRes.body.id]);
        await data.run("INSERT INTO organization_memberships (organizationId, userId, role, createdAt) VALUES (?, ?, 'member', ?)", [orgId, wkrRes.body.id, Date.now()]);
        const workerSession = wkrRes.headers['set-cookie'].find(c => c.startsWith('orion_session=')).split(';')[0];

        // 7. Task creation returns 201 Created
        const taskRes = await request(server, 'POST', '/api/v1/tasks', authHeaders, {
            projectId: projRes.body.id,
            title: `V1 Test Task ${suffix}`,
            assignedTo: wkrRes.body.id
        });
        assert.strictEqual(taskRes.statusCode, 201, 'POST /api/v1/tasks must return 201 Created');
        assert.ok(taskRes.body.id, 'Task ID must be returned');
        assert.strictEqual(taskRes.body.success, true);

        // 8. Institution creation returns 201 Created
        const instRes = await request(server, 'POST', '/api/v1/institutions', authHeaders, {
            name: `V1 Research Institute ${suffix}`,
            type: 'Research',
            contact: 'contact@v1.test'
        });
        assert.strictEqual(instRes.statusCode, 201, 'POST /api/v1/institutions must return 201 Created');
        assert.strictEqual(instRes.body.name, `V1 Research Institute ${suffix}`);

        // 9. Report submission returns 201 Created
        const workerHeaders = {
            ...commonHeaders,
            'cookie': `${csrfCookie}; ${workerSession}`
        };
        const repRes = await request(server, 'POST', '/api/v1/reports', workerHeaders, {
            taskId: taskRes.body.id,
            proposedProgress: 50,
            reportText: 'Initial half completed'
        });
        assert.strictEqual(repRes.statusCode, 201, 'POST /api/v1/reports must return 201 Created');
        assert.ok(repRes.body.id, 'Report ID must be returned');

        console.log('ALL API V1 & STATUS CODE CHECKS PASSED SUCCESSFULLY.');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await data.close();
        try { fs.rmSync(testDbPath, { force: true }); } catch (_e) {}
    }
}

run().catch((err) => {
    console.error('API V1 TEST SUITE FAILED:', err);
    process.exit(1);
});
