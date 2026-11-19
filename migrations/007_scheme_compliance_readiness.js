'use strict';

module.exports = async function schemeComplianceReadiness(data) {
    await data.run(`
        CREATE TABLE IF NOT EXISTS scheme_compliance_readiness (
            projectId INTEGER NOT NULL,
            schemeId INTEGER NOT NULL,
            criterionKey TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            updatedAt INTEGER NOT NULL,
            PRIMARY KEY(projectId, schemeId, criterionKey),
            FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY(schemeId) REFERENCES government_schemes(id) ON DELETE CASCADE
        )
    `);
    await data.run('CREATE INDEX IF NOT EXISTS idx_scheme_readiness_proj ON scheme_compliance_readiness(projectId, schemeId)');
};
