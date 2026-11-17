# ORION Government Productivity Tool

ORION is a role-based project and task dashboard with an Express + SQLite backend and a vanilla JavaScript single-page frontend.

## Features

- Workers submit task reports or assigned subtasks for manager review.
- Subtask weights calculate task progress after manager approval; project progress is the average of its tasks.
- New accounts are always workers. An approved organization application grants its applicant organization administrator access.
- Workers join verified organizations with expiring, use-limited invitation codes. Only SHA-256 hashes of invite codes are stored; managers can review usage and revoke active codes.
- Organization-scoped queries and membership checks protect tenant data.
- Passwords are stored as salted scrypt hashes. Recovery uses one-time, hashed, expiring email tokens.
- SQLite-backed API rate limits cover registration, login, recovery, organization applications, and invite redemption.
- Motion durations and easing are configured near the top of `style.css`; reduced-motion preferences shorten them.

## Run

Prerequisite: Node.js 20.17 or newer (Node.js 22 is used by the Docker image and CI).

```powershell
npm install
Copy-Item .env.example .env
npm start
```

On Windows, run `start.bat` to launch the server in a separate terminal and open the app in your browser. Express serves the frontend and API together at `http://localhost:3000`.

Open `http://localhost:3000`.

The server loads `.env` only outside production. Copy `.env.example` for local development and replace its placeholder session secret. Password recovery in production requires `APP_BASE_URL` and SMTP settings. Production deployments must provide environment variables directly through the hosting platform; startup validates the database path, HTTPS CORS allowlist, strong session secret, application URL, and SMTP configuration before listening.

## Platform administrator bootstrap

Organization applications require a platform administrator. On first run, create one through the interactive CLI:

```powershell
npm run bootstrap-admin
```

The CLI prompts for an email and hidden password input, then refuses to run once a platform administrator exists. Start the server afterward. A platform administrator can review organization applications from **Organizations**. Approval creates the verified organization and assigns the applicant as its organization administrator.

The public site has a **Website Admin** portal at `#/admin`. Existing platform administrators sign in there and can create additional administrator accounts. The server checks the caller’s platform-admin role for every administrator list or creation request; public account registration cannot create an administrator.

By default, the API accepts same-origin requests. If the frontend is hosted on a separate origin, set a comma-separated exact allowlist before starting the server:

```powershell
$env:CORS_ORIGINS = "https://portal.example.gov"
```

The server does not trust forwarded IP headers by default. Deployments behind a reverse proxy should configure proxy trust explicitly before relying on client IP rate limits. SQLite-backed sessions and rate limits are intended for a single application instance. Mount the database on durable storage and take regular backups.

## Database migrations and backups

Schema changes run from the ordered files in `migrations/` and are recorded in `schema_migrations`. Keep one app instance connected to the SQLite database; do not share a SQLite file across multiple hosts. Use a durable mounted volume for `ORION_DB_PATH`.

```powershell
npm run backup
npm run restore -- .\backups\orion-2026-01-01T00-00-00-000Z.db
```

Restore prompts for the exact word `RESTORE`, requires the app to be stopped, and creates a pre-restore backup when the live database already exists. Store backups outside ephemeral containers and test restores before relying on them.

## Password recovery

Configure `APP_BASE_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` in production. The development mailer prints only a redacted delivery notice; configure a local SMTP sink if you need to receive reset links during development. The static FAQ assistant remains hard-coded and does not use an AI API key.

## Deployment

The Docker image installs production dependencies with `npm ci --omit=dev`, runs as the unprivileged `node` user, and checks the database-backed readiness endpoint. Supply production settings through the hosting platform or container environment; never bake secrets into the image.

Required production variables:

- `NODE_ENV=production`
- `ORION_DB_PATH` (for example, `/data/orion.db`)
- `SESSION_SECRET` (at least 32 random characters)
- `CORS_ORIGINS` (comma-separated exact HTTPS origins)
- `APP_BASE_URL` (the public HTTPS URL used in reset links)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`
- `PORT` is optional and defaults to `3000`.
- `TRUST_PROXY` is optional; set only for a known reverse proxy and use its trusted hop count or a supported proxy range keyword.

Example single-instance container with persistent SQLite storage:

```sh
docker build -t orion .
docker run -d --name orion \
  -p 3000:3000 \
  -v orion-data:/data \
  -e NODE_ENV=production \
  -e ORION_DB_PATH=/data/orion.db \
  -e SESSION_SECRET="$SESSION_SECRET" \
  -e CORS_ORIGINS="https://portal.example.gov" \
  -e APP_BASE_URL="https://portal.example.gov" \
  -e SMTP_HOST="$SMTP_HOST" -e SMTP_PORT=587 \
  -e SMTP_USER="$SMTP_USER" -e SMTP_PASSWORD="$SMTP_PASSWORD" \
  -e SMTP_FROM="ORION <no-reply@example.gov>" \
  orion
```

Run exactly one app instance with a durable mounted volume. SQLite sessions, migrations, and rate limits are local to that database; do not mount the same SQLite file for concurrent app instances. Create the named volume and bootstrap its first admin before starting the public container:

```sh
docker volume create orion-data
docker run --rm -it --entrypoint npm -v orion-data:/data \
  -e NODE_ENV=development -e ORION_DB_PATH=/data/orion.db \
  orion run bootstrap-admin
```

Then start the production container with the environment shown above. Run `npm run backup` regularly and copy backups to durable storage. Stop the app before `npm run restore -- <backup-path>`; restore prompts for confirmation and creates a pre-restore backup.

## Organization workflow

1. A signed-in user submits an organization application from **Organizations**.
2. A platform administrator approves, rejects, or requests more information.
3. Approval creates a verified institution, changes the applicant to `manager`, and creates an organization-admin membership.
4. The manager creates a limited-use invite and shares its code with team members. The code is displayed once.
5. Workers redeem the code from the dashboard. A user can belong to one organization.

## Task workflow

For a task without subtasks, workers submit a progress report and the task manager approves or rejects it. For a task with subtasks, the worker submits each subtask and the manager reviews it; approved subtask weights determine task progress. Direct progress updates through `POST /api/tasks/update` are disabled with HTTP 410.

## Tests

```powershell
npm test
```

The suite runs security unit checks, isolated service workflow checks, and an HTTP simulation covering signup/login, authorization, organization verification, invite redemption, task/subtask creation and approval, report approval, rate limits, and progress calculations. Tests always use PID-specific temporary SQLite databases and leave `orion.db` untouched.

## Main API routes

- `POST /api/register`, `POST /api/login`, `POST /api/logout`
- `GET /api/dashboard/:userId`
- `POST /api/organizations/applications`, `GET /api/organizations/applications/mine`
- `GET /api/platform/organization-applications`, `POST /api/platform/organization-applications/:id/review`
- `GET /api/platform/admins`, `POST /api/platform/admins` (platform administrators only)
- `POST /api/organizations/invites`, `GET /api/organizations/invites`, `POST /api/organizations/invites/:id/revoke`, `POST /api/organizations/redeem-invite`
- `POST /api/projects`, `POST /api/tasks`
- `GET /api/tasks/:id/subtasks`, `POST /api/tasks/:id/subtasks`
- `POST /api/subtasks/:id/submit`, `POST /api/subtasks/:id/review`
- `POST /api/reports`, `GET /api/reports/pending`, `POST /api/reports/:id/review`
- `GET /api/institutions?search=...` (verified organizations only)
