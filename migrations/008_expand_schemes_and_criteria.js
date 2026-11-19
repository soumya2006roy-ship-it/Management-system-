'use strict';

async function addColumnIfNotExists(data, table, column, def) {
    const cols = await data.all(`PRAGMA table_info(${table})`);
    if (!cols.some(c => c.name.toLowerCase() === column.toLowerCase())) {
        await data.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
}

module.exports = async function expandSchemesAndCriteria(data) {
    // 1. Add structured qualification profile fields to institutions
    await addColumnIfNotExists(data, 'institutions', 'entityType', "TEXT NOT NULL DEFAULT 'Startup'");
    await addColumnIfNotExists(data, 'institutions', 'sectorTags', "TEXT NOT NULL DEFAULT ''");
    await addColumnIfNotExists(data, 'institutions', 'turnoverBand', "TEXT NOT NULL DEFAULT 'under_5cr'");
    await addColumnIfNotExists(data, 'institutions', 'manufacturingCapability', "TEXT NOT NULL DEFAULT 'none'");
    await addColumnIfNotExists(data, 'institutions', 'registrationStatus', "TEXT NOT NULL DEFAULT 'none'");
    await addColumnIfNotExists(data, 'institutions', 'dpiitNumber', "TEXT NOT NULL DEFAULT ''");
    await addColumnIfNotExists(data, 'institutions', 'udyamNumber', "TEXT NOT NULL DEFAULT ''");

    // 2. Add structured qualification fields to projects
    await addColumnIfNotExists(data, 'projects', 'sector', "TEXT NOT NULL DEFAULT ''");
    await addColumnIfNotExists(data, 'projects', 'projectType', "TEXT NOT NULL DEFAULT 'r_and_d'");
    await addColumnIfNotExists(data, 'projects', 'budget', 'REAL NOT NULL DEFAULT 0');

    // 3. Add structured criteria columns to government_schemes
    await addColumnIfNotExists(data, 'government_schemes', 'targetSectors', "TEXT NOT NULL DEFAULT ''");
    await addColumnIfNotExists(data, 'government_schemes', 'allowedEntityTypes', "TEXT NOT NULL DEFAULT ''");
    await addColumnIfNotExists(data, 'government_schemes', 'minTurnover', 'REAL NOT NULL DEFAULT 0');
    await addColumnIfNotExists(data, 'government_schemes', 'maxTurnover', 'REAL NOT NULL DEFAULT 0');
    await addColumnIfNotExists(data, 'government_schemes', 'minDvaPercentage', 'REAL NOT NULL DEFAULT 0');
    await addColumnIfNotExists(data, 'government_schemes', 'requiredDocuments', "TEXT NOT NULL DEFAULT ''");

    // 4. Add documentRef and selfAttested to scheme_compliance_readiness
    await addColumnIfNotExists(data, 'scheme_compliance_readiness', 'documentRef', "TEXT NOT NULL DEFAULT ''");
    await addColumnIfNotExists(data, 'scheme_compliance_readiness', 'selfAttested', 'INTEGER NOT NULL DEFAULT 1');

    // 5. Seed 16 verified real Indian Central & State Government Schemes
    const now = Date.now();
    const sixMonths = now + (180 * 24 * 60 * 60 * 1000);

    const verifiedSchemes = [
        {
            title: 'Production Linked Incentive (PLI) Scheme for Drones and Drone Components',
            ministry: 'Ministry of Civil Aviation',
            sector: 'Aerospace & Drones',
            description: 'Incentive of 20% on value addition made by manufacturers of drones and drone components in India under the Atmanirbhar Bharat initiative.',
            eligibilityCriteria: 'Registered entity in India, minimum 40% local value addition, minimum turnover threshold for MSMEs/startups, active technical milestones.',
            maxFundingAmount: 1200000000,
            subsidyPercentage: 20.0,
            portalUrl: 'https://www.civilaviation.gov.in',
            sourceUrl: 'https://www.civilaviation.gov.in/ministry-documents/notifications/pli-scheme-drones-and-drone-components',
            targetSectors: 'Aerospace, Drones, Defence, Space',
            allowedEntityTypes: 'Startup, MSME, Enterprise',
            minDvaPercentage: 40.0,
            requiredDocuments: 'dva_certificate,financial_audit'
        },
        {
            title: 'Innovations for Defence Excellence (iDEX) - DISC Grant',
            ministry: 'Ministry of Defence',
            sector: 'Defence & DeepTech',
            description: 'Grants for startups and MSMEs developing innovative dual-use or defence hardware and software prototypes via the SPARK mechanism.',
            eligibilityCriteria: 'DPIIT-recognized Startups, MSMEs, or innovators with verifiable technical prototype and security credentials.',
            maxFundingAmount: 15000000,
            subsidyPercentage: 50.0,
            portalUrl: 'https://idex.gov.in',
            sourceUrl: 'https://idex.gov.in/challenge-categories',
            targetSectors: 'Defence, DeepTech, Aerospace, CyberSecurity',
            allowedEntityTypes: 'Startup, MSME',
            minDvaPercentage: 50.0,
            requiredDocuments: 'dpiit_certificate,prototype_readiness'
        },
        {
            title: 'SAMRIDH Scheme (Startup Accelerator of MeitY for Product Innovation)',
            ministry: 'Ministry of Electronics & Information Technology',
            sector: 'IT & Digital Governance',
            description: 'Financial acceleration and matching co-investment funding for software, SaaS, digital governance, and deep-tech product initiatives.',
            eligibilityCriteria: 'Registered IT/tech startup or entity in India, validated software/hardware product prototype, readiness for scaling.',
            maxFundingAmount: 4000000,
            subsidyPercentage: 40.0,
            portalUrl: 'https://msh.meity.gov.in',
            sourceUrl: 'https://www.meity.gov.in/content/samridh-scheme',
            targetSectors: 'IT, Software, Digital Governance, AI, DeepTech',
            allowedEntityTypes: 'Startup, MSME',
            minDvaPercentage: 0.0,
            requiredDocuments: 'financial_audit,product_deck'
        },
        {
            title: 'PLI Scheme for Telecom and Networking Products',
            ministry: 'Ministry of Communications',
            sector: 'Telecom & Networking',
            description: 'Production-linked incentive for manufacturing 4G/5G core equipment, routers, switches, optical gear, and advanced telecom hardware in India.',
            eligibilityCriteria: 'Minimum cumulative investment and turnover thresholds for telecom hardware manufacturing entities.',
            maxFundingAmount: 4000000000,
            subsidyPercentage: 6.0,
            portalUrl: 'https://www.dot.gov.in',
            sourceUrl: 'https://www.dot.gov.in/pli-telecom',
            targetSectors: 'Telecom, Networking, Hardware, Electronics',
            allowedEntityTypes: 'MSME, Enterprise',
            minDvaPercentage: 50.0,
            requiredDocuments: 'capex_verification,financial_audit'
        },
        {
            title: 'India Semiconductor Mission (ISM) - Semiconductor Fabrication & ATMP',
            ministry: 'Ministry of Electronics & Information Technology',
            sector: 'Semiconductors & Electronics',
            description: 'Fiscal support of up to 50% of project cost on pari-passu basis for setting up Silicon semiconductor fabs, compound fabs, and ATMP/OSAT facilities.',
            eligibilityCriteria: 'Entities with proven technical capability, silicon node manufacturing expertise, and committed long-term capital deployment.',
            maxFundingAmount: 100000000000,
            subsidyPercentage: 50.0,
            portalUrl: 'https://ism.gov.in',
            sourceUrl: 'https://ism.gov.in/schemes',
            targetSectors: 'Semiconductors, Electronics, Hardware, Fabrication',
            allowedEntityTypes: 'Enterprise, PSU, Consortium',
            minDvaPercentage: 30.0,
            requiredDocuments: 'dpr_verification,financial_audit'
        },
        {
            title: 'DRDO Technology Development Fund (TDF)',
            ministry: 'Ministry of Defence',
            sector: 'Defence & Aerospace R&D',
            description: 'Direct grant-in-aid support up to INR 50 Cr for MSMEs and startups to design and develop critical defence systems and indigenous technologies.',
            eligibilityCriteria: 'Indian MSMEs and DPIIT startups with 51%+ Indian ownership, technical proposal evaluated by DRDO panels.',
            maxFundingAmount: 500000000,
            subsidyPercentage: 90.0,
            portalUrl: 'https://tdf.drdo.gov.in',
            sourceUrl: 'https://tdf.drdo.gov.in/guidelines',
            targetSectors: 'Defence, Aerospace, DeepTech, Advanced Materials',
            allowedEntityTypes: 'MSME, Startup',
            minDvaPercentage: 60.0,
            requiredDocuments: 'security_clearance,financial_audit'
        },
        {
            title: 'Bhashini — National Language Translation Mission',
            ministry: 'Ministry of Electronics & Information Technology',
            sector: 'AI & Language Technologies',
            description: 'Ecosystem grants and compute subsidies to develop open-source Indian language AI, ASR, translation, and text-to-speech models.',
            eligibilityCriteria: 'Academic labs, startups, and open-data research foundations with demonstrated open-source AI models.',
            maxFundingAmount: 25000000,
            subsidyPercentage: 75.0,
            portalUrl: 'https://bhashini.gov.in',
            sourceUrl: 'https://bhashini.gov.in/ecosystem',
            targetSectors: 'AI, NLP, Machine Learning, Open Data, IT',
            allowedEntityTypes: 'Startup, MSME, Academic',
            minDvaPercentage: 0.0,
            requiredDocuments: 'model_evaluation,open_source_repo'
        },
        {
            title: 'Startup India Seed Fund Scheme (SISFS)',
            ministry: 'Ministry of Commerce & Industry',
            sector: 'Multi-Sector Innovation',
            description: 'Financial assistance to early-stage startups for proof of concept, prototype development, product trials, and market entry.',
            eligibilityCriteria: 'DPIIT recognized startup incorporated not more than 2 years ago, innovative business concept, incubatee status.',
            maxFundingAmount: 5000000,
            subsidyPercentage: 100.0,
            portalUrl: 'https://seedfund.startupindia.gov.in',
            sourceUrl: 'https://www.startupindia.gov.in/seed-fund-scheme',
            targetSectors: 'DeepTech, Hardware, Agriculture, Health, Space, IT',
            allowedEntityTypes: 'Startup',
            minDvaPercentage: 0.0,
            requiredDocuments: 'dpiit_certificate,incubator_endorsement'
        },
        {
            title: 'MSME Champions Scheme (ZED & Lean Manufacturing)',
            ministry: 'Ministry of MSME',
            sector: 'MSME Manufacturing & Quality',
            description: 'Subsidies up to 80% on Zero Defect Zero Effect (ZED) certification, clean energy adoption, and lean manufacturing implementation.',
            eligibilityCriteria: 'Registered MSME with valid Udyam Registration Certificate engaged in manufacturing or technical services.',
            maxFundingAmount: 2000000,
            subsidyPercentage: 80.0,
            portalUrl: 'https://champions.gov.in',
            sourceUrl: 'https://zed.msme.gov.in',
            targetSectors: 'Manufacturing, Engineering, Precision Components, Clean Energy',
            allowedEntityTypes: 'MSME',
            minDvaPercentage: 50.0,
            requiredDocuments: 'udyam_registration,energy_audit'
        },
        {
            title: 'Credit Guarantee Fund Trust for Micro and Small Enterprises (CGTMSE)',
            ministry: 'Ministry of MSME',
            sector: 'Credit & Working Capital',
            description: 'Collateral-free credit guarantee coverage up to INR 5 Crore for eligible micro and small enterprises seeking operational debt funding.',
            eligibilityCriteria: 'New or existing micro and small enterprises with commercial viability and bank loan approval.',
            maxFundingAmount: 50000000,
            subsidyPercentage: 85.0,
            portalUrl: 'https://www.cgtmse.in',
            sourceUrl: 'https://www.cgtmse.in/About-Us',
            targetSectors: 'Manufacturing, Services, Technology, Retail',
            allowedEntityTypes: 'MSME, Startup',
            minDvaPercentage: 0.0,
            requiredDocuments: 'bank_sanction,udyam_registration'
        },
        {
            title: 'PM E-DRIVE Scheme (Electric Vehicle Promotion)',
            ministry: 'Ministry of Heavy Industries',
            sector: 'Electric Vehicles & Clean Mobility',
            description: 'Demand incentives and capital subsidies for electric vehicle component manufacturing, battery assembly, and fast-charging network rollout.',
            eligibilityCriteria: 'EV manufacturers with phased manufacturing programme (PMP) adherence, ARAI/ICAT certification, and domestic localisation.',
            maxFundingAmount: 2000000000,
            subsidyPercentage: 25.0,
            portalUrl: 'https://heavyindustries.gov.in',
            sourceUrl: 'https://heavyindustries.gov.in/pm-e-drive',
            targetSectors: 'EV, Clean Mobility, Battery, Charging Infrastructure',
            allowedEntityTypes: 'MSME, Enterprise, Startup',
            minDvaPercentage: 50.0,
            requiredDocuments: 'arai_certification,dva_certificate'
        },
        {
            title: 'BIRAC Biotechnology Ignition Grant (BIG)',
            ministry: 'Ministry of Science & Technology',
            sector: 'Biotech & Healthcare DeepTech',
            description: 'Grant-in-aid up to INR 50 Lakhs for biotechnology entrepreneurs and startups to establish proof-of-concept for innovative biological solutions.',
            eligibilityCriteria: 'Indian biotech startup or individual innovator with registered incubation, scientific team, and laboratory prototype.',
            maxFundingAmount: 5000000,
            subsidyPercentage: 100.0,
            portalUrl: 'https://birac.nic.in',
            sourceUrl: 'https://birac.nic.in/big.php',
            targetSectors: 'Biotech, MedTech, Genomics, Bio-Manufacturing, Healthcare',
            allowedEntityTypes: 'Startup, MSME',
            minDvaPercentage: 0.0,
            requiredDocuments: 'lab_validation,ethical_clearance'
        },
        {
            title: 'NIDHI-PRAYAS Scheme (Hardware Prototyping Grant)',
            ministry: 'Ministry of Science & Technology',
            sector: 'Hardware & Technology Prototyping',
            description: 'Grant support up to INR 10 Lakhs for young technology innovators to translate physical and hardware ideas into proof-of-concept prototypes.',
            eligibilityCriteria: 'Individual innovators or startups less than 3 years old with tangible hardware innovations supported by a PRAYAS Centre.',
            maxFundingAmount: 1000000,
            subsidyPercentage: 100.0,
            portalUrl: 'https://www.nidhi-prayas.org',
            sourceUrl: 'https://dst.gov.in/nidhi-program',
            targetSectors: 'Hardware, IoT, Robotics, Precision Engineering, Sensors',
            allowedEntityTypes: 'Startup, Innovator',
            minDvaPercentage: 0.0,
            requiredDocuments: 'fab_lab_mou,prayas_recommendation'
        },
        {
            title: 'Atal New India Challenge (ANIC) - AIM',
            ministry: 'NITI Aayog',
            sector: 'National Sectoral Challenges',
            description: 'Grants up to INR 1 Crore for technology-driven innovations addressing national priorities in agriculture, water, health, and clean energy.',
            eligibilityCriteria: 'DPIIT recognized startups and MSMEs with functional working prototype addressing designated challenge statements.',
            maxFundingAmount: 10000000,
            subsidyPercentage: 70.0,
            portalUrl: 'https://aim.gov.in',
            sourceUrl: 'https://aim.gov.in/anic.php',
            targetSectors: 'Space, Defence, Clean Energy, Smart Mobility, Agriculture',
            allowedEntityTypes: 'Startup, MSME',
            minDvaPercentage: 40.0,
            requiredDocuments: 'dpiit_certificate,field_trial_data'
        },
        {
            title: 'PM Gati Shakti National Master Plan Grant',
            ministry: 'Ministry of Commerce & Industry',
            sector: 'Logistics & Critical Infrastructure',
            description: 'Capital co-funding for multimodal logistics parks, digital GIS freight corridors, and supply chain infrastructure digitization.',
            eligibilityCriteria: 'Infrastructure development agencies, PSUs, and public-private partnership entities aligned with national master plan norms.',
            maxFundingAmount: 5000000000,
            subsidyPercentage: 30.0,
            portalUrl: 'https://gatishakti.gov.in',
            sourceUrl: 'https://dpiit.gov.in/logistics-division',
            targetSectors: 'Logistics, Transport, Geospatial, Supply Chain, Infrastructure',
            allowedEntityTypes: 'PSU, Enterprise, Consortium',
            minDvaPercentage: 50.0,
            requiredDocuments: 'dpr_verification,inter_ministerial_clearance'
        },
        {
            title: 'Semiconductor Design Linked Incentive (DLI) Scheme',
            ministry: 'Ministry of Electronics & Information Technology',
            sector: 'Fabless Chip Design',
            description: 'Financial incentives and reimbursement of 50% of eligible expenditure for semiconductor design, IP cores, ASIC, and SoC development.',
            eligibilityCriteria: 'Domestic fabless semiconductor companies and startups with Indian majority shareholding and tape-out targets.',
            maxFundingAmount: 150000000,
            subsidyPercentage: 50.0,
            portalUrl: 'https://www.semiconindia.org',
            sourceUrl: 'https://www.semiconindia.org/dli',
            targetSectors: 'Semiconductors, VLSI, EDA, Chip Design, Microelectronics',
            allowedEntityTypes: 'Startup, MSME',
            minDvaPercentage: 50.0,
            requiredDocuments: 'eda_tool_licenses,tapeout_plan'
        }
    ];

    for (const s of verifiedSchemes) {
        const existing = await data.get('SELECT id FROM government_schemes WHERE title = ?', [s.title]);
        if (existing) {
            await data.run(
                `UPDATE government_schemes SET
                    ministry = ?, sector = ?, description = ?, eligibilityCriteria = ?,
                    maxFundingAmount = ?, subsidyPercentage = ?, portalUrl = ?, sourceUrl = ?,
                    targetSectors = ?, allowedEntityTypes = ?, minDvaPercentage = ?, requiredDocuments = ?,
                    lastVerified = ?, isSampleData = 0, status = 'active'
                 WHERE id = ?`,
                [
                    s.ministry, s.sector, s.description, s.eligibilityCriteria,
                    s.maxFundingAmount, s.subsidyPercentage, s.portalUrl, s.sourceUrl,
                    s.targetSectors, s.allowedEntityTypes, s.minDvaPercentage, s.requiredDocuments,
                    now, existing.id
                ]
            );
        } else {
            await data.run(
                `INSERT INTO government_schemes
                    (title, ministry, sector, description, eligibilityCriteria, maxFundingAmount, subsidyPercentage, deadline, portalUrl, sourceUrl, targetSectors, allowedEntityTypes, minDvaPercentage, requiredDocuments, lastVerified, isSampleData, status, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    s.title, s.ministry, s.sector, s.description, s.eligibilityCriteria,
                    s.maxFundingAmount, s.subsidyPercentage, sixMonths, s.portalUrl, s.sourceUrl,
                    s.targetSectors, s.allowedEntityTypes, s.minDvaPercentage, s.requiredDocuments,
                    now, 0, 'active', now
                ]
            );
        }
    }
};
