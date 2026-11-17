const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const { BackendData } = require('./backend_data');
const { BackendServices } = require('./backend_services');

process.env.ORION_DB_PATH = path.join(os.tmpdir(), `orion-simulation-${process.pid}.db`);

const HOST = '127.0.0.1';
const PORT = 3210;
const BASE = '/api';
const READY_LOG = '"event":"server_started"';
let simulationCsrf = null;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(method, endpoint, body = null, token = null, { rawPath = false, skipCsrf = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (!skipCsrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        if (!simulationCsrf) {
            const csrf = await request('GET', '/csrf');
            simulationCsrf = csrf.body.token;
        }
        headers.Origin = `http://${HOST}:${PORT}`;
        headers['X-Orion-Request'] = '1';
        headers['X-CSRF-Token'] = simulationCsrf;
    }
    const cookieParts = [];
    if (token) cookieParts.push(`orion_session=${token}`);
    if (simulationCsrf) cookieParts.push(`orion_csrf=${simulationCsrf}`);
    if (cookieParts.length) headers.Cookie = cookieParts.join('; ');
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: HOST,
                port: PORT,
                path: rawPath ? endpoint : `${BASE}${endpoint}`,
                method,
                headers
            },
            (res) => {
                let raw = '';
                res.on('data', (chunk) => {
                    raw += chunk;
                });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(raw || '{}');
                        const setCookie = res.headers['set-cookie'] || [];
                        const sessionCookie = setCookie.map((entry) => entry.match(/(?:^|;\s*)orion_session=([^;]*)/)).find(Boolean);
                        const wireBody = { ...parsed };
                        if (sessionCookie && sessionCookie[1]) parsed.token = decodeURIComponent(sessionCookie[1]);
                        resolve({ status: res.statusCode, body: parsed, wireBody, headers: res.headers });
                    } catch (error) {
                        resolve({ status: res.statusCode, body: raw });
                    }
                });
            }
        );
        req.on('error', reject);
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function isServerReachable() {
    try {
        const res = await request('GET', '/health');
        return res.status === 200 && res.body && res.body.ok === true;
    } catch (error) {
        return false;
    }
}

async function seedSimulationPlatformAdmin() {
    const data = new BackendData();
    await data.init();
    try {
        const email = `sim_platform_${Date.now()}@example.test`;
        const admin = await new BackendServices(data).registerUser({ email, name: 'Simulation Platform Admin', password: 'password123' });
        await data.run("UPDATE users SET role='exec' WHERE id=?", [admin.id]);
        return { username: email, password: 'password123' };
    } finally { await data.close(); }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function seedSimulationOrganization() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(process.env.ORION_DB_PATH);
        db.run("INSERT INTO institutions (name,type,contact,verificationStatus) VALUES ('Simulation Agency','Test','simulation@example.test','approved')", function (error) {
            if (error) { db.close(); reject(error); return; }
            const id = this.lastID;
            db.close((closeError) => closeError ? reject(closeError) : resolve(id));
        });
    });
}

function setSimulationRole(username, role, organizationId = null) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(process.env.ORION_DB_PATH);
        db.run('UPDATE users SET role = ?, organizationId = ? WHERE username = ?', [role, organizationId, username], function (error) {
            if (error) { db.close(); reject(error); return; }
            const changes = this.changes;
            if (organizationId != null && changes) {
                db.run("INSERT INTO organization_memberships (userId,organizationId,role,createdAt) SELECT id,?,?,? FROM users WHERE username=? ON CONFLICT(userId,organizationId) DO UPDATE SET role=excluded.role", [organizationId, role === 'manager' ? 'admin' : 'member', Date.now(), username], (membershipError) => {
                    db.close((closeError) => membershipError ? reject(membershipError) : closeError ? reject(closeError) : resolve(changes));
                });
                return;
            }
            db.close((closeError) => closeError ? reject(closeError) : resolve(changes));
        });
    });
}

