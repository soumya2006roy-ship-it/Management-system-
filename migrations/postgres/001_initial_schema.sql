-- ============================================================================
-- ORION Enterprise PostgreSQL Initial Schema Migration (001_initial_schema.sql)
-- Architecture Blueprint: Multi-Pod Scale & Zero-Data-Loss Migration (ARCH-01)
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. INSTITUTIONS / ORGANIZATIONS
CREATE TABLE institutions (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    contact TEXT,
    verificationStatus TEXT NOT NULL DEFAULT 'unverified' CHECK (verificationStatus IN ('unverified', 'pending', 'approved', 'rejected')),
    entityType TEXT NOT NULL DEFAULT 'Startup',
    sectorTags TEXT NOT NULL DEFAULT '',
    turnoverBand TEXT NOT NULL DEFAULT 'under_5cr',
    manufacturingCapability TEXT NOT NULL DEFAULT 'none',
    registrationStatus TEXT NOT NULL DEFAULT 'none',
    dpiitNumber TEXT NOT NULL DEFAULT '',
    udyamNumber TEXT NOT NULL DEFAULT '',
    createdAt BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_institutions_verification ON institutions(verificationStatus);

-- 2. USERS
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('worker', 'manager', 'admin', 'exec')),
    organizationId BIGINT REFERENCES institutions(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending')),
    failedAttempts INTEGER NOT NULL DEFAULT 0,
    lockoutUntil BIGINT NOT NULL DEFAULT 0,
    resetTokenHash TEXT,
    resetTokenExpiresAt BIGINT,
    createdAt BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_users_org ON users(organizationId);
CREATE INDEX idx_users_role ON users(role);

-- 3. SESSIONS (In-database fallback; Redis cluster recommended for multi-pod)
CREATE TABLE sessions (
    tokenHash TEXT PRIMARY KEY,
    userId BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    createdAt BIGINT NOT NULL,
    expiresAt BIGINT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(userId);
CREATE INDEX idx_sessions_expires ON sessions(expiresAt);

-- 4. PROJECTS
CREATE TABLE projects (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    progress NUMERIC(5, 2) NOT NULL DEFAULT 0.00 CHECK (progress >= 0 AND progress <= 100),
    status TEXT NOT NULL DEFAULT 'In Planning' CHECK (status IN ('In Planning', 'In Progress', 'Completed', 'On Hold', 'Archived')),
    organizationId BIGINT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    sector TEXT NOT NULL DEFAULT '',
    projectType TEXT NOT NULL DEFAULT 'r_and_d',
    budget NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    createdAt BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_projects_org ON projects(organizationId);
CREATE INDEX idx_projects_status ON projects(status);

-- 5. TASKS
CREATE TABLE tasks (
    id BIGSERIAL PRIMARY KEY,
    projectId BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'In Progress' CHECK (status IN ('In Planning', 'In Progress', 'Completed', 'Blocked', 'Cancelled')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    deadline TEXT,
    assignedTo BIGINT REFERENCES users(id) ON DELETE SET NULL,
    createdBy BIGINT REFERENCES users(id) ON DELETE SET NULL,
    createdAt BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_tasks_project ON tasks(projectId);
CREATE INDEX idx_tasks_assignee ON tasks(assignedTo);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);

-- 6. SUBTASKS
CREATE TABLE subtasks (
    id BIGSERIAL PRIMARY KEY,
    parentTaskId BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    assignedTo BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    createdBy BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organizationId BIGINT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    dueDate TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 1),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'approved', 'rejected')),
    submissionText TEXT NOT NULL DEFAULT '',
    reviewComment TEXT NOT NULL DEFAULT '',
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL
);

CREATE INDEX idx_subtasks_parent ON subtasks(parentTaskId);
CREATE INDEX idx_subtasks_assignee ON subtasks(assignedTo);
CREATE INDEX idx_subtasks_status ON subtasks(status);

-- 7. SUBTASK EVENTS
CREATE TABLE subtask_events (
    id BIGSERIAL PRIMARY KEY,
    subtaskId BIGINT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
    eventType TEXT NOT NULL,
    actorId BIGINT REFERENCES users(id) ON DELETE SET NULL,
    notes TEXT NOT NULL DEFAULT '',
    createdAt BIGINT NOT NULL
);

CREATE INDEX idx_subtask_events_subtask ON subtask_events(subtaskId);

-- 8. TASK REPORTS (Progress submission audit)
CREATE TABLE task_reports (
    id BIGSERIAL PRIMARY KEY,
    taskId BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    submittedBy BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    proposedProgress INTEGER NOT NULL CHECK (proposedProgress >= 0 AND proposedProgress <= 100),
    reportText TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewedBy BIGINT REFERENCES users(id) ON DELETE SET NULL,
    reviewNotes TEXT NOT NULL DEFAULT '',
    createdAt BIGINT NOT NULL,
    reviewedAt BIGINT
);

CREATE INDEX idx_task_reports_task ON task_reports(taskId);
CREATE INDEX idx_task_reports_status ON task_reports(status);

-- 9. UPDATES / AUDIT LOG
CREATE TABLE updates (
    id BIGSERIAL PRIMARY KEY,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    organizationId BIGINT REFERENCES institutions(id) ON DELETE CASCADE
);

CREATE INDEX idx_updates_org ON updates(organizationId);
CREATE INDEX idx_updates_timestamp ON updates(timestamp DESC);

-- 10. ORGANIZATION INVITES
CREATE TABLE organization_invites (
    id BIGSERIAL PRIMARY KEY,
    organizationId BIGINT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    codeHash TEXT NOT NULL UNIQUE,
    createdBy BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    maxUses INTEGER NOT NULL DEFAULT 1 CHECK (maxUses >= 1),
    usedCount INTEGER NOT NULL DEFAULT 0,
    expiresAt BIGINT NOT NULL,
    createdAt BIGINT NOT NULL
);

CREATE INDEX idx_invites_org ON organization_invites(organizationId);

-- 11. ORGANIZATION APPLICATIONS
CREATE TABLE organization_applications (
    id BIGSERIAL PRIMARY KEY,
    applicantId BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    legalName TEXT NOT NULL,
    type TEXT NOT NULL,
    officialEmail TEXT NOT NULL,
    contactName TEXT NOT NULL,
    contactRole TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'more_information_required')),
    reviewerNotes TEXT NOT NULL DEFAULT '',
    reviewedBy BIGINT REFERENCES users(id) ON DELETE SET NULL,
    institutionId BIGINT REFERENCES institutions(id) ON DELETE SET NULL,
    createdAt BIGINT NOT NULL,
    reviewedAt BIGINT
);

