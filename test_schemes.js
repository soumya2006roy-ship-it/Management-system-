'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { BackendData } = require('./backend_data');
const { BackendServices } = require('./backend_services');
const { hashSecret } = require('./auth_utils');

async function run() {
    process.env.NODE_ENV = 'test';
    const testDbPath = path.join(os.tmpdir(), `orion-test-schemes-${process.pid}.db`);
    process.env.ORION_DB_PATH = testDbPath;
    try { fs.rmSync(testDbPath, { force: true }); } catch (_e) {}

    const data = new BackendData();
    await data.init();
    const services = new BackendServices(data);

    console.log('=== STARTING GOVERNMENT SCHEMES TEST SUITE ===');

    // -------------------------------------------------------------
    // Test 1: Migration and Catalog Seeding
    // -------------------------------------------------------------
    console.log('\n--- Test 1: Catalog Seeding and Provenance ---');
    const schemes = await services.getGovernmentSchemes();
    assert.ok(Array.isArray(schemes), 'getGovernmentSchemes must return an array');
    assert.ok(schemes.length >= 15, 'Must seed at least 15 verified government schemes');
    for (const s of schemes) {
        assert.ok(s.title, 'Scheme must have title');
        assert.ok(s.ministry, 'Scheme must have ministry');
        assert.ok(s.sector, 'Scheme must have sector');
        assert.ok(s.portalUrl.startsWith('https://'), 'Portal URL must be valid https URL');
        assert.ok(s.sourceUrl.startsWith('https://'), 'Source URL must be valid https URL');
        assert.strictEqual(s.isSampleData, 0, 'Verified scheme must not be marked as sample data');
        assert.ok(Number(s.lastVerified) > 0, 'Must contain lastVerified timestamp');
    }
    console.log('[PASS] Catalog seeded with verified official schemes and provenance.');

    // Test filtering by sector and search
    const droneSchemes = await services.getGovernmentSchemes({ sector: 'Drones' });
    assert.strictEqual(droneSchemes.length, 1);
    assert.ok(droneSchemes[0].title.includes('Drones'));

    const searchSchemes = await services.getGovernmentSchemes({ search: 'SAMRIDH' });
    assert.strictEqual(searchSchemes.length, 1);
    assert.ok(searchSchemes[0].title.includes('SAMRIDH'));

    // -------------------------------------------------------------
    // Test 2: Rule-Based Matcher Unit Tests
    // -------------------------------------------------------------
    console.log('\n--- Test 2: Rule-Based Matcher Logic ---');
    const pliScheme = schemes.find(s => s.sector.includes('Drones'));
    
    // Low progress, non-matching sector, no tasks: score should be 15 (active status only)
    const baseProject = { id: 1, name: 'Generic Office Setup', progress: 5, status: 'In Progress' };
    const baseEval = services.calculateSchemeMatch(baseProject, pliScheme, 0, { name: 'Health Agency', type: 'Health' });
    assert.strictEqual(baseEval.matchScore, 15, 'Base project with only active status should score 15');
    assert.strictEqual(baseEval.rules.find(r => r.rule === 'project_progress_threshold').matched, false);
    assert.strictEqual(baseEval.rules.find(r => r.rule === 'sector_alignment').matched, false);
    assert.strictEqual(baseEval.rules.find(r => r.rule === 'active_lifecycle_status').matched, true);
    assert.strictEqual(baseEval.rules.find(r => r.rule === 'structured_governance').matched, false);
    assert.strictEqual(baseEval.unknownCriteria.length, 2, 'Must include 2 unknown/unverifiable criteria');
    assert.strictEqual(baseEval.unknownCriteria[0].status, 'unknown');

    // High progress, matching drone sector, with tasks: score should be 100 (35 + 35 + 15 + 15)
    const droneProject = { id: 2, name: 'Autonomous Drone Surveillance Payload', progress: 45, status: 'In Progress' };
    const droneEval = services.calculateSchemeMatch(droneProject, pliScheme, 5, { name: 'Aerospace Systems', type: 'Space & Aerospace' });
    assert.strictEqual(droneEval.matchScore, 100, 'Matching drone project should score 100');
    assert.ok(droneEval.matchReason.includes('Progress Milestone Threshold'));
    assert.ok(droneEval.matchReason.includes('Sector & Organizational Synergy'));

    // Test PROD-01: Casual/recreational project must fail sector synergy and score <= 65%
    const picnicProject = { id: 3, name: 'Drone photo of company picnic', progress: 50, status: 'In Progress' };
    const picnicEval = services.calculateSchemeMatch(picnicProject, pliScheme, 5, { name: 'Acme Media', type: 'Advertising' });
    assert.ok(picnicEval.matchScore <= 65, `Casual picnic project must score <= 65% (actual: ${picnicEval.matchScore})`);
    assert.strictEqual(picnicEval.rules.find(r => r.rule === 'sector_alignment').matched, false, 'Sector alignment must fail for casual activities');
    console.log('[PASS] Rule-based matcher accurately evaluates rules, weights, and unknown criteria.');

    // -------------------------------------------------------------
    // Test 3: Setup Organizations, Projects, and Users for Authz Tests
    // -------------------------------------------------------------
    console.log('\n--- Test 3: Tenant Scoping and Fail-Closed Authorization ---');
    // Org A
    const orgARes = await data.run("INSERT INTO institutions (name, type, contact, verificationStatus) VALUES ('ISRO Satellite Center', 'Government – Space', 'contact@isro.gov.in', 'approved')");
    const orgAId = orgARes.lastID;
    
    // Org B
    const orgBRes = await data.run("INSERT INTO institutions (name, type, contact, verificationStatus) VALUES ('Urban Transport Corp', 'Municipal Utility', 'info@transport.gov.in', 'approved')");
    const orgBId = orgBRes.lastID;

    // Users
    const pwdHash = await hashSecret('SecurePass@123');
    const mgrARes = await data.run("INSERT INTO users (username, password, name, role, organizationId) VALUES ('managerA@isro.gov.in', ?, 'Manager A', 'manager', ?)", [pwdHash, orgAId]);
    const mgrAId = mgrARes.lastID;

    const wkrARes = await data.run("INSERT INTO users (username, password, name, role, organizationId) VALUES ('workerA@isro.gov.in', ?, 'Worker A', 'worker', ?)", [pwdHash, orgAId]);
    const wkrAId = wkrARes.lastID;

    const mgrBRes = await data.run("INSERT INTO users (username, password, name, role, organizationId) VALUES ('managerB@transport.gov.in', ?, 'Manager B', 'manager', ?)", [pwdHash, orgBId]);
    const mgrBId = mgrBRes.lastID;

    const noOrgUserRes = await data.run("INSERT INTO users (username, password, name, role, organizationId) VALUES ('noorg@example.test', ?, 'No Org User', 'manager', NULL)", [pwdHash]);
    const noOrgUserId = noOrgUserRes.lastID;

    // Project under Org A
    const projARes = await data.run("INSERT INTO projects (name, progress, status, organizationId) VALUES ('Gaganyaan Crew Module Avionics', 30, 'In Progress', ?)", [orgAId]);
    const projAId = projARes.lastID;
    await data.run("INSERT INTO tasks (projectId, title, status, priority) VALUES (?, 'Telemetry Systems', 'In Progress', 'high')", [projAId]);

    // Test 3.1: Missing User -> 401
    await assert.rejects(
        () => services.getSchemesForProject(null, projAId),
        /Unauthorized/
    );

    // Test 3.2: User with NULL organizationId -> 403 Fail-Closed
    await assert.rejects(
        () => services.getSchemesForProject(noOrgUserId, projAId),
        /Access denied/
    );

    // Test 3.3: Cross-tenant access (User from Org B querying Project under Org A) -> 403 Fail-Closed
    await assert.rejects(
        () => services.getSchemesForProject(mgrBId, projAId),
        /Access denied/
    );

    // Test 3.4: Legitimate member of Org A querying Project A -> Success
    const orgASchemes = await services.getSchemesForProject(mgrAId, projAId);
    assert.strictEqual(orgASchemes.length, schemes.length);
    assert.ok(orgASchemes[0].matchScore > 0);
    assert.strictEqual(orgASchemes[0].applicationStatus, 'recommended');
    console.log('[PASS] Tenant scoping verified: missing org, null tenant, and cross-org access strictly blocked.');

    // -------------------------------------------------------------
    // Test 4: Role-Gating and Idempotent Application
    // -------------------------------------------------------------
    console.log('\n--- Test 4: Role-Gating and Idempotent Application ---');
    const targetSchemeId = pliScheme.id;

    // Test 4.1: Worker role cannot apply -> 403
    await assert.rejects(
        () => services.applyForScheme(wkrAId, projAId, targetSchemeId),
        /Only organization managers or administrators can apply/
    );

    // Test 4.2: Manager applies successfully
    const applyRes1 = await services.applyForScheme(mgrAId, projAId, targetSchemeId);
    assert.strictEqual(applyRes1.success, true);
    assert.strictEqual(applyRes1.applicationStatus, 'applied');
    assert.ok(applyRes1.matchScore > 0);
    assert.notStrictEqual(applyRes1.matchScore, 95, 'Match score must be calculated dynamically, not hardcoded to 95');

    // Verify row in DB
    const matchRow = await data.get('SELECT * FROM project_scheme_matches WHERE projectId = ? AND schemeId = ?', [projAId, targetSchemeId]);
    assert.ok(matchRow, 'project_scheme_matches entry must exist');
    assert.strictEqual(matchRow.applicationStatus, 'applied');

    // Test 4.3: Idempotent apply (calling apply again does not duplicate or fail)
    const applyRes2 = await services.applyForScheme(mgrAId, projAId, targetSchemeId);
    assert.strictEqual(applyRes2.success, true);
    assert.strictEqual(applyRes2.applicationStatus, 'applied');

    const matchRowsCount = await data.get('SELECT COUNT(*) AS total FROM project_scheme_matches WHERE projectId = ? AND schemeId = ?', [projAId, targetSchemeId]);
    assert.strictEqual(matchRowsCount.total, 1, 'UNIQUE constraint must prevent duplicate application records');

    // Test 4.4: getSchemesForProject reflects applied status
    const evaluatedUpdated = await services.getSchemesForProject(mgrAId, projAId);
    const appliedScheme = evaluatedUpdated.find(s => s.id === targetSchemeId);
    assert.strictEqual(appliedScheme.applicationStatus, 'applied');
    assert.ok(appliedScheme.appliedAt > 0);
    console.log('[PASS] Role-gating enforced and idempotent application verified with dynamic scores.');

    // -------------------------------------------------------------
    // Test 5: AI Assistant Integration
    // -------------------------------------------------------------
    console.log('\n--- Test 5: AI Assistant Schemes Integration ---');
    const localReply = await services._runLocalAssistantEngine({
        user: { id: mgrAId, role: 'manager', organizationId: orgAId },
        trimmedPrompt: 'Which government schemes or subsidies can we apply for?',
        projectId: projAId,
        executeListTasks: async () => [],
        executeSummarizeProject: async () => ({}),
        proposeReassign: async () => ({})
    });
    assert.ok(localReply.text.includes('government scheme eligibility evaluations'));
    assert.ok(localReply.text.includes('Match'));
    assert.ok(localReply.text.includes('APPLIED'));
    console.log('[PASS] Assistant successfully answers government scheme queries without duplicate logic.');

    // -------------------------------------------------------------
    // Test 6: Compliance Readiness Tracking (PROD-01 / PROD-02)
    // -------------------------------------------------------------
    console.log('\n--- Test 6: Compliance Readiness Tracking & Role Gating ---');
    // 6.1: Worker cannot update readiness -> 403
    await assert.rejects(
        () => services.updateSchemeReadiness(wkrAId, projAId, targetSchemeId, 'financial_audit', 'in_progress'),
        /Only managers, executives, or administrators can update compliance readiness/
    );

    // 6.2: Cross-tenant cannot update readiness -> 403
    await assert.rejects(
        () => services.updateSchemeReadiness(mgrBId, projAId, targetSchemeId, 'financial_audit', 'in_progress'),
        /Access denied: Project does not belong to your organization/
    );

    // 6.3: Invalid status -> 400
    await assert.rejects(
        () => services.updateSchemeReadiness(mgrAId, projAId, targetSchemeId, 'financial_audit', 'not_a_valid_status'),
        /Invalid readiness status/
    );

    // 6.4: Manager updates readiness successfully
    const readinessRes1 = await services.updateSchemeReadiness(mgrAId, projAId, targetSchemeId, 'financial_audit', 'in_progress');
    assert.strictEqual(readinessRes1.success, true);
    assert.strictEqual(readinessRes1.status, 'in_progress');

    const readinessRes2 = await services.updateSchemeReadiness(mgrAId, projAId, targetSchemeId, 'dva_certificate', 'verified');
    assert.strictEqual(readinessRes2.success, true);
    assert.strictEqual(readinessRes2.status, 'verified');

    // 6.5: Verify getSchemesForProject reflects updated readiness states
    const updatedProjectSchemes = await services.getSchemesForProject(mgrAId, projAId);
    const targetEvaluated = updatedProjectSchemes.find(s => s.id === targetSchemeId);
    assert.ok(targetEvaluated, 'Target scheme must be in evaluated list');
    const finCriterion = targetEvaluated.unknownCriteria.find(c => c.criterionKey === 'financial_audit');
    const dvaCriterion = targetEvaluated.unknownCriteria.find(c => c.criterionKey === 'dva_certificate');
    assert.strictEqual(finCriterion.status, 'in_progress');
    assert.strictEqual(dvaCriterion.status, 'verified');
    console.log('[PASS] Compliance readiness states persisted, role-gated, and reflected in evaluations.');

    // -------------------------------------------------------------
    // Test 7: Feed Ingestion Interface (PROD-02)
    // -------------------------------------------------------------
    console.log('\n--- Test 7: Government Schemes Feed Ingestion ---');
    // Non-array rejected
    await assert.rejects(
        () => services.ingestSchemesFromFeed('invalid_feed'),
        /Feed items must be an array/
    );

    const testFeed = [
        {
            title: 'National Green Hydrogen Mission Incentive',
            ministry: 'Ministry of New and Renewable Energy',
            sector: 'Clean Tech & Renewable Energy',
            description: 'Financial incentives for domestic electrolyser manufacturing and green hydrogen production.',
            eligibilityCriteria: 'Minimum 30% local value addition and certified renewable energy compliance.',
            maxFundingAmount: 500000000,
            subsidyPercentage: 25.0,
            portalUrl: 'https://mnre.gov.in/green-hydrogen',
            sourceUrl: 'https://mnre.gov.in/notices/gh-incentive-2026',
            isSampleData: 0
        }
    ];

    const ingestResult = await services.ingestSchemesFromFeed(testFeed);
    assert.strictEqual(ingestResult.success, true);
    assert.strictEqual(ingestResult.count, 1);
    assert.strictEqual(ingestResult.ingested[0].action, 'inserted');

    const allSchemesAfterIngest = await services.getGovernmentSchemes();
    assert.strictEqual(allSchemesAfterIngest.length, schemes.length + 1, 'Catalog count should increase by 1 after ingest');
    const greenHydrogen = allSchemesAfterIngest.find(s => s.title.includes('Green Hydrogen'));
    assert.ok(greenHydrogen, 'Ingested scheme must exist in catalog');

    // Update existing scheme via feed
    testFeed[0].description = 'Updated description for green hydrogen mission.';
    const updateIngestResult = await services.ingestSchemesFromFeed(testFeed);
    assert.strictEqual(updateIngestResult.success, true);
    assert.strictEqual(updateIngestResult.ingested[0].action, 'updated');
    console.log('[PASS] Scheme feed ingestion validated with insertions and idempotent updates.');

    await data.close();
    try { fs.rmSync(testDbPath, { force: true }); } catch (_e) {}
    console.log('\n=== ALL GOVERNMENT SCHEMES TESTS PASSED SUCCESSFULLY! ===\n');
}

run().catch(err => {
    console.error('Schemes test failed:', err);
    process.exit(1);
});
