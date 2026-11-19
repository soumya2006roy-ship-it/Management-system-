'use strict';

const CRITERIA_DEFINITIONS = {
    financial_audit: {
        criterion: 'Statutory Financial & Turnover Audit',
        reason: 'Requires certified chartered accountant audit report and balance sheet verification.'
    },
    dva_certificate: {
        criterion: 'Domestic Value Addition (DVA) Certificate',
        reason: 'Requires procurement billing documentation proving minimum domestic value addition.'
    },
    dpiit_certificate: {
        criterion: 'DPIIT Startup Recognition Certificate',
        reason: 'Requires valid DPIIT Certificate of Recognition.'
    },
    prototype_readiness: {
        criterion: 'Technical Prototype & Readiness Dossier',
        reason: 'Requires functional prototype verification or lab test report.'
    },
    product_deck: {
        criterion: 'Product Architecture & Scale Dossier',
        reason: 'Requires technical architecture documentation and commercialization roadmap.'
    },
    capex_verification: {
        criterion: 'Capital Expenditure (CapEx) Verification',
        reason: 'Requires certified proof of committed plant, machinery, and equipment investments.'
    },
    dpr_verification: {
        criterion: 'Detailed Project Report (DPR) & Feasibility',
        reason: 'Requires DPR evaluated by technical review committee.'
    },
    security_clearance: {
        criterion: 'Industrial Security & Defence Clearance',
        reason: 'Requires verified defence security clearances and ownership audit.'
    },
    model_evaluation: {
        criterion: 'AI Benchmark & Model Evaluation',
        reason: 'Requires benchmark report on standardized Indian language datasets.'
    },
    open_source_repo: {
        criterion: 'Open Source Code Repository & Documentation',
        reason: 'Requires public or ministry-accessible codebase with permissible license.'
    },
    incubator_endorsement: {
        criterion: 'Incubator / PRAYAS Centre Recommendation',
        reason: 'Requires formal recommendation letter from recognized incubator.'
    },
    udyam_registration: {
        criterion: 'Udyam MSME Registration Certificate',
        reason: 'Requires active Udyam registration with verifiable MSME NIC code.'
    },
    energy_audit: {
        criterion: 'ZED Assessment / Clean Energy Audit',
        reason: 'Requires accredited third-party energy/quality audit documentation.'
    },
    bank_sanction: {
        criterion: 'Bank Term Loan / Working Capital Sanction',
        reason: 'Requires in-principle or final credit sanction letter from scheduled commercial bank.'
    },
    arai_certification: {
        criterion: 'ARAI / ICAT Type Approval Certificate',
        reason: 'Requires vehicular or battery testing certificate under CMVR regulations.'
    },
    lab_validation: {
        criterion: 'GLP / NABL Accredited Laboratory Validation',
        reason: 'Requires experimental validation in certified life sciences laboratory.'
    },
    ethical_clearance: {
        criterion: 'Institutional Ethics Committee Clearance',
        reason: 'Requires ethical approvals for clinical or human trial data.'
    },
    fab_lab_mou: {
        criterion: 'Fab Lab / Prototyping Facility Access MoU',
        reason: 'Requires agreement for hardware testing and fabrication equipment.'
    },
    prayas_recommendation: {
        criterion: 'PRAYAS Monitoring Committee Recommendation',
        reason: 'Requires endorsement from host institution project monitoring committee.'
    },
    field_trial_data: {
        criterion: 'Field Pilot & Deployment Verification',
        reason: 'Requires operational field trial metrics and user validation data.'
    },
    inter_ministerial_clearance: {
        criterion: 'Inter-Ministerial / Environmental Clearance',
        reason: 'Requires statutory right-of-way and environmental clearances.'
    },
    eda_tool_licenses: {
        criterion: 'EDA Tool Licenses & Design Environment Audit',
        reason: 'Requires licensed semiconductor design automation environment verification.'
    },
    tapeout_plan: {
        criterion: 'Foundry Tape-Out & Shuttle Run Schedule',
        reason: 'Requires verified schedule for silicon fabrication or packaging.'
    }
};

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
                documentRef TEXT NOT NULL DEFAULT '',
                selfAttested INTEGER NOT NULL DEFAULT 1,
                updatedAt INTEGER NOT NULL,
                PRIMARY KEY(projectId, schemeId, criterionKey),
                FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY(schemeId) REFERENCES government_schemes(id) ON DELETE CASCADE
            )
        `);
        const cols = await this.data.all('PRAGMA table_info(scheme_compliance_readiness)');
        if (!cols.some(c => c.name.toLowerCase() === 'documentref')) {
            await this.data.run("ALTER TABLE scheme_compliance_readiness ADD COLUMN documentRef TEXT NOT NULL DEFAULT ''");
        }
        if (!cols.some(c => c.name.toLowerCase() === 'selfattested')) {
            await this.data.run("ALTER TABLE scheme_compliance_readiness ADD COLUMN selfAttested INTEGER NOT NULL DEFAULT 1");
        }
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
        const orgText = `${org?.name || ''} ${org?.type || ''} ${org?.sectorTags || ''}`.toLowerCase();
        const schemeSector = (scheme.sector || '').toLowerCase();
        const targetSectors = (scheme.targetSectors || '').toLowerCase();

        // Disqualify casual or recreational project context from authentic engineering subsidies
        const casualRegex = /\b(picnic|party|vacation|celebration|wedding|retreat|social|outing|personal|holiday|anniversary|birthday|recreation|casual)\b/i;
        const isCasual = casualRegex.test(projectText);

        let sectorMatched = false;
        let failReason = null;

        if (isCasual) {
            sectorMatched = false;
            failReason = `Project title/description indicates casual or recreational context ('${project.name}'), failing authentic industrial/aerospace manufacturing eligibility.`;
        } else {
            if (schemeSector.includes('aerospace') || schemeSector.includes('drone') || targetSectors.includes('aerospace') || targetSectors.includes('drone')) {
                const droneTechWords = /\b(uav|uas|drone|propulsion|avionics|aerospace|airframe|flight\s*controller|payload|gimbal|telemetry|unmanned|aeronautic|aviation|satellite|spacecraft|aerostructure|defence|defense)\b/i;
                sectorMatched = droneTechWords.test(projectText) || droneTechWords.test(orgText) || orgText.includes('space') || orgText.includes('aero');
            } else if (schemeSector.includes('defence') || schemeSector.includes('deeptech') || targetSectors.includes('defence') || targetSectors.includes('deeptech')) {
                const defTechWords = /\b(defence|defense|deeptech|deep-tech|military|tactical|radar|ballistic|armour|armor|shield|security|cyber|autonomous|sensor|guidance|stealth)\b/i;
                sectorMatched = defTechWords.test(projectText) || defTechWords.test(orgText);
            } else if (schemeSector.includes('semiconductor') || schemeSector.includes('chip') || targetSectors.includes('semiconductor') || targetSectors.includes('vlsi')) {
                const semiWords = /\b(semiconductor|chip|wafer|fab|atmp|osat|asic|soc|vlsi|fpga|eda|microelectronics|tapeout|silicon)\b/i;
                sectorMatched = semiWords.test(projectText) || semiWords.test(orgText);
            } else if (schemeSector.includes('telecom') || schemeSector.includes('networking') || targetSectors.includes('telecom') || targetSectors.includes('networking')) {
                const telWords = /\b(telecom|telecommunication|network|5g|4g|ran|core|router|switch|optical|fiber|base\s*station|broadband|wireless)\b/i;
                sectorMatched = telWords.test(projectText) || telWords.test(orgText);
            } else if (schemeSector.includes('electric vehicle') || schemeSector.includes('clean mobility') || schemeSector.includes('ev') || targetSectors.includes('ev')) {
                const evWords = /\b(ev|electric\s*vehicle|battery|cell|pack|bms|powertrain|charging|inverter|traction|motor|clean\s*mobility)\b/i;
                sectorMatched = evWords.test(projectText) || evWords.test(orgText);
            } else if (schemeSector.includes('biotech') || schemeSector.includes('health') || targetSectors.includes('biotech') || targetSectors.includes('medtech')) {
                const bioWords = /\b(biotech|biological|genomic|medtech|pharmaceutical|molecular|diagnostics|assay|therapeutic|clinical|healthcare|biomedical)\b/i;
                sectorMatched = bioWords.test(projectText) || bioWords.test(orgText);
            } else if (schemeSector.includes('ai') || schemeSector.includes('language') || targetSectors.includes('ai') || targetSectors.includes('nlp')) {
                const aiWords = /\b(ai|artificial\s*intelligence|machine\s*learning|nlp|speech|translation|corpus|asr|tts|llm|dataset|deep\s*learning|neural)\b/i;
                sectorMatched = aiWords.test(projectText) || aiWords.test(orgText);
            } else if (schemeSector.includes('it') || schemeSector.includes('digital') || schemeSector.includes('governance') || targetSectors.includes('it')) {
                const itWords = /\b(data|digital|software|portal|govern|cloud|saas|api|platform|database|system|cyber|security|analytics|infra)\b/i;
                sectorMatched = itWords.test(projectText) || itWords.test(orgText);
            } else if (schemeSector.includes('msme') || schemeSector.includes('manufacturing') || schemeSector.includes('quality') || targetSectors.includes('manufacturing')) {
                const mfgWords = /\b(manufactur|production|fabricat|assembly|precision|machining|tooling|zed|lean|quality|industrial|engineering)\b/i;
                sectorMatched = mfgWords.test(projectText) || mfgWords.test(orgText);
            } else if (schemeSector.includes('credit') || schemeSector.includes('capital')) {
                sectorMatched = true;
            } else if (schemeSector.includes('multi-sector') || schemeSector.includes('innovation') || schemeSector.includes('challenges') || schemeSector.includes('prototyping')) {
                const innovWords = /\b(prototype|hardware|iot|sensor|robotics|device|tech|innovation|pilot|poc|r&d|research)\b/i;
                sectorMatched = innovWords.test(projectText) || innovWords.test(orgText);
            } else if (schemeSector.includes('logistics') || schemeSector.includes('infrastructure')) {
                const logWords = /\b(logistic|freight|corridor|transport|cargo|warehouse|multimodal|gis|supply\s*chain|infrastructure)\b/i;
                sectorMatched = logWords.test(projectText) || logWords.test(orgText);
            } else {
                const combined = `${schemeSector} ${targetSectors}`;
                const tokens = combined.split(/[\s,&/]+/).filter(w => w.length > 3);
                sectorMatched = tokens.some(t => projectText.includes(t) || orgText.includes(t));
            }
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
                reason: failReason || `Project domain does not strongly align with scheme sector '${scheme.sector}'.`
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
        const reqKeys = scheme.requiredDocuments
            ? scheme.requiredDocuments.split(',').map(s => s.trim()).filter(Boolean)
            : ['financial_audit', 'dva_certificate'];

        for (const key of reqKeys) {
            const meta = CRITERIA_DEFINITIONS[key] || {
                criterion: key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                reason: `Requires formal verification dossier for ${key.replace(/_/g, ' ')}.`
            };

            let criterionStatus = 'unknown';
            let documentRef = '';
            let selfAttested = 0;

            if (readinessMap) {
                let entry = null;
                if (typeof readinessMap.get === 'function' && readinessMap.has(key)) {
                    entry = readinessMap.get(key);
                } else if (readinessMap[key]) {
                    entry = readinessMap[key];
                }

                if (typeof entry === 'string') {
                    criterionStatus = entry;
                } else if (entry && typeof entry === 'object') {
                    criterionStatus = entry.status || 'unknown';
                    documentRef = entry.documentRef || '';
                    selfAttested = entry.selfAttested !== undefined ? entry.selfAttested : 1;
                }
            }

            unknownCriteria.push({
                criterionKey: key,
                criterion: meta.criterion,
                status: criterionStatus,
                documentRef,
                selfAttested,
                reason: meta.reason
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

        const readinessRows = await this.data.all('SELECT schemeId, criterionKey, status, documentRef, selfAttested FROM scheme_compliance_readiness WHERE projectId = ?', [projectId]);
        const readinessByScheme = new Map();
        for (const row of readinessRows) {
            if (!readinessByScheme.has(row.schemeId)) {
                readinessByScheme.set(row.schemeId, new Map());
            }
            readinessByScheme.get(row.schemeId).set(row.criterionKey, {
                status: row.status,
                documentRef: row.documentRef || '',
                selfAttested: row.selfAttested !== undefined ? row.selfAttested : 1
            });
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

    async updateSchemeReadiness(userId, projectId, schemeId, criterionKey, status, documentRef = '') {
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

        const validStatuses = ['pending', 'in_progress', 'verified', 'self_verified', 'missing'];
        if (!status || !validStatuses.includes(status)) {
            throw new this.services.ApiError(400, 'Invalid readiness status. Must be pending, in_progress, verified, self_verified, or missing');
        }

        await this.ensureReadinessTable();
        const now = Date.now();
        const cleanDocRef = String(documentRef || '').trim();

        await this.data.run(
            `INSERT INTO scheme_compliance_readiness (projectId, schemeId, criterionKey, status, documentRef, selfAttested, updatedAt)
             VALUES (?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(projectId, schemeId, criterionKey) DO UPDATE SET
                 status = excluded.status,
                 documentRef = excluded.documentRef,
                 selfAttested = 1,
                 updatedAt = excluded.updatedAt`,
            [projectId, schemeId, criterionKey, status, cleanDocRef, now]
        );

        return {
            success: true,
            projectId,
            schemeId,
            criterionKey,
            status,
            documentRef: cleanDocRef,
            selfAttested: 1,
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