async function assertStatus(method, endpoint, body, expectedStatus, context, token = null) {
    const res = await request(method, endpoint, body, token);
    assert(
        res.status === expectedStatus,
        `${context} | expected ${expectedStatus}, got ${res.status} | body=${JSON.stringify(res.body)}`
    );
    return res.body;
}

function startServer() {
    const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: __dirname,
        env: { ...process.env, PORT: String(PORT), SESSION_SECRET: 'simulation-session-secret-for-tests-only-32chars', NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error('Server did not start within timeout'));
            }
        }, 12000);

        function onReady(data) {
            const text = String(data);
            if (text.includes(READY_LOG) && !settled) {
                settled = true;
                clearTimeout(timeout);
                resolve(server);
            }
        }

        server.stdout.on('data', onReady);
        server.stderr.on('data', onReady);
        server.once('error', (error) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(error);
            }
        });
        server.once('exit', (code) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error(`Server exited early with code ${code}`));
            }
        });
    });
}

async function stopServer(server) {
    if (!server || server.killed) {
        return;
    }
    server.kill();
    await delay(400);
}

async function runBasicScenario() {
    const stamp = Date.now();
    const managerUsername = `sim_mgr_${stamp}`;
    const workerUsername = `sim_wkr_${stamp}`;

    console.log('Running basic auth/project/task simulation...');

    const rejectedForgery = await request('POST', '/login', { username: 'nobody', password: 'wrong' }, null, { skipCsrf: true });
    assert(rejectedForgery.status === 403, `state-changing requests without CSRF proof must be rejected | got ${rejectedForgery.status}`);

    const manager = await assertStatus(
        'POST',
        '/register',
        {
            username: managerUsername,
            password: 'password123',
            name: 'Sim Manager',
            role: 'manager',
        },
        200,
        'manager registration'
    );
    assert(!manager.password && !manager.securityAnswer, 'registration must not return secrets');
    const organizationId = await seedSimulationOrganization();
    assert(manager.role === 'worker', 'public registration must not grant a manager role');
    assert(await setSimulationRole(managerUsername, 'manager', organizationId) === 1, 'manager fixture role should be seeded in the isolated test database');
    manager.role = 'manager';
    const worker = await assertStatus(
        'POST',
        '/register',
        {
            username: workerUsername,
            password: 'password123',
            name: 'Sim Worker',
            role: 'worker',
        },
        200,
        'worker registration'
    );
    assert(await setSimulationRole(workerUsername, 'worker', organizationId) === 1, 'worker should be scoped to the simulation organization');
    const exec = await assertStatus(
        'POST',
        '/register',
        {
            username: `sim_exec_${stamp}`,
            password: 'password123',
            name: 'Sim Exec',
            role: 'executive',
        },
        200,
        'executive registration'
    );
    assert(exec.role === 'worker', 'public registration must not grant executive privileges');
    assert(await setSimulationRole(exec.username, 'exec') === 1, 'executive fixture role should be seeded in the isolated test database');
    exec.role = 'exec';
    assert(!exec.password, 'login-equivalent payloads must not include password');

    const project = await assertStatus(
        'POST',
        '/projects',
        { name: `Simulation Project ${stamp}` },
        200,
        'project creation',
        manager.token
    );

    const task = await assertStatus(
        'POST',
        '/tasks',
        {
            projectId: project.id,
            title: 'Urgent Sim Task',
            assignedTo: worker.id,
            createdBy: manager.id,
            deadline: new Date(Date.now() + 86400000).toISOString()
        },
        200,
        'task creation',
        manager.token
    );

    const resetResponse = await assertStatus('POST', '/password-reset/request', { email: managerUsername }, 200, 'generic password reset request');
    assert(resetResponse.message === 'If an account exists for that email, a password reset link has been sent.');
    await assertStatus('POST', '/get-question', { username: managerUsername }, 404, 'security question recovery removed');
    await assertStatus('POST', '/reset-password', { username: managerUsername, answer: 'Dog', newPassword: 'newpassword123' }, 404, 'legacy password reset endpoint removed');

    return { managerId: manager.id, workerId: worker.id, taskId: task.id, projectId: project.id, organizationId, workerUsername, manager, worker, exec };
}

