# ORION Enterprise PostgreSQL Migration Blueprint (ARCH-01)

## Executive Summary & Architecture Context
ORION currently uses an embedded **SQLite database running in Write-Ahead Logging (WAL) mode** with busy timeouts (`5000ms`) and an internal in-process promise queue (`_txQueue`) to prevent concurrency deadlocks. 

While this architecture provides sub-millisecond query latencies and zero-maintenance local persistence for single-instance deployments, **SQLite is constrained to a single replica with local POSIX file locking**. Running multiple container pods mounted against the same SQLite database file over NFS or SMB causes lock contention, database corruption, and inconsistent session states.

This document details the complete production migration plan from SQLite to **PostgreSQL 16 Enterprise** with zero data loss, connection pooling, row-level locking, and Redis session clustering.

---

## 1. Schema Mapping & Type Conversions

| SQLite Concept | PostgreSQL 16 Equivalent | Migration Rationale |
| :--- | :--- | :--- |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` | 64-bit sequence addressing to eliminate key rollover at high throughput. |
| `TEXT` (JSON / comma-separated) | `TEXT` or `JSONB` | Native JSON querying and indexing for scheme criteria and audit payloads. |
| `INTEGER` (Unix Epoch Milliseconds) | `BIGINT` or `TIMESTAMPTZ` | Microsecond precision timestamps with timezone awareness. |
| `REAL` | `NUMERIC(15, 2)` or `NUMERIC(5, 2)` | Exact decimal arithmetic for financial budgets and subsidies; avoids IEEE-754 float drift. |
| `_txQueue` (In-process queue) | `SELECT ... FOR UPDATE` | ACID row-level locking at the database engine level across all app pods. |
| In-Memory `SessionCache` | Redis 7+ Cluster (`ioredis`) | Shared TTL-based session state across autoscaled stateless pods. |

The full PostgreSQL DDL translation is available in [`migrations/postgres/001_initial_schema.sql`](../migrations/postgres/001_initial_schema.sql).

---

## 2. Multi-Pod High Availability Architecture

```
                    ┌─────────────────────────┐
                    │      CloudFlare CDN     │
                    │   & Edge DDoS Shield    │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  Kubernetes Ingress /   │
                    │     AWS ALB (HTTPS)     │
                    └────────────┬────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
┌────────▼────────┐     ┌────────▼────────┐     ┌────────▼────────┐
│   ORION Pod 1   │     │   ORION Pod 2   │     │   ORION Pod N   │
│  (Node.js 22)   │     │  (Node.js 22)   │     │  (Node.js 22)   │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         ├───────────────────────┴───────────────────────┤
         │                                               │
┌────────▼────────────────────────────────┐     ┌────────▼────────┐
│        PgBouncer Connection Pooler      │     │  Redis Cluster  │
│         (Max 200 pool connections)      │     │(Sessions / Rate)│
└────────────────┬────────────────────────┘     └─────────────────┘
                 │
┌────────────────▼────────────────────────┐
│       PostgreSQL 16 Primary (Read/Write)│
│  - Row-Level Locking (FOR UPDATE)       │
│  - Synchronous Streaming Replication    │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│       PostgreSQL 16 Read Replica        │
│  - Offloads Reporting & CSV Exports     │
└─────────────────────────────────────────┘
```

---

## 3. Concurrency & Concurrency Control Replacement

### SQLite In-Process Queue (`backend_data.js`)
```javascript
// Existing SQLite implementation uses single-threaded serialized transactions:
async withTransaction(work) {
    return this._txQueue = this._txQueue.then(async () => {
        await this.run('BEGIN IMMEDIATE');
        try {
            const res = await work();
            await this.run('COMMIT');
            return res;
        } catch (err) {
            await this.run('ROLLBACK');
            throw err;
        }
    });
}
```

### PostgreSQL Multi-Pod Concurrency (`pg` Pool)
```javascript
// Production PostgreSQL implementation:
const { Pool } = require('pg');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

async function withTransaction(work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Critical Section (e.g., redeeming invite code):
async function redeemInvite(client, codeHash, userId) {
    const invite = await client.query(
        'SELECT * FROM organization_invites WHERE codeHash = $1 FOR UPDATE',
        [codeHash]
    );
    if (!invite.rows.length || invite.rows[0].usedCount >= invite.rows[0].maxUses) {
        throw new Error('Invite invalid or exhausted');
    }
    await client.query(
        'UPDATE organization_invites SET usedCount = usedCount + 1 WHERE id = $1',
        [invite.rows[0].id]
    );
}
```

---

## 4. Cutover Migration Checklist & Zero-Downtime Pipeline

1. **Pre-Migration Verification**:
   - Provision target RDS PostgreSQL 16 cluster with multi-AZ replication.
   - Run `migrations/postgres/001_initial_schema.sql` to initialize all 16 tables, check constraints, foreign keys, and indexes.
   - Deploy PgBouncer and test network latency between Kubernetes worker nodes and RDS.

2. **Data Export & Extraction**:
   - Put ORION in Maintenance Mode (`X-Maintenance: true` via Edge Ingress).
   - Flush SQLite WAL cache to disk: `PRAGMA wal_checkpoint(TRUNCATE);`.
   - Run extraction script (`node scripts/migrate_sqlite_to_postgres.js`) reading table by table and inserting batches inside transactions.
   - Verify SHA-256 record checksums between SQLite and PostgreSQL row counts.

3. **Application Reconfiguration**:
   - Set environment variable: `DATABASE_DRIVER=postgres`.
   - Set connection string: `DATABASE_URL=postgresql://orion_user:secret@pgbouncer:6432/orion?sslmode=require`.
   - Set Redis cluster: `REDIS_URL=redis://redis-cluster:6379`.
   - Boot application pods with `UV_THREADPOOL_SIZE=16`.

4. **Post-Cutover Smoke Tests**:
   - Run verification test suite: `npm test`.
   - Confirm login, organization scoping, task creation, scheme evaluation, and export checksum generation.
   - Remove maintenance mode flag and open traffic to end users.
