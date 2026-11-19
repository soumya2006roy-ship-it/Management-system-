const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { logError } = require('./logger');

class BackendData {
    constructor() {
        const dbPath = process.env.ORION_DB_PATH
            ? path.resolve(process.env.ORION_DB_PATH)
            : path.join(__dirname, 'orion.db');
        this.db = new sqlite3.Database(dbPath);
        this.db.configure('busyTimeout', 10000);
        this._txQueue = Promise.resolve();
    }

    async init() {
        await this.run('PRAGMA journal_mode = WAL');
        await this.run('PRAGMA synchronous = NORMAL');
        await this.run('PRAGMA busy_timeout = 10000');
        await this.run('PRAGMA foreign_keys = ON');
        await this.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL)');
        const fs = require('fs');
        const migrationDir = path.join(__dirname, 'migrations');
        const files = fs.readdirSync(migrationDir).filter((name) => /^\d+_[a-z0-9_]+\.js$/i.test(name)).sort();
        for (const filename of files) {
            const version = Number(filename.split('_')[0]);
            const applied = await this.get('SELECT version FROM schema_migrations WHERE version=?', [version]);
            if (applied) continue;
            const migration = require(path.join(migrationDir, filename));
            await this.withTransaction(async () => {
                await migration(this);
                await this.run('INSERT INTO schema_migrations (version,appliedAt) VALUES (?,?)', [version, Date.now()]);
            });
        }
    }
    ensureColumn(table, column, definition) {
        const allowedTables = new Set(['tasks', 'users', 'projects', 'updates', 'institutions']);
        const allowedColumns = new Set(['createdBy', 'organizationId', 'verificationStatus', 'description', 'priority']);
        const allowedDefs = new Set(['INTEGER', "TEXT NOT NULL DEFAULT 'unverified'", "TEXT DEFAULT ''", "TEXT DEFAULT 'normal'"]);
        if (!allowedTables.has(table) || !allowedColumns.has(column) || !allowedDefs.has(definition)) {
            return Promise.reject(new Error('Invalid schema migration'));
        }
        return this.all(`PRAGMA table_info(${table})`).then((columns) => {
            const exists = columns.some((entry) => entry.name === column);
            if (!exists) {
                return this.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
            }
            return null;
        });
    }

    run(sql, params = []) {
        if (this.sessionCache && typeof sql === 'string' && /sessions/i.test(sql)) {
            if (/update\s+sessions/i.test(sql) || /delete\s+from\s+sessions/i.test(sql)) {
                for (const p of params) {
                    if (typeof p === 'string' && p.length === 64) {
                        this.sessionCache.delete(p);
                    } else if (typeof p === 'number') {
                        this.sessionCache.invalidateUser(p);
                    }
                }
            }
        }
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function onRun(err) {
                if (err) {
                    reject(err);
                    return;
                }
                resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(row);
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(rows);
            });
        });
    }

    async createSession(tokenHash, userId, expiresAt) {
        await this.run('INSERT INTO sessions (tokenHash,userId,createdAt,expiresAt) VALUES (?,?,?,?)', [tokenHash, userId, Date.now(), expiresAt]);
    }

    getSession(tokenHash) {
        return this.get('SELECT userId,expiresAt FROM sessions WHERE tokenHash=?', [tokenHash]);
    }

    deleteSession(tokenHash) {
        return this.run('DELETE FROM sessions WHERE tokenHash=?', [tokenHash]);
    }

    deleteSessionsForUser(userId) {
        return this.run('DELETE FROM sessions WHERE userId=?', [userId]);
    }

    deleteExpiredSessions(now = Date.now()) {
        return this.run('DELETE FROM sessions WHERE expiresAt<=?', [now]);
    }

    createPasswordResetToken(tokenHash, userId, expiresAt) {
        return this.run('INSERT INTO password_reset_tokens (tokenHash,userId,createdAt,expiresAt,usedAt) VALUES (?,?,?,?,NULL)', [tokenHash, userId, Date.now(), expiresAt]);
    }

    getPasswordResetToken(tokenHash) {
        return this.get('SELECT tokenHash,userId,expiresAt,usedAt FROM password_reset_tokens WHERE tokenHash=?', [tokenHash]);
    }

    deletePasswordResetTokensForUser(userId) {
        return this.run('DELETE FROM password_reset_tokens WHERE userId=?', [userId]);
    }

    consumePasswordResetToken(tokenHash, now = Date.now()) {
        return this.run('UPDATE password_reset_tokens SET usedAt=? WHERE tokenHash=? AND usedAt IS NULL AND expiresAt>?', [now, tokenHash, now]);
    }

    withTransaction(work) {
        const execute = async () => {
            await this.run('BEGIN IMMEDIATE TRANSACTION');
            try {
                const result = await work();
                await this.run('COMMIT');
                return result;
            } catch (error) {
                try {
                    await this.run('ROLLBACK');
                } catch (_rollbackError) {
                    // Connection may already be rolled back after a failed statement.
                }
                throw error;
            }
        };

        const current = this._txQueue.then(execute, execute);
        this._txQueue = current.catch(() => {});
        return current;
    }

    addUpdate(author, text, organizationId = null) {
        return this.run(
            'INSERT INTO updates (author, text, timestamp, organizationId) VALUES (?, ?, ?, ?)',
            [String(author || 'System'), String(text || ''), Date.now(), organizationId == null ? null : Number(organizationId)]
        ).catch((err) => {
            logError('system_update_write_failed', err);
        });
    }

    close() {
        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }
}

module.exports = { BackendData };
