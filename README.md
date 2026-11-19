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

## Database Concurrency & Known Limitations

### SQLite WAL Mode Architecture
ORION utilizes SQLite 3 with Write-Ahead Logging (WAL) for high-performance concurrent reads and single-writer safety:
- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA busy_timeout = 10000` (10-second lock wait queue)
- `PRAGMA foreign_keys = ON`

### Single-Instance Limitation
> **Architectural Constraint**: SQLite is designed for a single application process accessing a local or volume-mounted database file. Running multiple concurrent Node.js processes against the same SQLite database file across multiple hosts or horizontal containers will cause database lock contention (`SQLITE_BUSY`).
>
> For multi-node horizontal autoscaling deployments, the database layer should be migrated to PostgreSQL or another client-server relational database.

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
