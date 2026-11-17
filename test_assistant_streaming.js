const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `test_assistant_stream_${process.pid}.db`);
process.env.ORION_DB_PATH = testDbPath;
try { fs.rmSync(testDbPath, { force: true }); } catch (_error) {}

const { BackendData } = require('./backend_data');
const { BackendServices, ApiError } = require('./backend_services');

async function runAssistantStreamingTests() {
    console.log('=== STARTING AI ASSISTANT STREAMING TEST SUITE ===\n');

    const db = new BackendData();
    await db.init();
    const services = new BackendServices(db, { geminiModel: 'gemini-2.0-flash' });

    // Setup Test Organization, Users, and Projects
    const manager = await services.registerUser({
        name: 'Vikram Stream Manager',
        email: 'vikram.stream@isro.test',
        username: 'vikram_stream',
        password: 'Password123!',
        role: 'manager'
    });

    const isroInst = await services.addInstitution({
        name: 'ISRO Stream Facility',
        type: 'Autonomous Body',
        contact: 'stream@isro.test',
        creatorId: manager.id
    });
    const orgId = isroInst.id;
    await db.run('UPDATE users SET organizationId = ? WHERE id = ?', [orgId, manager.id]);

    const worker = await services.registerUser({
        name: 'Asha Stream Worker',
        email: 'asha.stream@isro.test',
        username: 'asha_stream',
        password: 'Password123!',
        role: 'worker'
    });
    await db.run('UPDATE users SET organizationId = ? WHERE id = ?', [orgId, worker.id]);

    const project = await services.createProject({
        name: 'Gaganyaan Avionics Stream Test',
        creatorId: manager.id
    });

    const pastDeadline = Date.now() - 3600000;
    const task1 = await services.createTask({
        projectId: project.id,
        title: 'Calibrate Gyroscope Sensors',
        description: 'Sensor drift telemetry verification',
        assignedTo: worker.id,
        deadline: pastDeadline,
        priority: 'high',
        createdBy: manager.id
    });

    // -------------------------------------------------------------------------
    // Test 1: Progressive Chunk Streaming on Local Rule Engine
    // -------------------------------------------------------------------------
    console.log('--- Test 1: Progressive Chunk Streaming on Local Rule Engine ---');
    const receivedChunks = [];
    const onChunk = (chunk) => {
        receivedChunks.push(chunk);
    };

    const res1 = await services.assistantChatStream(
        manager.id,
        { message: 'What tasks are overdue?' },
        onChunk
    );

    assert.ok(receivedChunks.length > 0, 'Should have received multiple streaming chunks');
    assert.strictEqual(res1.mode, 'local_rule_engine', 'Mode must be local_rule_engine when no Gemini key is active');
    const assembledText = receivedChunks.join('');
    assert.strictEqual(assembledText, res1.text, 'Assembled stream chunks must equal returned text');
    assert.ok(res1.text.includes('Calibrate Gyroscope Sensors'), 'Result must include overdue task');
    console.log(`[PASS] Received ${receivedChunks.length} progressive chunks matching final output.\n`);

    // -------------------------------------------------------------------------
    // Test 2: Proposal Generation via Stream
    // -------------------------------------------------------------------------
    console.log('--- Test 2: Action Proposal Generation via Stream ---');
    const proposalChunks = [];
    const res2 = await services.assistantChatStream(
        manager.id,
        { message: `Reassign task ${task1.id} to Asha` },
        (c) => proposalChunks.push(c)
    );

    assert.ok(res2.proposal, 'Assistant must generate action proposal');
    assert.strictEqual(res2.proposal.type, 'reassign_task');
    assert.strictEqual(res2.proposal.taskId, task1.id);
    assert.strictEqual(res2.proposal.newAssigneeId, worker.id);
    console.log('[PASS] Action proposal generated with explicit confirmation requirement.\n');

    // -------------------------------------------------------------------------
    // Test 3: Action Execution via Stream
    // -------------------------------------------------------------------------
    console.log('--- Test 3: Action Execution via Stream ---');
    const execChunks = [];
    const res3 = await services.assistantChatStream(
        manager.id,
        { confirmedAction: res2.proposal },
        (c) => execChunks.push(c)
    );

    assert.strictEqual(res3.actionExecuted, true, 'Confirmed action must execute');
    assert.strictEqual(res3.mode, 'local_rule_engine');
    assert.ok(execChunks.length > 0, 'Execution confirmation must stream');
    const updatedTask = await db.get('SELECT assignedTo FROM tasks WHERE id = ?', [task1.id]);
    assert.strictEqual(updatedTask.assignedTo, worker.id, 'Task assignment must be updated in DB');
    console.log('[PASS] Confirmed action executed and streamed response.\n');

    // -------------------------------------------------------------------------
    // Test 4: Header-based API Key & Model Configuration in Gemini Streaming
    // -------------------------------------------------------------------------
    console.log('--- Test 4: Header-based Authentication & Model Verification ---');
    let capturedUrl = null;
    let capturedHeaders = null;
    let capturedBody = null;

    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        capturedUrl = url;
        capturedHeaders = options.headers;
        capturedBody = JSON.parse(options.body);

        // Mock SSE response from Gemini streamGenerateContent
        const sseContent = [
            'data: {"candidates": [{"content": {"parts": [{"text": "Streamed telemetry: "}]}}]}\n\n',
            'data: {"candidates": [{"content": {"parts": [{"text": "All systems nominal."}]}}]}\n\n',
            'data: [DONE]\n\n'
        ].join('');

        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(sseContent));
                controller.close();
            }
        });

        return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
        });
    };

    try {
        const geminiChunks = [];
        const geminiRes = await services._callGeminiAssistantStream({
            apiKey: 'test-secret-gemini-key',
            user: { id: manager.id, role: 'manager', organizationId: orgId },
            recentHistory: [],
            trimmedPrompt: 'Status check',
            targetProject: project,
            executeListTasks: async () => [],
            executeSummarizeProject: async () => ({}),
            proposeReassign: async () => ({}),
            onChunk: (c) => geminiChunks.push(c)
        });

        // 1. Verify URL does NOT leak key in query params
        assert.ok(!capturedUrl.includes('test-secret-gemini-key'), 'API Key must NEVER be in the request URL');
        assert.ok(capturedUrl.includes('gemini-2.0-flash:streamGenerateContent?alt=sse'), 'Must call streamGenerateContent with configured model');

        // 2. Verify x-goog-api-key header
        assert.strictEqual(capturedHeaders['x-goog-api-key'], 'test-secret-gemini-key', 'API key must be sent via x-goog-api-key header');

        // 3. Verify streamed chunks received
        assert.deepStrictEqual(geminiChunks, ['Streamed telemetry: ', 'All systems nominal.'], 'Chunks must be extracted from SSE stream');
        assert.strictEqual(geminiRes.text, 'Streamed telemetry: All systems nominal.');
        assert.strictEqual(geminiRes.mode, 'gemini');
        console.log('[PASS] Header-based authentication, model routing, and SSE parsing verified.\n');
    } finally {
        global.fetch = originalFetch;
    }

    // -------------------------------------------------------------------------
    // Test 5: AbortSignal Cancellation Handling
    // -------------------------------------------------------------------------
    console.log('--- Test 5: AbortSignal Handling ---');
    const ac = new AbortController();
    ac.abort();

    let aborted = false;
    global.fetch = async (url, options) => {
        if (options.signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
        }
        return new Response('{}', { status: 200 });
    };

    try {
        await services._callGeminiAssistantStream({
            apiKey: 'test-key',
            user: { id: manager.id, role: 'manager', organizationId: orgId },
            recentHistory: [],
            trimmedPrompt: 'Status check',
            targetProject: project,
            executeListTasks: async () => [],
            executeSummarizeProject: async () => ({}),
            proposeReassign: async () => ({}),
            onChunk: () => {},
            signal: ac.signal
        });
    } catch (err) {
        if (err.name === 'AbortError' || err.message.includes('aborted')) {
            aborted = true;
        }
    } finally {
        global.fetch = originalFetch;
    }

    assert.ok(aborted, 'Operation should abort when signal is already aborted');
    console.log('[PASS] AbortSignal cleanly terminates stream.\n');

    // Cleanup
    await db.close();
    try {
        if (fs.existsSync(testDbPath)) {
            fs.unlinkSync(testDbPath);
        }
    } catch (_e) {}

    console.log('=== ALL AI ASSISTANT STREAMING TESTS PASSED! ===\n');
}

runAssistantStreamingTests().catch(err => {
    console.error('Streaming test suite failed:', err);
    process.exit(1);
});
