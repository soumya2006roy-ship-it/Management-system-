'use strict';

module.exports = async function initialSchema(data) {
        await data.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                password TEXT,
                name TEXT,
                role TEXT,
                securityQuestion TEXT,
                securityAnswer TEXT
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                progress INTEGER DEFAULT 0,
                status TEXT DEFAULT 'In Planning'
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                projectId INTEGER,
                title TEXT,
                assignedTo INTEGER,
                createdBy INTEGER,
                status TEXT,
                progress INTEGER DEFAULT 0,
                deadline TEXT
            )
        `);
        await data.ensureColumn('tasks', 'createdBy', 'INTEGER');
        await data.ensureColumn('users', 'organizationId', 'INTEGER');
        await data.ensureColumn('projects', 'organizationId', 'INTEGER');
        await data.run(`
            CREATE TABLE IF NOT EXISTS task_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                taskId INTEGER NOT NULL,
                submittedBy INTEGER NOT NULL,
                proposedProgress INTEGER NOT NULL,
                reportText TEXT,
                status TEXT DEFAULT 'pending',
                reviewedBy INTEGER,
                reviewComment TEXT,
                createdAt INTEGER NOT NULL,
                reviewedAt INTEGER
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS updates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                author TEXT,
                text TEXT,
                timestamp INTEGER
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS institutions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                type TEXT,
                contact TEXT,
                verificationStatus TEXT NOT NULL DEFAULT 'unverified'
            )
        `);
        await data.ensureColumn('institutions', 'verificationStatus', "TEXT NOT NULL DEFAULT 'unverified'");
        await data.run(`
            CREATE TABLE IF NOT EXISTS subtasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parentTaskId INTEGER NOT NULL,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                assignedTo INTEGER NOT NULL,
                createdBy INTEGER NOT NULL,
                organizationId INTEGER,
                dueDate TEXT,
                priority TEXT DEFAULT 'normal',
                weight REAL NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'in_progress',
                submissionText TEXT DEFAULT '',
                evidenceUrl TEXT DEFAULT '',
                submittedAt INTEGER,
                reviewedBy INTEGER,
                reviewedAt INTEGER,
                reviewComment TEXT DEFAULT '',
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS subtask_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                subtaskId INTEGER NOT NULL,
                actorId INTEGER NOT NULL,
                event TEXT NOT NULL,
                details TEXT DEFAULT '',
                createdAt INTEGER NOT NULL
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS organization_applications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                legalName TEXT NOT NULL,
                type TEXT NOT NULL,
                officialEmail TEXT NOT NULL,
                contactName TEXT NOT NULL,
                contactRole TEXT DEFAULT '',
                website TEXT DEFAULT '',
                description TEXT DEFAULT '',
                contact TEXT DEFAULT '',
                country TEXT DEFAULT '',
                applicantId INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending_verification',
                reviewedBy INTEGER,
                reviewComment TEXT DEFAULT '',
                createdAt INTEGER NOT NULL,
                reviewedAt INTEGER,
                institutionId INTEGER
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS organization_memberships (
                userId INTEGER NOT NULL,
                organizationId INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                createdAt INTEGER NOT NULL,
                PRIMARY KEY (userId, organizationId)
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS organization_invites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                organizationId INTEGER NOT NULL,
                codeHash TEXT NOT NULL UNIQUE,
                createdBy INTEGER NOT NULL,
                createdAt INTEGER NOT NULL,
                expiresAt INTEGER NOT NULL,
                maxUses INTEGER NOT NULL DEFAULT 1,
                usedCount INTEGER NOT NULL DEFAULT 0,
                revokedAt INTEGER
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS organization_invite_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                inviteId INTEGER NOT NULL,
                actorId INTEGER NOT NULL,
                event TEXT NOT NULL,
                createdAt INTEGER NOT NULL
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS api_rate_limits (
                bucketKey TEXT PRIMARY KEY,
                windowStart INTEGER NOT NULL,
                requestCount INTEGER NOT NULL
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS sessions (
                tokenHash TEXT PRIMARY KEY,
                userId INTEGER NOT NULL,
                createdAt INTEGER NOT NULL,
                expiresAt INTEGER NOT NULL
            )
        `);
        await data.run(`
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                tokenHash TEXT PRIMARY KEY,
                userId INTEGER NOT NULL,
                createdAt INTEGER NOT NULL,
                expiresAt INTEGER NOT NULL,
                usedAt INTEGER
            )
        `);
        await data.run('CREATE INDEX IF NOT EXISTS idx_password_reset_expiry ON password_reset_tokens(expiresAt)');
        await data.ensureColumn('updates', 'organizationId', 'INTEGER');
        await data.run('CREATE INDEX IF NOT EXISTS idx_tasks_assignedTo ON tasks(assignedTo)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_tasks_createdBy ON tasks(createdBy)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_tasks_projectId ON tasks(projectId)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_reports_taskId ON task_reports(taskId)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_reports_status ON task_reports(status)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_reports_submittedBy ON task_reports(submittedBy)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_reports_reviewedBy ON task_reports(reviewedBy)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organizationId)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_users_org ON users(organizationId)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_updates_org ON updates(organizationId)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_subtasks_parent ON subtasks(parentTaskId, status)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_subtasks_assignee ON subtasks(assignedTo, status)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_subtask_events_subtask ON subtask_events(subtaskId, createdAt)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_org_apps_status ON organization_applications(status, createdAt)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_org_memberships_org ON organization_memberships(organizationId, role)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_invites_org ON organization_invites(organizationId, revokedAt)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId)');
        await data.run('CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expiresAt)');
};
