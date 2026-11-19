# ORION Government Productivity Tool

ORION is a role-based project and task management dashboard designed for government organizations, departments, autonomous bodies, and public sector undertakings. It is built with an Express + SQLite backend and a responsive, vanilla JavaScript single-page frontend.

---

## Key Features

- **Role-Based Access Control**: Strict segregation between `worker`, `manager`, and platform administrators (`exec`).
- **Organization & Multi-Tenancy**: Fail-closed tenant isolation. Workers join verified organizations using expiring, single-use invitation codes (stored as SHA-256 hashes).
- **Task & Subtask Review Lifecycle**: Workers submit progress reports or weighted subtasks for manager verification. Direct progress tampering via `/api/tasks/update` is rejected with HTTP 410.
- **Government Schemes Engine**: Dynamic rule-based eligibility evaluation matching departmental projects against verified national schemes, with role-gated application workflows.
- **AI Assistant with Progressive SSE Streaming**: Secure conversational assistant supporting task queries, project health summaries, and safe two-phase mutation proposals (e.g., reassignment). Powered by Google Gemini (header-authenticated) with an automatic offline local rule-engine fallback.
- **High-Performance Scalability**: Cursor-based pagination on large task collections, indexed queries, streaming CSV exports, and server-side PDF reporting.
- **API Versioning & REST Compliance**: All modern client endpoints are mounted at `/api/v1` with a backward-compatible `/api` legacy alias. Resource creations strictly return HTTP 201 Created. Deprecated routes return HTTP 410 Gone.
- **Offline & Air-Gapped Ready**: Vendored Three.js static assets served locally via `/public/vendor/three.min.js`, backed by an air-gapped SVG vector fallback. Content Security Policy is hardened with `script-src: ['self']` (no external CDNs).
- **Hardened Security**: Salted scrypt-only password hashing, complete render-sink HTML escaping (XSS mitigation), strict CSP, production session secret validation, and rate limiting.

---

## Codebase Directory Structure

```text
orion/
├── migrations/                # Sequential SQL schema migrations
│   ├── 001_initial_schema.js
│   ├── 002_fix_deadlines.js
│   ├── 003_task_indexes.js
│   ├── 004_government_schemes.js
│   ├── 005_normalize_task_deadlines.js
│   ├── 006_deprecate_dead_user_columns.js
│   └── 007_scheme_compliance_readiness.js
├── public/                    # Offline static assets and vendor bundles
│   └── vendor/
│       ├── three.min.js
│       └── three.min.js.license.txt
├── services/                  # Decoupled domain services
│   ├── export_service.js      # Streaming CSV & PDF report generation
│   └── schemes_service.js     # Government schemes catalog, rule matcher & readiness
├── backend_data.js            # SQLite database driver, WAL configuration & transactional queue
├── backend_routes.js          # Express route declarations (API v1 & legacy aliases)
├── backend_services.js        # Core business logic, auth, tenant scoping & task workflows
├── config.js                  # Production configuration and environment variable validator
├── server.js                  # HTTP server initialization, CORS, CSP & graceful shutdown
├── index.html                 # Single-page application shell
├── main.js                    # SPA application controller, view rendering & event bindings
├── router.js                  # Client-side hash router with accessibility focus management
├── views.js                   # XSS-safe HTML templates & render sinks
├── data_store.js              # Client-side API abstraction and HTTP fetch wrapper
└── style.css                  # Design system styles and responsive layout
```

---

## Quickstart & Local Development

### Prerequisites
- Node.js 20.17+ or Node.js 22+ (LTS recommended)
- Windows PowerShell or POSIX shell

### Setup
```powershell
# 1. Install dependencies
npm install

# 2. Configure environment
Copy-Item .env.example .env

# 3. Launch the development server
npm start
```
The application will be accessible at `http://localhost:3000`.

---

## Environment Variables & Configuration

ORION loads `.env` automatically during local development. In production (`NODE_ENV=production`), variables must be supplied by the hosting container or system environment.

