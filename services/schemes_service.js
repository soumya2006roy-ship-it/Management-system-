'use strict';

class SchemesService {
    constructor(data, services) {
        this.data = data;
        this.services = services;
    }

    calculateSchemeMatch(project, scheme, taskCount = 0, org = null) {
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

        // Unverifiable Criteria (shown transparently as "unknown")
        unknownCriteria.push({
            criterion: 'Statutory Financial & Turnover Audit',
            status: 'unknown',
            reason: 'Requires certified chartered accountant audit report and balance sheet verification.'
        });
        unknownCriteria.push({
            criterion: 'Domestic Value Addition (DVA) Certificate',
            status: 'unknown',
            reason: 'Requires procurement billing documentation proving minimum domestic value addition.'
        });

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

        const org = await this.data.get('SELECT * FROM institutions WHERE id = ?', [user.organizationId]);
        const taskCountRes = await this.data.get('SELECT COUNT(*) AS total FROM tasks WHERE projectId = ?', [projectId]);
        const taskCount = taskCountRes?.total || 0;

        const schemes = await this.data.all("SELECT * FROM government_schemes WHERE status = 'active' ORDER BY id ASC");
        const matches = await this.data.all('SELECT * FROM project_scheme_matches WHERE projectId = ?', [projectId]);
        const matchMap = new Map(matches.map(m => [m.schemeId, m]));

        return schemes.map(scheme => {
            const existing = matchMap.get(scheme.id);
            const evaluation = this.calculateSchemeMatch(project, scheme, taskCount, org);

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
            `Submitted application for government scheme "${scheme.title}" for project "${project.name}"`,
            user.organizationId
        );

        return {
            success: true,
            message: `Application submitted for ${scheme.title}`,
            matchScore: evaluation.matchScore,
            applicationStatus: 'applied',
            appliedAt: now
        };
    }
}

module.exports = { SchemesService };