async function runFullScenario() {
    const context = await runBasicScenario();
    const { managerId, workerId, taskId, projectId, workerUsername, manager, worker, exec } = context;
    const stamp = Date.now();

    console.log('Running full report approval suite...');

    const outsider = await assertStatus(
        'POST',
        '/register',
        {
            username: `sim_out_${stamp}`,
            password: 'password123',
            name: 'Outsider Worker',
            role: 'worker',
        },
        200,
        'outsider registration'
    );

    const loggedInWorker = await assertStatus(
        'POST',
        '/login',
        { username: workerUsername, password: 'password123' },
        200,
        'worker login'
    );
    if (loggedInWorker && loggedInWorker.token) {
        worker.token = loggedInWorker.token;
    }

    await assertStatus(
        'POST',
        '/reports',
        { taskId, submittedBy: outsider.id, proposedProgress: 30, reportText: 'Unauthorized attempt' },
        403,
        'reject unauthorized report submission',
        outsider.token
    );
    await assertStatus(
        'POST',
        '/reports',
        { taskId, submittedBy: workerId, proposedProgress: 150, reportText: 'Invalid progress' },
        400,
        'reject invalid progress report',
        worker.token
    );

    const pendingOne = await assertStatus(
        'POST',
        '/reports',
        { taskId, submittedBy: workerId, proposedProgress: 40, reportText: 'Phase 1 complete' },
        200,
        'submit first report',
        worker.token
    );
    const pendingTwo = await assertStatus(
        'POST',
        '/reports',
        { taskId, submittedBy: workerId, proposedProgress: 75, reportText: 'Second report needs review' },
        200,
        'submit second report',
        worker.token
    );

    await assertStatus(
        'GET',
        `/reports/pending?reviewerId=${managerId}`,
        null,
        200,
        'manager pending queue',
        manager.token
    );
    await assertStatus(
        'GET',
        `/reports/pending?reviewerId=${workerId}`,
        null,
        403,
        'non-manager pending queue blocked',
        worker.token
    );

    await assertStatus(
        'POST',
        `/reports/${pendingOne.id}/review`,
        { reviewerId: outsider.id, action: 'approve', reviewComment: 'Trying to bypass auth' },
        403,
        'non-creator review blocked',
        outsider.token
    );

    await assertStatus(
        'POST',
        `/reports/${pendingOne.id}/review`,
        { reviewerId: managerId, action: 'reject', reviewComment: 'Need stronger evidence' },
        200,
        'reject report',
        manager.token
    );

    await assertStatus(
        'POST',
        `/reports/${pendingTwo.id}/review`,
        { reviewerId: managerId, action: 'approve', reviewComment: 'Looks good' },
        200,
        'approve report',
        manager.token
    );

    await assertStatus(
        'POST',
        `/reports/${pendingTwo.id}/review`,
        { reviewerId: managerId, action: 'approve', reviewComment: 'Duplicate review should fail' },
        409,
        'block stale duplicate review',
        manager.token
    );

    const taskReports = await assertStatus(
        'GET',
        `/tasks/${taskId}/reports?requesterId=${managerId}`,
        null,
        200,
        'task report history',
        manager.token
    );
    assert(Array.isArray(taskReports) && taskReports.length >= 2, 'expected task report history entries');

    await assertStatus(
        'GET',
        `/tasks/${taskId}/reports?requesterId=999999`,
        null,
        403,
        'unauthorized history request blocked',
        manager.token
    );

    const dashboardManager = await assertStatus(
        'GET',
        `/dashboard/${managerId}`,
        null,
        200,
        'manager dashboard',
        manager.token
    );
    const reviewedTask = (dashboardManager.allTasks || []).find((task) => Number(task.id) === Number(taskId));
    assert(reviewedTask, 'expected reviewed task in manager dashboard');
    assert(Number(reviewedTask.progress) === 75, `expected task progress 75, got ${reviewedTask.progress}`);

    const reviewedProject = (dashboardManager.projects || []).find((project) => Number(project.id) === Number(projectId));
    assert(reviewedProject, 'expected project in manager dashboard');
    assert(Number(reviewedProject.progress) === 75, `expected project progress 75, got ${reviewedProject.progress}`);

    await assertStatus(
        'POST',
        '/tasks/update',
        { taskId, progress: 80 },
        410,
        'block direct progress update bypass',
        worker.token
    );

    const dashboardAfterLegacy = await assertStatus(
        'GET',
        `/dashboard/${managerId}`,
        null,
        200,
        'manager dashboard after legacy update',
        manager.token
    );
    const legacyTask = (dashboardAfterLegacy.allTasks || []).find((task) => Number(task.id) === Number(taskId));
    assert(legacyTask, 'expected task after legacy update');
    assert(Number(legacyTask.progress) === 75, `progress must remain manager-approved at 75, got ${legacyTask.progress}`);
    const legacyProject = (dashboardAfterLegacy.projects || []).find((project) => Number(project.id) === Number(projectId));
    assert(legacyProject, 'expected project after legacy update');
    assert(Number(legacyProject.progress) === 75, `project progress must remain manager-approved at 75, got ${legacyProject.progress}`);

    const dbLeak = await request('GET', '/orion.db', null, null, { rawPath: true });
    assert(dbLeak.status === 404, `database file must not be served | got ${dbLeak.status}`);
    const backendLeak = await request('GET', '/backend_services.js', null, null, { rawPath: true });
    assert(backendLeak.status === 404, `backend source must not be served | got ${backendLeak.status}`);
    const envLeak = await request('GET', '/.env', null, null, { rawPath: true });
    assert(envLeak.status === 404, `.env file must not be served | got ${envLeak.status}`);
    const heroRes = await request('GET', '/hero.png', null, null, { rawPath: true });
    assert(heroRes.status === 200, `hero.png must be accessible | got ${heroRes.status}`);

    // Verify logout and session invalidation
    await assertStatus('POST', '/logout', null, 200, 'worker logout', worker.token);
    await assertStatus('GET', `/dashboard/${workerId}`, null, 401, 'session invalidation after logout', worker.token);

    const platform = await assertStatus('POST', '/login', globalThis.simPlatformCredentials, 200, 'platform admin login');
    const platformAdmins = await assertStatus('GET', '/platform/admins', null, 200, 'platform admin account listing', platform.token);
    assert(platformAdmins.some((admin) => Number(admin.id) === Number(platform.id)), 'platform administrator can open the website admin section');
    const secondaryAdmin = await assertStatus('POST', '/platform/admins', { email: `sim_admin_${stamp}@example.test`, name: 'Simulation Admin', password: 'valid-admin-password-123' }, 201, 'create another platform admin', platform.token);
    assert(secondaryAdmin.isPlatformAdmin && !secondaryAdmin.password, 'new admin is privileged without returning password data');
    const applicant = await assertStatus('POST', '/register', { email: `org_owner_${stamp}@example.test`, name: 'Organization Applicant', password: 'password123' }, 200, 'organization applicant signup');
    assert(applicant.role === 'worker', 'organization applicants begin as workers');
    await assertStatus('POST', '/platform/admins', { email: `blocked_admin_${stamp}@example.test`, name: 'Blocked Admin', password: 'valid-admin-password-456' }, 403, 'non-admin cannot create website admins', applicant.token);
    await assertStatus('POST', '/register', { email: applicant.username, name: 'Duplicate Applicant', password: 'password123' }, 409, 'reject duplicate account email');
    const application = await assertStatus('POST', '/organizations/applications', { legalName: `Verified Agency ${stamp}`, type: 'Government', officialEmail: `office_${stamp}@example.test`, contactName: 'Agency Contact' }, 201, 'submit organization verification application', applicant.token);
    const queue = await assertStatus('GET', '/platform/organization-applications', null, 200, 'platform verification queue', platform.token);
    assert(queue.some((row) => Number(row.id) === Number(application.id)), 'platform admin can see submitted application');
    await assertStatus('POST', `/platform/organization-applications/${application.id}/review`, { action: 'approve', reviewComment: 'Simulation verification' }, 200, 'approve organization', platform.token);
    const owner = await assertStatus('POST', '/login', { username: applicant.username, password: 'password123' }, 200, 'approved applicant manager login');
    assert(owner.role === 'manager' && owner.organizationId, 'approved applicant becomes organization manager');
    const invite = await assertStatus('POST', '/organizations/invites', { maxUses: 1, expiresInDays: 1 }, 201, 'create single-use invite', owner.token);
    const member = await assertStatus('POST', '/register', { email: `org_member_${stamp}@example.test`, name: 'Invited Member', password: 'password123' }, 200, 'invited member signup');
    const redemption = await assertStatus('POST', '/organizations/redeem-invite', { code: invite.code }, 200, 'redeem invite', member.token);
    assert(Number(redemption.organization.id) === Number(owner.organizationId), 'invite should join the verified organization');
    await assertStatus('POST', '/organizations/redeem-invite', { code: invite.code }, 409, 'prevent duplicate membership', member.token);
    const orgProject = await assertStatus('POST', '/projects', { name: 'Verified workflow project' }, 200, 'create organization project', owner.token);
    const orgTask = await assertStatus('POST', '/tasks', { projectId: orgProject.id, title: 'Subtask workflow', assignedTo: member.id }, 200, 'create organization task', owner.token);
    const subtask = await assertStatus('POST', `/tasks/${orgTask.id}/subtasks`, { title: 'Reviewed milestone', assignedTo: member.id }, 201, 'create subtask', owner.token);
    await assertStatus('POST', `/subtasks/${subtask.id}/submit`, { submissionText: 'Completed and ready for review.' }, 200, 'submit subtask', member.token);
    await assertStatus('POST', `/subtasks/${subtask.id}/review`, { action: 'approve', reviewComment: 'Accepted.' }, 200, 'approve subtask', owner.token);
    const orgDashboard = await assertStatus('GET', `/dashboard/${owner.id}`, null, 200, 'organization manager dashboard', owner.token);
    const progressTask = orgDashboard.allTasks.find((row) => Number(row.id) === Number(orgTask.id));
    assert(progressTask && Number(progressTask.progress) === 100, 'subtask approval calculates task progress');
    let loginLimitReached = false;
    for (let attempt = 0; attempt < 16; attempt += 1) {
        const response = await request('POST', '/login', { username: `missing_${stamp}`, password: 'wrong-password' });
        if (response.status === 429) {
            loginLimitReached = true;
            break;
        }
        assert(response.status === 401, `failed login attempt ${attempt + 1} | expected 401 or 429, got ${response.status}`);
    }
    assert(loginLimitReached, 'repeated login attempts must be rate limited');
}

async function main() {
    const mode = process.argv.includes('--full') ? 'full' : 'basic';
    let server;
    let spawnedServer = false;
    try {
        console.log(`Starting simulation (${mode})...`);
        if (await isServerReachable()) {
            console.log(`Using existing server on port ${PORT}.`);
        } else {
            if (mode === 'full') globalThis.simPlatformCredentials = await seedSimulationPlatformAdmin();
            server = await startServer();
            spawnedServer = true;
        }
        if (mode === 'full') {
            await runFullScenario();
        } else {
            await runBasicScenario();
        }
        console.log(`Simulation (${mode}) completed successfully.`);
    } catch (error) {
        console.error("Simulation failed:", error ? (error.stack || error.message || error) : "unknown error");
        process.exitCode = 1;
    } finally {
        if (spawnedServer) {
            await stopServer(server);
        }
    }
}

main();