| Variable | Description | Default | Requirement |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Environment mode (`development`, `test`, `production`) | `development` | Optional |
| `PORT` | HTTP server listening port | `3000` | Optional |
| `TRUST_PROXY` | Reverse proxy trust configuration (`loopback`, `linklocal`, hop count 0-5, or CIDR) | `false` | Required behind reverse proxy / ALB |
| `ORION_DB_PATH` | Path to SQLite database file | `./orion.db` | Optional |
| `SESSION_SECRET` | Secret key used for signing session cookies | Generated per-install | **Required in production** (≥ 32 chars) |
| `ENABLE_DEMO_ACCOUNTS` | Enables demo seed accounts and quick-login cards | `true` in dev, `false` in prod | Optional |
| `GEMINI_API_KEY` | Google Gemini API Key for AI Assistant | `None` (uses local fallback) | Optional |
| `GEMINI_MODEL` | Gemini model identifier | `gemini-2.0-flash` | Optional |
| `CORS_ORIGINS` | Comma-separated HTTPS origins allowed for CORS | `""` (Same-origin only) | Required if frontend is separate |
| `APP_BASE_URL` | Base public URL for password reset links | `http://localhost:3000` | Required in production |
| `SMTP_*` | SMTP configuration for email delivery | Null mailer in dev | Required in production |

---

## Demo Accounts & Judge Evaluation Path

To facilitate testing and auditing without manual registration:
1. Ensure `ENABLE_DEMO_ACCOUNTS=true` in your `.env` (default in development).
2. Start the server and navigate to `http://localhost:3000/#/login`.
3. Quick-login cards will appear below the login form:
   - **Executive / Platform Admin**: `admin@orion.gov.in`
   - **Department Manager**: `manager@isro.gov.in`
   - **Technical Worker**: `worker@isro.gov.in`
4. In production environments where `ENABLE_DEMO_ACCOUNTS=false`, demo cards are hidden and demo seeding is bypassed. To bootstrap the initial platform administrator in production:
   ```powershell
   npm run bootstrap-admin
   ```

---

## Government Schemes Engine

The Government Schemes engine evaluates departmental projects against active government programs.

### Data Provenance & Verification
Every scheme in the production catalog is backed by verified government documentation:
1. **Production Linked Incentive (PLI) Scheme for Drones & Drone Components**
   - *Ministry*: Ministry of Civil Aviation (MoCA)
   - *Official Portal*: `https://www.civilaviation.gov.in/ministry-documents/notifications/pli-scheme-drones-and-drone-components`
   - *Last Verified*: 2026-11-18
2. **iDEX Defence India Startup Challenge (DISC)**
   - *Ministry*: Ministry of Defence (MoD)
   - *Official Portal*: `https://idex.gov.in/challenge-categories`
   - *Last Verified*: 2026-11-18
3. **MeitY SAMRIDH Scheme**
   - *Ministry*: Ministry of Electronics and Information Technology (MeitY)
   - *Official Portal*: `https://www.meity.gov.in/content/samridh-scheme`
   - *Last Verified*: 2026-11-18

> **Note on Sample Data**: Any custom, unverified test schemes injected during automated simulations or local mocks are explicitly marked as `[Sample Data / Unverified]` in the code and user interface.

### Rule-Based Matcher Architecture
The matching engine evaluates projects transparently using a deterministic scoring model starting at 0:
- **Criteria Evaluation**: Rules inspect sector alignment, technological keywords, and task deliverables.
- **Confidence Scoring**: Each satisfied rule contributes a fixed weight with a human-readable justification.
- **Transparent Unknowns**: Missing project metadata (e.g. undisclosed company age) is recorded explicitly as `unknownCriteria` rather than silently assumed or hallucinated.
- **Fail-Closed Authorization**: Project scheme queries and applications require verified organization membership; cross-tenant evaluations and applications without valid organization scoping fail closed with HTTP 403.
- **Idempotent Applications**: Applying for a scheme is idempotent (`UNIQUE(projectId, schemeId)`) and restricted to `manager` and `exec` roles.

---

## AI Assistant & Streaming Architecture

The ORION Assistant provides interactive productivity intelligence:
- **Server-Sent Events (SSE)**: Streams progressive text chunks to the browser over `/api/assistant?stream=1`.
- **Header-Based Authentication**: Communicates with Google Generative Language APIs using the `x-goog-api-key` HTTP header. API keys are never embedded in URL query parameters or exposed to client-side bundles.
- **Engine Mode Badging**: Every response visually indicates its origin with an explicit badge in the UI:
  - `[Gemini AI]` when powered by the live Gemini LLM.
  - `[Local Rule Engine]` when operating in offline/fallback mode.
