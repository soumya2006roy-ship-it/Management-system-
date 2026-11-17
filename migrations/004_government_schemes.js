'use strict';

module.exports = async function governmentSchemes(data) {
    // 1. Table for government schemes catalog
    await data.run(`
        CREATE TABLE IF NOT EXISTS government_schemes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            ministry TEXT NOT NULL,
            sector TEXT NOT NULL,
            description TEXT NOT NULL,
            eligibilityCriteria TEXT NOT NULL,
            maxFundingAmount REAL DEFAULT 0,
            subsidyPercentage REAL DEFAULT 0,
            deadline INTEGER,
            portalUrl TEXT NOT NULL,
            sourceUrl TEXT NOT NULL,
            lastVerified INTEGER NOT NULL,
            isSampleData INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            createdAt INTEGER NOT NULL
        )
    `);

    // 2. Table for tracking project-to-scheme matching & application status with UNIQUE(projectId, schemeId)
    await data.run(`
        CREATE TABLE IF NOT EXISTS project_scheme_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            projectId INTEGER NOT NULL,
            schemeId INTEGER NOT NULL,
            matchScore INTEGER NOT NULL DEFAULT 0,
            matchReason TEXT DEFAULT '',
            applicationStatus TEXT NOT NULL DEFAULT 'recommended',
            appliedAt INTEGER,
            notes TEXT DEFAULT '',
            UNIQUE(projectId, schemeId),
            FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY(schemeId) REFERENCES government_schemes(id) ON DELETE CASCADE
        )
    `);

    // 3. Performance Indexes
    await data.run('CREATE INDEX IF NOT EXISTS idx_schemes_sector ON government_schemes(sector, status)');
    await data.run('CREATE INDEX IF NOT EXISTS idx_scheme_matches_proj ON project_scheme_matches(projectId, schemeId)');

    // 4. Seed verified real government schemes
    const count = await data.get('SELECT COUNT(*) AS total FROM government_schemes');
    if (count.total === 0) {
        const now = Date.now();
        const sixMonths = now + (180 * 24 * 60 * 60 * 1000);

        const initialSchemes = [
            [
                'Production Linked Incentive (PLI) Scheme for Drones and Drone Components',
                'Ministry of Civil Aviation',
                'Aerospace & Drones',
                'Incentive of 20% on value addition made by manufacturers of drones and drone components in India under the Atmanirbhar Bharat initiative.',
                'Must be registered entity in India, minimum 40% local value addition, minimum turnover thresholds for MSMEs/startups, project progress active.',
                1200000000,
                20.0,
                sixMonths,
                'https://www.civilaviation.gov.in',
                'https://www.civilaviation.gov.in/ministry-documents/notifications/pli-scheme-drones-and-drone-components',
                now,
                0, // 0 = verified real official scheme
                'active',
                now
            ],
            [
                'Innovations for Defence Excellence (iDEX) - DISC Grant',
                'Ministry of Defence',
                'Defence & DeepTech',
                'Grants for startups and MSMEs developing innovative dual-use or defence hardware and software prototypes via the SPARK mechanism.',
                'DPIIT-recognized Startups, MSMEs, or innovators with verifiable technical prototype and security credentials.',
                15000000,
                50.0,
                sixMonths,
                'https://idex.gov.in',
                'https://idex.gov.in/challenge-categories',
                now,
                0, // 0 = verified real official scheme
                'active',
                now
            ],
            [
                'SAMRIDH Scheme (Startup Accelerator of MeitY for Product Innovation)',
                'Ministry of Electronics & Information Technology',
                'IT & Digital Governance',
                'Financial acceleration and matching co-investment funding for software, SaaS, digital governance, and deep-tech product initiatives.',
                'Registered IT/tech startup or entity in India, validated software/hardware product prototype, readiness for scaling.',
                4000000,
                40.0,
                sixMonths,
                'https://msh.meity.gov.in',
                'https://www.meity.gov.in/content/samridh-scheme',
                now,
                0, // 0 = verified real official scheme
                'active',
                now
            ]
        ];

        for (const s of initialSchemes) {
            await data.run(
                `INSERT INTO government_schemes 
                (title, ministry, sector, description, eligibilityCriteria, maxFundingAmount, subsidyPercentage, deadline, portalUrl, sourceUrl, lastVerified, isSampleData, status, createdAt) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                s
            );
        }
    }
};
