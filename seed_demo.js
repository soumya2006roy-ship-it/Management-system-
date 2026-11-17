#!/usr/bin/env node
'use strict';

/**
 * seed_demo.js
 * -----------
 * Creates demo accounts for every role and a sample organization so visitors
 * can log in immediately from the login page without registering.
 *
 * Accounts created:
 *   - Platform Admin  (exec)   — admin@orion.demo  / Admin@1234
 *   - Manager                  — manager@orion.demo / Manager@1234
 *   - Worker                   — worker@orion.demo  / Worker@1234
 *
 * Also creates a sample organization ("ISRO – Indian Space Research Organisation")
 * and assigns the manager + worker to it.
 *
 * Usage:  node seed_demo.js
 * Safe to run multiple times — skips accounts that already exist.
 */

const { BackendData } = require('./backend_data');
const { hashSecret } = require('./auth_utils');

const DEMO_ORG = {
    name: 'ISRO – Indian Space Research Organisation',
    type: 'Government – Space & Research',
    contact: 'info@isro.gov.in',
};

const DEMO_ACCOUNTS = [
    {
        username: 'admin@orion.demo',
        password: 'Admin@1234',
        name: 'Arjun Mehta',
        role: 'exec',
        isPlatformAdmin: true,
        assignToOrg: false,
    },
    {
        username: 'manager@orion.demo',
        password: 'Manager@1234',
        name: 'Priya Sharma',
        role: 'manager',
        isPlatformAdmin: false,
        assignToOrg: true,
        orgRole: 'admin',
    },
    {
        username: 'worker@orion.demo',
        password: 'Worker@1234',
        name: 'Rahul Verma',
        role: 'worker',
        isPlatformAdmin: false,
        assignToOrg: true,
        orgRole: 'member',
    },
];

async function seed() {
    const data = new BackendData();
    await data.init();

    console.log('\n  ORION — Demo Account Seeder');
    console.log('  ─────────────────────────────\n');

    // ── 1. Create or find the demo organization ──────────────────────
    let org = await data.get(
        "SELECT id FROM institutions WHERE lower(name) = lower(?) AND verificationStatus = 'approved'",
        [DEMO_ORG.name]
    );
    if (!org) {
        const result = await data.run(
            "INSERT INTO institutions (name, type, contact, verificationStatus) VALUES (?, ?, ?, 'approved')",
            [DEMO_ORG.name, DEMO_ORG.type, DEMO_ORG.contact]
        );
        org = { id: result.lastID };
        console.log(`  ✔ Created organization: ${DEMO_ORG.name}  (id=${org.id})`);
    } else {
        console.log(`  ● Organization already exists: ${DEMO_ORG.name}  (id=${org.id})`);
    }

    // ── 2. Create each demo account ──────────────────────────────────
    for (const account of DEMO_ACCOUNTS) {
        const existing = await data.get(
            'SELECT id FROM users WHERE lower(username) = lower(?)',
            [account.username]
        );

        if (existing) {
            console.log(`  ● Account already exists: ${account.username}  (id=${existing.id})`);
            // Still ensure org assignment
            if (account.assignToOrg) {
                await data.run('UPDATE users SET organizationId = ? WHERE id = ?', [org.id, existing.id]);
                await data.run(
                    "INSERT INTO organization_memberships (userId, organizationId, role, createdAt) VALUES (?, ?, ?, ?) ON CONFLICT(userId, organizationId) DO UPDATE SET role = excluded.role",
                    [existing.id, org.id, account.orgRole, Date.now()]
                );
            }
            continue;
        }

        const passwordHash = await hashSecret(account.password);
        const insertResult = await data.run(
            'INSERT INTO users (username, password, name, role, organizationId) VALUES (?, ?, ?, ?, ?)',
            [
                account.username,
                passwordHash,
                account.name,
                account.role,
                account.assignToOrg ? org.id : null,
            ]
        );
        const userId = insertResult.lastID;

        // Assign org membership
        if (account.assignToOrg) {
            await data.run(
                "INSERT INTO organization_memberships (userId, organizationId, role, createdAt) VALUES (?, ?, ?, ?) ON CONFLICT(userId, organizationId) DO UPDATE SET role = excluded.role",
                [userId, org.id, account.orgRole, Date.now()]
            );
        }

        console.log(`  ✔ Created ${account.role.padEnd(7)} account: ${account.username}  (id=${userId})`);
    }

    // ── 3. Create a sample project under the org ─────────────────────
    const existingProject = await data.get(
        'SELECT id FROM projects WHERE lower(name) = lower(?) AND organizationId = ?',
        ['Chandrayaan-4 Mission Planning', org.id]
    );
    if (!existingProject) {
        await data.run(
            "INSERT INTO projects (name, progress, status, organizationId) VALUES (?, ?, ?, ?)",
            ['Chandrayaan-4 Mission Planning', 25, 'In Progress', org.id]
        );
        console.log('  ✔ Created sample project: Chandrayaan-4 Mission Planning');
    }

    await data.close();

    console.log('\n  ─────────────────────────────');
    console.log('  Demo credentials ready!\n');
    console.log('  ┌─────────────┬─────────────────────────┬──────────────┐');
    console.log('  │ Role        │ Email                   │ Password     │');
    console.log('  ├─────────────┼─────────────────────────┼──────────────┤');
    console.log('  │ Admin       │ admin@orion.demo        │ Admin@1234   │');
    console.log('  │ Manager     │ manager@orion.demo      │ Manager@1234 │');
    console.log('  │ Worker      │ worker@orion.demo       │ Worker@1234  │');
    console.log('  └─────────────┴─────────────────────────┴──────────────┘\n');
}

seed().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
});