- **Destructive Mutation Guard**: Destructive actions (such as reassigning tasks) produce an explicit confirmation proposal card. Execution only proceeds after explicit secondary confirmation by an authorized manager.
- **Client Cancellation**: Long-running streams listen to request disconnect events (`AbortController`) to immediately abort pending upstream requests and conserve resources.

---

## API v1 Reference

All primary endpoints are mounted under `/api/v1` with a backward-compatible `/api` alias. Requests modifying state require a valid session token (via cookie or `Authorization: Bearer <token>`) and CSRF validation headers.

| Method | Endpoint | Access Role | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/auth/register` | Public | Register new user account (returns HTTP 201). |
| `POST` | `/api/v1/auth/login` | Public | Authenticate user credentials and establish session. |
| `POST` | `/api/v1/auth/logout` | Authenticated | Terminate session and invalidate session hash. |
| `GET` | `/api/v1/auth/session` | Authenticated | Retrieve currently authenticated user context. |
| `POST` | `/api/v1/auth/forgot-password` | Public | Request password reset token via configured mailer. |
| `POST` | `/api/v1/auth/reset-password` | Public | Reset account password using verified token. |
| `GET` | `/api/v1/dashboard` | Authenticated | Organization dashboard metrics, projects, and tasks. |
| `GET` | `/api/v1/projects` | Authenticated | Offset-paginated projects within user's organization. |
| `POST` | `/api/v1/projects` | Manager / Exec | Create project scoped to user's organization (HTTP 201). |
| `GET` | `/api/v1/projects/:id` | Authenticated | Retrieve project details and verified milestone progress. |
| `GET` | `/api/v1/projects/:id/tasks` | Authenticated | Keyset cursor-paginated tasks (`id_desc`, `deadline_asc`). |
| `POST` | `/api/v1/tasks` | Manager / Exec | Create new task within an organization project (HTTP 201). |
| `GET` | `/api/v1/tasks/:id` | Authenticated | Retrieve task metadata, subtasks, and progress reports. |
| `PATCH` | `/api/v1/tasks/:id` | Manager / Exec | Update task details. Rejects direct progress if subtasks exist (HTTP 409). |
| `DELETE` | `/api/v1/tasks/:id` | Manager / Exec | Cascade delete task, subtasks, and associated reports. |
| `POST` | `/api/v1/tasks/:id/subtasks` | Manager / Exec | Add weighted subtask milestone to task (HTTP 201). |
| `POST` | `/api/v1/tasks/:id/reassign` | Manager / Exec | Reassign task to another verified worker in organization. |
| `POST` | `/api/v1/tasks/:id/reports` | Worker | Submit progress report for manager verification (HTTP 201). |
| `POST` | `/api/v1/task-reports/:id/verify` | Manager / Exec | Approve or reject submitted worker task progress report. |
| `GET` | `/api/v1/schemes` | Authenticated | Browse verified government schemes catalog with sector filters. |
| `GET` | `/api/v1/projects/:id/schemes` | Authenticated | Evaluate project eligibility match against government schemes. |
| `POST` | `/api/v1/projects/:id/schemes/:schemeId/apply` | Manager / Exec | Track internal application preparation for government scheme. |
| `POST` | `/api/v1/projects/:id/schemes/:schemeId/readiness` | Manager / Exec | Update compliance readiness status (`pending`, `in_progress`, `verified`). |
| `POST` | `/api/v1/schemes/ingest` | Admin / Exec | Ingest external scheme catalog feed with schema validation. |
| `POST` | `/api/v1/organizations/apply` | Authenticated | Submit new organization registration for admin review. |
| `POST` | `/api/v1/organizations/join` | Authenticated | Join verified organization via single-use invitation code. |
| `POST` | `/api/v1/organizations/invites` | Manager / Exec | Generate expiring, single-use worker invitation code (HTTP 201). |
| `POST` | `/api/v1/organizations/invites/:id/revoke`| Manager / Exec | Revoke an unused organization invitation code. |
| `GET` | `/api/v1/admin/applications` | Platform Admin | View pending organization applications requiring verification. |
| `POST` | `/api/v1/admin/applications/:id/review` | Platform Admin | Approve or reject pending organization application. |
| `POST` | `/api/v1/assistant` | Authenticated | AI productivity assistant (JSON or progressive SSE stream). |
| `GET` | `/api/v1/export/tasks/csv` | Authenticated | Stream organization tasks CSV with formula injection defense. |
| `GET` | `/api/v1/export/projects/csv` | Authenticated | Stream organization projects CSV summary. |
| `GET` | `/api/v1/export/members/csv` | Manager / Exec | Stream organization worker roster CSV. |
| `GET` | `/api/v1/export/projects/:id/report.pdf` | Authenticated | Generate server-side PDF status report for project. |

---

## Database Concurrency & Known Limitations

### SQLite WAL Mode Architecture
ORION utilizes SQLite 3 with Write-Ahead Logging (WAL) for high-performance concurrent reads and single-writer safety:
- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA busy_timeout = 10000` (10-second lock wait queue)
- `PRAGMA foreign_keys = ON`

