const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.ORION_DB_PATH = path.join(os.tmpdir(), `orion-tasks-crud-${process.pid}.db`);
try { fs.rmSync(process.env.ORION_DB_PATH, { force: true }); } catch (_error) {}

const { BackendData } = require('./backend_data');
const { BackendServices, ApiError } = require('./backend_services');

async function expectError(work, status, text) {
    await assert.rejects(work, (error) => {
        const matchesStatus = error instanceof ApiError && error.status === status;
        const matchesText = !text || (error.message && error.message.toLowerCase().includes(text.toLowerCase()));
        return matchesStatus && matchesText;
    }, `Expected ApiError with status ${status}${text ? ` matching "${text}"` : ''}`);
}

async function createUser(services, email, role = 'worker') {
    const user = await services.registerUser({
        email,
        username: email,
        name: email.split('@')[0],
        password: 'correct-horse-42',
        role
    });
    return user;
}

async function run() {
    const data = new BackendData();
    await data.init();
    const services = new BackendServices(data);

    try {
        console.log('--- Setting up test users and organizations ---');
        // Platform Admin
        const adminUser = await createUser(services, 'superadmin@test.local');
        await data.run("UPDATE users SET role='exec' WHERE id=?", [adminUser.id]);
        await services.loadPlatformAdmins();

        // Org 1 Manager & Workers
        const manager1 = await createUser(services, 'manager1@org1.test', 'manager');
        const app1 = await services.submitOrganizationApplication(manager1.id, {
            legalName: 'Organization Alpha',
            type: 'Private',
            officialEmail: 'contact@org1.test',
            contactName: 'Manager One'
        });
        const decision1 = await services.reviewOrganizationApplication(app1.id, adminUser.id, 'approve', 'Approved Org 1');
        const org1Id = decision1.institutionId;

        const worker1 = await createUser(services, 'worker1@org1.test');
        const invite1 = await services.createOrganizationInvite(manager1.id, { maxUses: 2, expiresInDays: 1 });
        await services.redeemOrganizationInvite(worker1.id, invite1.code);

        const worker2 = await createUser(services, 'worker2@org1.test');
        await services.redeemOrganizationInvite(worker2.id, invite1.code);

        // Org 2 Manager & Worker (for cross-org testing)
        const manager2 = await createUser(services, 'manager2@org2.test', 'manager');
        const app2 = await services.submitOrganizationApplication(manager2.id, {
            legalName: 'Organization Beta',
            type: 'Private',
            officialEmail: 'contact@org2.test',
            contactName: 'Manager Two'
        });
        const decision2 = await services.reviewOrganizationApplication(app2.id, adminUser.id, 'approve', 'Approved Org 2');
        const org2Id = decision2.institutionId;

        const worker3 = await createUser(services, 'worker3@org2.test');
        const invite2 = await services.createOrganizationInvite(manager2.id, { maxUses: 1, expiresInDays: 1 });
        await services.redeemOrganizationInvite(worker3.id, invite2.code);

        // Project in Org 1
        const project1 = await services.createProject({ name: 'Alpha Delivery Project', creatorId: manager1.id });

        console.log('--- Test 1: Task Creation with Description & Priority (Schema & Service check) ---');
        const createdTask = await services.createTask({
            projectId: project1.id,
            title: 'Initial Task',
            assignedTo: worker1.id,
            deadline: '2026-12-31',
            createdBy: manager1.id,
            description: 'Task detailed instructions',
            priority: 'high'
        });
        assert.ok(createdTask.id > 0);
        const task1Row = await data.get('SELECT * FROM tasks WHERE id = ?', [createdTask.id]);
        assert.strictEqual(task1Row.title, 'Initial Task');
        assert.strictEqual(task1Row.description, 'Task detailed instructions');
        assert.strictEqual(task1Row.priority, 'high');
        assert.strictEqual(task1Row.status, 'In Progress');
        assert.strictEqual(task1Row.progress, 0);

        console.log('--- Test 2: Update Task (Happy Path: title, description, status, priority, deadline, progress) ---');
        const updatedTask = await services.updateTask({
            taskId: createdTask.id,
            title: 'Updated Task Title',
            description: 'Refined description with more detail',
            status: 'In Progress',
            priority: 'urgent',
            deadline: '2027-01-15',
            progress: 50,
            requesterId: manager1.id
        });
        assert.strictEqual(updatedTask.id, createdTask.id);
        assert.strictEqual(updatedTask.title, 'Updated Task Title');
        assert.strictEqual(updatedTask.description, 'Refined description with more detail');
        assert.strictEqual(updatedTask.priority, 'urgent');
        assert.strictEqual(updatedTask.status, 'In Progress');
        assert.strictEqual(updatedTask.deadline, '2027-01-15');
        assert.strictEqual(updatedTask.progress, 50);

        // Verify project progress was recalculated
        const projectAfterUpdate = await data.get('SELECT progress, status FROM projects WHERE id = ?', [project1.id]);
        assert.strictEqual(projectAfterUpdate.progress, 50);
        assert.strictEqual(projectAfterUpdate.status, 'In Progress');

        // Verify activity log
        const lastUpdate = await data.get('SELECT * FROM updates WHERE organizationId = ? ORDER BY id DESC LIMIT 1', [org1Id]);
        assert.ok(lastUpdate.text.includes('Updated task "Updated Task Title"'));

        console.log('--- Test 3: Reassign Task (Happy Path) ---');
        const reassignedTask = await services.reassignTask({
            taskId: createdTask.id,
            newAssigneeId: worker2.id,
            requesterId: manager1.id
        });
        assert.strictEqual(reassignedTask.assignedTo, worker2.id);
        const taskRowAfterReassign = await data.get('SELECT assignedTo FROM tasks WHERE id = ?', [createdTask.id]);
        assert.strictEqual(taskRowAfterReassign.assignedTo, worker2.id);

        const lastUpdateReassign = await data.get('SELECT * FROM updates WHERE organizationId = ? ORDER BY id DESC LIMIT 1', [org1Id]);
        assert.ok(lastUpdateReassign.text.includes('Reassigned task'));

        console.log('--- Test 4: Delete Task with Cascade (task_reports, subtasks, subtask_events) ---');
        // Create a subtask under Task 1
        const subtask = await services.createSubtask(manager1.id, {
            parentTaskId: createdTask.id,
            title: 'Subtask for Task 1',
            assignedTo: worker2.id,
            weight: 2
        });

        // BE-02: Enforce subtask progress invariant
        await assert.rejects(
            () => services.updateTask({
                taskId: createdTask.id,
                progress: 80,
                requesterId: manager1.id
            }),
            (err) => {
                assert.strictEqual(err.status, 409);
                assert.ok(err.message.includes('Cannot directly set progress on a task with subtasks'));
                return true;
            }
        );

        await assert.rejects(
            () => services.updateTask({
                taskId: createdTask.id,
                status: 'Completed',
                requesterId: manager1.id
            }),
            (err) => {
                assert.strictEqual(err.status, 409);
                assert.ok(err.message.includes('Cannot directly mark task as Completed when active subtasks exist'));
                return true;
            }
        );
        // Worker submits subtask (creates subtask_events row)
        await services.submitSubtask(subtask.id, worker2.id, { submissionText: 'Subtask done' });

        // Add a task report directly to verify cascade
        await data.run(
            'INSERT INTO task_reports (taskId, submittedBy, proposedProgress, reportText, createdAt) VALUES (?, ?, ?, ?, ?)',
            [createdTask.id, worker2.id, 75, 'Progress report', Date.now()]
        );

        // Verify rows exist before deletion
        const subtasksBefore = await data.all('SELECT id FROM subtasks WHERE parentTaskId = ?', [createdTask.id]);
        assert.strictEqual(subtasksBefore.length, 1);
        const subtaskEventsBefore = await data.all('SELECT id FROM subtask_events WHERE subtaskId = ?', [subtask.id]);
        assert.strictEqual(subtaskEventsBefore.length, 1);
        const reportsBefore = await data.all('SELECT id FROM task_reports WHERE taskId = ?', [createdTask.id]);
        assert.strictEqual(reportsBefore.length, 1);

        // Delete the task
        const deleteResult = await services.deleteTask({
            taskId: createdTask.id,
            requesterId: manager1.id
        });
        assert.deepStrictEqual(deleteResult, { success: true, deletedTaskId: createdTask.id });

        // Verify cascade deletion
        const taskAfter = await data.get('SELECT id FROM tasks WHERE id = ?', [createdTask.id]);
        assert.strictEqual(taskAfter, undefined);
        const subtasksAfter = await data.all('SELECT id FROM subtasks WHERE parentTaskId = ?', [createdTask.id]);
        assert.strictEqual(subtasksAfter.length, 0);
        const subtaskEventsAfter = await data.all('SELECT id FROM subtask_events WHERE subtaskId = ?', [subtask.id]);
        assert.strictEqual(subtaskEventsAfter.length, 0);
        const reportsAfter = await data.all('SELECT id FROM task_reports WHERE taskId = ?', [createdTask.id]);
        assert.strictEqual(reportsAfter.length, 0);

        // Verify project progress recalculated to 0 (no tasks remain)
        const projectAfterDelete = await data.get('SELECT progress, status FROM projects WHERE id = ?', [project1.id]);
        assert.strictEqual(projectAfterDelete.progress, 0);
        assert.strictEqual(projectAfterDelete.status, 'In Planning');

        // Verify activity log
        const lastUpdateDelete = await data.get('SELECT * FROM updates WHERE organizationId = ? ORDER BY id DESC LIMIT 1', [org1Id]);
        assert.ok(lastUpdateDelete.text.includes('Deleted task'));

        console.log('--- Test 5: Recalculate Project Progress Verification ---');
        // Create 2 tasks in Project 1
        const taskA = await services.createTask({
            projectId: project1.id,
            title: 'Task A',
            assignedTo: worker1.id,
            createdBy: manager1.id
        });
        const taskB = await services.createTask({
            projectId: project1.id,
            title: 'Task B',
            assignedTo: worker2.id,
            createdBy: manager1.id
        });

        // Update progress of Task A to 40, Task B to 80
        await services.updateTask({ taskId: taskA.id, progress: 40, requesterId: manager1.id });
        await services.updateTask({ taskId: taskB.id, progress: 80, requesterId: manager1.id });
        const projMid = await data.get('SELECT progress, status FROM projects WHERE id = ?', [project1.id]);
        assert.strictEqual(projMid.progress, 60); // (40 + 80) / 2 = 60
        assert.strictEqual(projMid.status, 'In Progress');

        // Delete Task A -> project progress should now be 80% (just Task B)
        await services.deleteTask({ taskId: taskA.id, requesterId: manager1.id });
        const projAfterTaskADelete = await data.get('SELECT progress, status FROM projects WHERE id = ?', [project1.id]);
        assert.strictEqual(projAfterTaskADelete.progress, 80);

        // Update Task B to 100% -> project progress should be 100%, status 'Completed'
        await services.updateTask({ taskId: taskB.id, progress: 100, requesterId: manager1.id });
        const projDone = await data.get('SELECT progress, status FROM projects WHERE id = ?', [project1.id]);
        assert.strictEqual(projDone.progress, 100);
        assert.strictEqual(projDone.status, 'Completed');

        console.log('--- Test 6: Worker Progress Update Rejection (410) ---');
        // Worker attempting updateTask throws 410
        await expectError(
            () => services.updateTask({ taskId: taskB.id, progress: 50, requesterId: worker1.id }),
            410,
            'Direct progress updates are disabled'
        );
        // Worker attempting updateTaskLegacy throws 410
        await expectError(
            () => services.updateTaskLegacy({ taskId: taskB.id, progress: 50, requesterId: worker1.id }),
            410,
            'Direct progress updates are disabled'
        );

        console.log('--- Test 7: Authorization / Forbidden (403) ---');
        // Manager from Org 2 trying to update task in Org 1
        await expectError(
            () => services.updateTask({ taskId: taskB.id, title: 'Hijacked Title', requesterId: manager2.id }),
            403,
            'Access denied'
        );
        // Manager from Org 2 trying to reassign task in Org 1
        await expectError(
            () => services.reassignTask({ taskId: taskB.id, newAssigneeId: worker3.id, requesterId: manager2.id }),
            403,
            'Access denied'
        );
        // Manager from Org 2 trying to delete task in Org 1
        await expectError(
            () => services.deleteTask({ taskId: taskB.id, requesterId: manager2.id }),
            403,
            'Access denied'
        );
        // Worker trying to reassign task
        await expectError(
            () => services.reassignTask({ taskId: taskB.id, newAssigneeId: worker1.id, requesterId: worker1.id }),
            403,
            'Access denied'
        );
        // Worker trying to delete task
        await expectError(
            () => services.deleteTask({ taskId: taskB.id, requesterId: worker1.id }),
            403,
            'Access denied'
        );
        // Manager 1 trying to reassign task to worker in another organization (worker3 in Org 2)
        await expectError(
            () => services.reassignTask({ taskId: taskB.id, newAssigneeId: worker3.id, requesterId: manager1.id }),
            403,
            'Cannot assign tasks to workers in another organization'
        );

        console.log('--- Test 8: Not Found (404) ---');
        // Update non-existent task
        await expectError(
            () => services.updateTask({ taskId: 999999, title: 'Non-existent', requesterId: manager1.id }),
            404,
            'Task not found'
        );
        // Reassign non-existent task
        await expectError(
            () => services.reassignTask({ taskId: 999999, newAssigneeId: worker1.id, requesterId: manager1.id }),
            404,
            'Task not found'
        );
        // Reassign to non-existent worker
        await expectError(
            () => services.reassignTask({ taskId: taskB.id, newAssigneeId: 999999, requesterId: manager1.id }),
            404,
            'New assignee not found'
        );
        // Delete non-existent task
        await expectError(
            () => services.deleteTask({ taskId: 999999, requesterId: manager1.id }),
            404,
            'Task not found'
        );

        console.log('--- Test 9: Invalid Input (400) ---');
        // Update with empty title
        await expectError(
            () => services.updateTask({ taskId: taskB.id, title: '   ', requesterId: manager1.id }),
            400,
            'Task title cannot be empty'
        );
        // Update with title > 200 chars
        await expectError(
            () => services.updateTask({ taskId: taskB.id, title: 'A'.repeat(201), requesterId: manager1.id }),
            400,
            'Task title must be 200 characters or fewer'
        );
        // Update with description > 2000 chars
        await expectError(
            () => services.updateTask({ taskId: taskB.id, description: 'D'.repeat(2001), requesterId: manager1.id }),
            400,
            'Task description must be 2000 characters or fewer'
        );
        // Update with invalid status
        await expectError(
            () => services.updateTask({ taskId: taskB.id, status: 'NotAStatus', requesterId: manager1.id }),
            400,
            'Invalid task status'
        );
        // Update with invalid priority
        await expectError(
            () => services.updateTask({ taskId: taskB.id, priority: 'critical-high', requesterId: manager1.id }),
            400,
            'Invalid task priority'
        );
        // Update with invalid progress (negative or > 100 or non-integer)
        await expectError(
            () => services.updateTask({ taskId: taskB.id, progress: 101, requesterId: manager1.id }),
            400,
            'Progress must be an integer between 0 and 100'
        );
        await expectError(
            () => services.updateTask({ taskId: taskB.id, progress: -5, requesterId: manager1.id }),
            400,
            'Progress must be an integer between 0 and 100'
        );
        await expectError(
            () => services.updateTask({ taskId: taskB.id, progress: 50.5, requesterId: manager1.id }),
            400,
            'Progress must be an integer between 0 and 100'
        );
        // Update with invalid deadline
        await expectError(
            () => services.updateTask({ taskId: taskB.id, deadline: 'not-a-date', requesterId: manager1.id }),
            400,
            'Invalid deadline date'
        );
        // Reassign without newAssigneeId
        await expectError(
            () => services.reassignTask({ taskId: taskB.id, newAssigneeId: null, requesterId: manager1.id }),
            400,
            'New assignee ID is required'
        );
        // Reassign to non-worker user (manager1 has role manager)
        await expectError(
            () => services.reassignTask({ taskId: taskB.id, newAssigneeId: manager1.id, requesterId: manager1.id }),
            400,
            'Tasks can only be assigned to workers'
        );
        // Delete without taskId
        await expectError(
            () => services.deleteTask({ taskId: null, requesterId: manager1.id }),
            400,
            'Task ID is required'
        );

        console.log('--- Test 10: Platform Admin Access ---');
        // Platform admin can update, reassign, and delete any task across any org
        const adminUpdated = await services.updateTask({
            taskId: taskB.id,
            title: 'Admin Edited Task',
            requesterId: adminUser.id
        });
        assert.strictEqual(adminUpdated.title, 'Admin Edited Task');

        const adminReassigned = await services.reassignTask({
            taskId: taskB.id,
            newAssigneeId: worker1.id,
            requesterId: adminUser.id
        });
        assert.strictEqual(adminReassigned.assignedTo, worker1.id);

        const adminDeleted = await services.deleteTask({
            taskId: taskB.id,
            requesterId: adminUser.id
        });
        assert.strictEqual(adminDeleted.success, true);

        console.log('ALL TASK CRUD TESTS PASSED!');
    } finally {
        await data.close();
        try { fs.rmSync(process.env.ORION_DB_PATH, { force: true }); } catch (_error) {}
    }
}

run().catch((error) => {
    console.error('Task CRUD tests failed:', error);
    process.exit(1);
});