CREATE INDEX idx_applications_applicant ON organization_applications(applicantId);
CREATE INDEX idx_applications_status ON organization_applications(status);

-- 12. GOVERNMENT SCHEMES CATALOG
CREATE TABLE government_schemes (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL UNIQUE,
    ministry TEXT NOT NULL,
    sector TEXT NOT NULL,
    description TEXT NOT NULL,
    eligibilityCriteria TEXT NOT NULL,
    maxFundingAmount NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    subsidyPercentage NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    deadline BIGINT,
    portalUrl TEXT NOT NULL,
    sourceUrl TEXT NOT NULL,
    targetSectors TEXT NOT NULL DEFAULT '',
    allowedEntityTypes TEXT NOT NULL DEFAULT '',
    minTurnover NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    maxTurnover NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    minDvaPercentage NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    requiredDocuments TEXT NOT NULL DEFAULT '',
    lastVerified BIGINT NOT NULL,
    isSampleData SMALLINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    createdAt BIGINT NOT NULL
);

CREATE INDEX idx_schemes_sector ON government_schemes(sector);
CREATE INDEX idx_schemes_status ON government_schemes(status);

-- 13. PROJECT SCHEME MATCHES
CREATE TABLE project_scheme_matches (
    projectId BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    schemeId BIGINT NOT NULL REFERENCES government_schemes(id) ON DELETE CASCADE,
    matchScore INTEGER NOT NULL CHECK (matchScore >= 0 AND matchScore <= 100),
    matchReason TEXT NOT NULL DEFAULT '',
    applicationStatus TEXT NOT NULL DEFAULT 'recommended' CHECK (applicationStatus IN ('recommended', 'applied', 'under_review', 'approved', 'rejected')),
    appliedAt BIGINT,
    PRIMARY KEY(projectId, schemeId)
);

CREATE INDEX idx_proj_schemes_proj ON project_scheme_matches(projectId);

-- 14. SCHEME COMPLIANCE READINESS
CREATE TABLE scheme_compliance_readiness (
    projectId BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    schemeId BIGINT NOT NULL REFERENCES government_schemes(id) ON DELETE CASCADE,
    criterionKey TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'self_verified', 'verified', 'missing')),
    documentRef TEXT NOT NULL DEFAULT '',
    selfAttested SMALLINT NOT NULL DEFAULT 1,
    updatedAt BIGINT NOT NULL,
    PRIMARY KEY(projectId, schemeId, criterionKey)
);

CREATE INDEX idx_readiness_proj_scheme ON scheme_compliance_readiness(projectId, schemeId);

-- 15. RATE LIMITS
CREATE TABLE rate_limits (
    key TEXT PRIMARY KEY,
    points INTEGER NOT NULL DEFAULT 0,
    resetTime BIGINT NOT NULL
);

-- 16. CSRF TOKENS
CREATE TABLE csrf_tokens (
    token TEXT PRIMARY KEY,
    createdAt BIGINT NOT NULL,
    expiresAt BIGINT NOT NULL
);

CREATE INDEX idx_csrf_expires ON csrf_tokens(expiresAt);