### Single-Instance Limitation
### Production Scaling & Single-Replica Constraint (`ARCH-01`)

> **CRITICAL ARCHITECTURAL REQUIREMENT**: In its default configuration, ORION uses an embedded SQLite database running in Write-Ahead Logging (WAL) mode with an in-process serialized transaction queue (`_txQueue`). 
> 
> **SQLite is strictly constrained to a single active replica**. Mounting a single SQLite file across multiple container pods over networked filesystems (NFS, SMB, CIFS, EFS) violates POSIX byte-range locking, causing `SQLITE_BUSY` deadlocks and unrecoverable database corruption.

For enterprise deployments requiring multi-pod horizontal scaling, zero-downtime rolling deploys, and distributed session states:
1. **Container Deployment**: Use `docker-compose.yml` to boot the application with `UV_THREADPOOL_SIZE=16`, volume-mounted local persistence, and built-in HTTP healthchecks.
2. **PostgreSQL 16 Migration Blueprint**: See [`docs/POSTGRES_MIGRATION.md`](docs/POSTGRES_MIGRATION.md) for the complete multi-pod architecture blueprint, PgBouncer pooling, row-level locking (`SELECT ... FOR UPDATE`), and Redis cluster integration.
3. **Enterprise DDL Migration**: Execute [`migrations/postgres/001_initial_schema.sql`](migrations/postgres/001_initial_schema.sql) on target PostgreSQL 16 instances for complete 64-bit sequence addressing, check constraints, and index parity.

### Backups and Restores
- `npm run backup`: Flushes the WAL log (`PRAGMA wal_checkpoint(TRUNCATE)`) and creates an atomic snapshot in `backups/`.
- `npm run restore -- <path>`: Prompts for `RESTORE`, creates a pre-restore backup, cleans up any stale `-wal` or `-shm` files, and safely restores the database snapshot.

---

## Automated Test Suites

ORION includes an extensive, zero-mocking test harness covering backend services, security boundaries, and workflows.

```powershell
# Run all unit, service, security, schemes, and streaming test suites
npm test

# Run full HTTP integration simulation (network-enabled environment)
npm run test:simulate
```

### Test Suites Included
1. `test_stubs.js`: Organization creation, invite codes, validation, duplicate prevention.
2. `test_tasks_crud.js`: Full task lifecycle, cascade deletion, subtasks, authorization.
3. `test_pagination.js`: Cursor pagination over 10,000 tasks, subtask batching, search filters.
4. `test_export.js`: Streaming CSV export, CSV formula injection neutralization, PDF generation.
5. `test_config.js`: Production session secret enforcement, demo account toggles.
6. `test_security.js`: Scrypt password hashing enforcement, render-sink XSS verification.
7. `test_workflows.js`: Multi-step organization application review, invites, and rate limits.
8. `test_schemes.js`: Government schemes catalog provenance, rule-based matching, tenant scoping, idempotent applications.
9. `test_assistant.js`: AI assistant tools, destructive proposal guards, cross-org isolation.
10. `test_assistant_streaming.js`: SSE streaming parsing, header-based Gemini authentication, abort signal handling.
11. `test_api_v1.js`: API v1 routing, `/api` legacy compatibility alias, REST 201 Created codes, and 410 Gone deprecation.
12. `test_data_integrity.js`: Migration 005 timestamp standardization, case-insensitive overdue detection, transaction concurrency, and queue non-poisoning.

*Note on Sandboxed Environments*: The integration simulation script (`simulate.js`) requires network socket binding for loopback HTTP traffic. In environments where loopback TCP sockets are restricted by a sandbox, run unit test suites (`npm test`) or execute the simulation outside the isolation sandbox.
