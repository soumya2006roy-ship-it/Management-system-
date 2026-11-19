'use strict';

class SchemesService {
    constructor(data, services) {
        this.data = data;
        this.services = services;
    }

    async ensureReadinessTable() {
        await this.data.run(`
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
        await this.data.run('CREATE INDEX IF NOT EXISTS idx_scheme_readiness_proj ON scheme_compliance_readiness(projectId, schemeId)');
    }

    calculateSchemeMatch(project, scheme, taskCount = 0, org = null, readinessMap = null) {
        let score = 0;
        const rules = [];
        const unknownCriteria = [];

        // Rule 1: Project Progress Milestone (Weight: 35)
        const progress = Number(project.progress) || 0;
        if (progress >= 20) {
            score += 35;
            rules.push({
                rule: 'project_progress_threshold',
                name: 'Progress Milestone Threshold',
                weight: 35,
                matched: true,
                reason: `Project progress is at ${progress}%, satisfying the minimum 20% milestone progress threshold.`
            });
        } else {
            rules.push({
                rule: 'project_progress_threshold',
                name: 'Progress Milestone Threshold',
                weight: 35,
                matched: false,
                reason: `Project progress is at ${progress}%, which is below the minimum 20% threshold required for funding.`
            });
        }

        // Rule 2: Sector & Mission Synergy (Weight: 35)
        const projectText = `${project.name || ''} ${project.description || ''}`.toLowerCase();
        const orgText = `${org?.name || ''} ${org?.type || ''}`.toLowerCase();
        const schemeSector = (scheme.sector || '').toLowerCase();
        
        let sectorMatched = false;
        if (schemeSector.includes('aerospace') || schemeSector.includes('drone')) {
            sectorMatched = projectText.includes('drone') || projectText.includes('aero') || projectText.includes('space') ||
                            projectText.includes('payload') || projectText.includes('propulsion') ||
                            orgText.includes('space') || orgText.includes('aero') || orgText.includes('defence');
        } else if (schemeSector.includes('defence') || schemeSector.includes('deeptech')) {
            sectorMatched = projectText.includes('defen') || projectText.includes('deep') || projectText.includes('tech') ||
                            projectText.includes('shield') || projectText.includes('security') ||
                            orgText.includes('defence') || orgText.includes('research') || orgText.includes('security');
        } else if (schemeSector.includes('it') || schemeSector.includes('digital') || schemeSector.includes('governance')) {
            sectorMatched = projectText.includes('data') || projectText.includes('digital') || projectText.includes('software') ||
                            projectText.includes('portal') || projectText.includes('govern') || orgText.includes('government') || orgText.includes('it');
        }

        if (sectorMatched) {
            score += 35;
            rules.push({
                rule: 'sector_alignment',
                name: 'Sector & Organizational Synergy',
                weight: 35,
                matched: true,
                reason: `Project domain ('${project.name}') and organization ('${org?.name || 'Verified Org'}') demonstrate direct synergy with scheme sector '${scheme.sector}'.`
            });
        } else {
            rules.push({
                rule: 'sector_alignment',
                name: 'Sector & Organizational Synergy',
                weight: 35,
                matched: false,
                reason: `Project domain does not strongly align with scheme sector '${scheme.sector}'.`
            });
        }

        // Rule 3: Active Lifecycle Status (Weight: 15)
        const status = String(project.status || 'In Progress').toLowerCase();
        if (status !== 'completed' && status !== 'archived') {
            score += 15;
            rules.push({
                rule: 'active_lifecycle_status',
                name: 'Active Project Lifecycle',
                weight: 15,
                matched: true,
                reason: `Project is currently active ('${project.status || 'In Progress'}') and eligible for ongoing tranche disbursement.`
            });
        } else {
            rules.push({
                rule: 'active_lifecycle_status',
                name: 'Active Project Lifecycle',
                weight: 15,
                matched: false,
                reason: `Project is marked as '${project.status}', and cannot receive active development subsidies.`
            });
        }

        // Rule 4: Structured Milestone Governance (Weight: 15)
        if (taskCount > 0) {
            score += 15;
            rules.push({
                rule: 'structured_governance',
                name: 'Structured Milestone Breakdown',
                weight: 15,
                matched: true,
                reason: `Project has structured governance with ${taskCount} defined task/subtask milestone(s).`
            });
        } else {
            rules.push({
                rule: 'structured_governance',
                name: 'Structured Milestone Breakdown',
                weight: 15,
                matched: false,
                reason: 'Project lacks active tracked tasks or subtask milestones in ORION.'
            });
        }

        // Unverifiable Criteria (shown transparently as "unknown" or user-updated readiness states)
        const defaultCriteria = [
            {
                criterionKey: 'financial_audit',
                criterion: 'Statutory Financial & Turnover Audit',
                reason: 'Requires certified chartered accountant audit report and balance sheet verification.'
            },
            {
                criterionKey: 'dva_certificate',
                criterion: 'Domestic Value Addition (DVA) Certificate',
                reason: 'Requires procurement billing documentation proving minimum domestic value addition.'
            }
        ];

        for (const c of defaultCriteria) {
            let status = 'unknown';
            if (readinessMap) {
                if (typeof readinessMap.get === 'function' && readinessMap.has(c.criterionKey)) {
                    status = readinessMap.get(c.criterionKey);
                } else if (readinessMap[c.criterionKey]) {
                    status = readinessMap[c.criterionKey];
                }
            }
            unknownCriteria.push({
                criterionKey: c.criterionKey,
                criterion: c.criterion,
                status,
                reason: c.reason
            });
        }

        const matchReasons = rules
            .filter(r => r.matched)
            .map(r => `[+${r.weight}%] ${r.name}: ${r.reason}`)
            .join('; ');

        return {
            matchScore: Math.min(100, score),
            rules,
            unknownCriteria,
            matchReason: matchReasons || 'No criteria met'
        };
    }

    async getGovernmentSchemes({ sector, search } = {}) {
        let sql = "SELECT * FROM government_schemes WHERE status = 'active'";
        const params = [];
        if (sector) {
            sql += ' AND sector LIKE ?';
            params.push(`%${sector}%`);
        }
        if (search) {
            sql += ' AND (title LIKE ? OR description LIKE ? OR ministry LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        sql += ' ORDER BY id ASC';
        return await this.data.all(sql, params);
    }

    async getSchemesForProject(userId, projectId) {
        if (!userId) throw new this.services.ApiError(401, 'Unauthorized');
        const user = await this.services.getPublicUserById(userId);
        if (!user || !user.organizationId) {
            throw new this.services.ApiError(403, 'Access denied: User does not belong to a verified organization');
        }
        const project = await this.data.get('SELECT * FROM projects WHERE id = ?', [projectId]);
        if (!project) throw new this.services.ApiError(404, 'Project not found');
        if (!project.organizationId || project.organizationId !== user.organizationId) {
            throw new this.services.ApiError(403, 'Access denied: Project does not belong to your organization');
        }

        await this.ensureReadinessTable();

        const org = await this.data.get('SELECT * FROM institutions WHERE id = ?', [user.organizationId]);
        const taskCountRes = await this.data.get('SELECT COUNT(*) AS total FROM tasks WHERE projectId = ?', [projectId]);
        const taskCount = taskCountRes?.total || 0;

        const schemes = await this.data.all("SELECT * FROM government_schemes WHERE status = 'active' ORDER BY id ASC");
        const matches = await this.data.all('SELECT * FROM project_scheme_matches WHERE projectId = ?', [projectId]);
        const matchMap = new Map(matches.map(m => [m.schemeId, m]));

        const readinessRows = await this.data.all('SELECT schemeId, criterionKey, status FROM scheme_compliance_readiness WHERE projectId = ?', [projectId]);
        const readinessByScheme = new Map();
        for (const row of readinessRows) {
            if (!readinessByScheme.has(row.schemeId)) {
                readinessByScheme.set(row.schemeId, new Map());
            }
            readinessByScheme.get(row.schemeId).set(row.criterionKey, row.status);
        }

        return schemes.map(scheme => {
            const existing = matchMap.get(scheme.id);
            const schemeReadiness = readinessByScheme.get(scheme.id) || null;
            const evaluation = this.calculateSchemeMatch(project, scheme, taskCount, org, schemeReadiness);

            return {
                ...scheme,
                matchScore: existing ? existing.matchScore : evaluation.matchScore,
                rules: evaluation.rules,
                unknownCriteria: evaluation.unknownCriteria,
                matchReason: existing && existing.matchReason ? existing.matchReason : evaluation.matchReason,
                applicationStatus: existing ? existing.applicationStatus : 'recommended',
                appliedAt: existing ? existing.appliedAt : null
            };
        });
    }

    async applyForScheme(userId, projectId, schemeId) {
        if (!userId) throw new this.services.ApiError(401, 'Unauthorized');
        const user = await this.services.getPublicUserById(userId);
        if (user.role !== 'manager' && user.role !== 'exec') {
            throw new this.services.ApiError(403, 'Only organization managers or administrators can apply for government schemes');
        }
        if (!user.organizationId) {
            throw new this.services.ApiError(403, 'Access denied: User does not belong to an organization');
        }

        const project = await this.data.get('SELECT * FROM projects WHERE id = ?', [projectId]);
        if (!project || !project.organizationId || project.organizationId !== user.organizationId) {
            throw new this.services.ApiError(403, 'Access denied: Project does not belong to your organization');
        }

        const scheme = await this.data.get('SELECT * FROM government_schemes WHERE id = ?', [schemeId]);
        if (!scheme) throw new this.services.ApiError(404, 'Scheme not found');

        const org = await this.data.get('SELECT * FROM institutions WHERE id = ?', [user.organizationId]);
        const taskCountRes = await this.data.get('SELECT COUNT(*) AS total FROM tasks WHERE projectId = ?', [projectId]);
        const taskCount = taskCountRes?.total || 0;
        const evaluation = this.calculateSchemeMatch(project, scheme, taskCount, org);

        const now = Date.now();
        await this.data.run(
            `INSERT INTO project_scheme_matches (projectId, schemeId, matchScore, matchReason, applicationStatus, appliedAt)
             VALUES (?, ?, ?, ?, 'applied', ?)
             ON CONFLICT(projectId, schemeId) DO UPDATE SET
                 applicationStatus = 'applied',
                 appliedAt = excluded.appliedAt,
                 matchScore = excluded.matchScore,
                 matchReason = excluded.matchReason`,
            [projectId, schemeId, evaluation.matchScore, evaluation.matchReason, now]
        );

        this.data.addUpdate(
            user.name,
            `Initiated internal tracking for government scheme "${scheme.title}" (Project: "${project.name}")`,
            user.organizationId
        );

        return {
            success: true,
            message: `Internal tracking active for "${scheme.title}". Please file official application via portal: ${scheme.portalUrl || 'N/A'}`,
            matchScore: evaluation.matchScore,
            applicationStatus: 'applied',
            appliedAt: now,
            portalUrl: scheme.portalUrl
        };
    }

    async updateSchemeReadiness(userId, projectId, schemeId, criterionKey, status) {
        if (!userId) throw new this.services.ApiError(401, 'Unauthorized');
        const user = await this.services.getPublicUserById(userId);
        if (!user || !user.organizationId) {
            throw new this.services.ApiError(403, 'Access denied: User does not belong to a verified organization');
        }
        if (user.role !== 'manager' && user.role !== 'exec' && user.role !== 'admin') {
            throw new this.services.ApiError(403, 'Only managers, executives, or administrators can update compliance readiness');
        }

        const project = await this.data.get('SELECT * FROM projects WHERE id = ?', [projectId]);
        if (!project || !project.organizationId || project.organizationId !== user.organizationId) {
            throw new this.services.ApiError(403, 'Access denied: Project does not belong to your organization');
        }

        const scheme = await this.data.get('SELECT * FROM government_schemes WHERE id = ?', [schemeId]);
        if (!scheme) throw new this.services.ApiError(404, 'Scheme not found');

        if (!criterionKey || typeof criterionKey !== 'string') {
            throw new this.services.ApiError(400, 'criterionKey is required');
        }

        const validStatuses = ['pending', 'in_progress', 'verified'];
        if (!status || !validStatuses.includes(status)) {
            throw new this.services.ApiError(400, 'Invalid readiness status. Must be pending, in_progress, or verified');
        }

        await this.ensureReadinessTable();
        const now = Date.now();

        await this.data.run(
            `INSERT INTO scheme_compliance_readiness (projectId, schemeId, criterionKey, status, updatedAt)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(projectId, schemeId, criterionKey) DO UPDATE SET
                 status = excluded.status,
                 updatedAt = excluded.updatedAt`,
            [projectId, schemeId, criterionKey, status, now]
        );

        return {
            success: true,
            projectId,
            schemeId,
            criterionKey,
            status,
            updatedAt: now
        };
    }

    async ingestSchemesFromFeed(feedItems) {
        if (!Array.isArray(feedItems)) {
            throw new this.services.ApiError(400, 'Feed items must be an array of scheme objects');
        }

        const ingested = [];
        const now = Date.now();

        for (const item of feedItems) {
            if (!item.title || !item.ministry || !item.sector || !item.description || !item.eligibilityCriteria) {
                continue;
            }

            const title = String(item.title).trim();
            const ministry = String(item.ministry).trim();
            const sector = String(item.sector).trim();
            const description = String(item.description).trim();
            const eligibilityCriteria = String(item.eligibilityCriteria).trim();
            const maxFundingAmount = Number(item.maxFundingAmount) || 0;
            const subsidyPercentage = Number(item.subsidyPercentage) || 0;
            const deadline = item.deadline ? Number(item.deadline) : null;
            const portalUrl = String(item.portalUrl || '').trim();
            const sourceUrl = String(item.sourceUrl || portalUrl).trim();
            const isSampleData = item.isSampleData ? 1 : 0;
            const status = item.status === 'archived' ? 'archived' : 'active';

            const existing = await this.data.get('SELECT id FROM government_schemes WHERE title = ?', [title]);
            if (existing) {
                await this.data.run(
                    `UPDATE government_schemes SET
                        ministry = ?, sector = ?, description = ?, eligibilityCriteria = ?,
                        maxFundingAmount = ?, subsidyPercentage = ?, deadline = ?,
                        portalUrl = ?, sourceUrl = ?, isSampleData = ?, status = ?, lastVerified = ?
                     WHERE id = ?`,
                    [ministry, sector, description, eligibilityCriteria, maxFundingAmount, subsidyPercentage, deadline, portalUrl, sourceUrl, isSampleData, status, now, existing.id]
                );
                ingested.push({ id: existing.id, title, action: 'updated' });
            } else {
                const res = await this.data.run(
                    `INSERT INTO government_schemes
                        (title, ministry, sector, description, eligibilityCriteria, maxFundingAmount, subsidyPercentage, deadline, portalUrl, sourceUrl, isSampleData, status, createdAt, lastVerified)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [title, ministry, sector, description, eligibilityCriteria, maxFundingAmount, subsidyPercentage, deadline, portalUrl, sourceUrl, isSampleData, status, now, now]
                );
                ingested.push({ id: res.lastID, title, action: 'inserted' });
            }
        }

        return {
            success: true,
            count: ingested.length,
            ingested
        };
    }
}

module.exports = { SchemesService };
