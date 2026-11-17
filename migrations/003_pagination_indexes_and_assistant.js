'use strict';

module.exports = async function paginationIndexesAndAssistant(data) {
    // Indexes for tasks cursor pagination and filtering
    await data.run('CREATE INDEX IF NOT EXISTS idx_tasks_project_id_desc ON tasks(projectId, id DESC)');
    await data.run('CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id_desc ON tasks(assignedTo, id DESC)');
    await data.run('CREATE INDEX IF NOT EXISTS idx_tasks_createdby_id_desc ON tasks(createdBy, id DESC)');
    await data.run('CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(projectId, status, id DESC)');
    await data.run('CREATE INDEX IF NOT EXISTS idx_tasks_deadline_id ON tasks(deadline, id)');

    // Indexes for projects and users offset pagination and ordering
    await data.run('CREATE INDEX IF NOT EXISTS idx_projects_org_name ON projects(organizationId, name COLLATE NOCASE)');
    await data.run('CREATE INDEX IF NOT EXISTS idx_users_org_name ON users(organizationId, name COLLATE NOCASE)');
    await data.run('CREATE INDEX IF NOT EXISTS idx_institutions_status_name ON institutions(verificationStatus, name COLLATE NOCASE)');

    // Indexes for updates cursor pagination
    await data.run('CREATE INDEX IF NOT EXISTS idx_updates_org_timestamp ON updates(organizationId, timestamp DESC, id DESC)');
    await data.run('CREATE INDEX IF NOT EXISTS idx_subtasks_parent_id ON subtasks(parentTaskId, id)');

    // AI Assistant conversation history
    await data.run(`
        CREATE TABLE IF NOT EXISTS assistant_conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER NOT NULL,
            projectId INTEGER,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            createdAt INTEGER NOT NULL
        )
    `);
    await data.run('CREATE INDEX IF NOT EXISTS idx_assistant_conv_user ON assistant_conversations(userId, projectId, createdAt DESC)');
};
