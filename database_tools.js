const sqlite3 = require('sqlite3').verbose();

function checkpointDatabase(dbPath) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return resolve();
            db.run('PRAGMA wal_checkpoint(TRUNCATE)', () => {
                db.close(() => resolve());
            });
        });
    });
}

async function backupDatabase(sourcePath, destinationPath) {
    // Flush WAL log before backup to ensure full data consistency
    await checkpointDatabase(sourcePath);

    return new Promise((resolve, reject) => {
        const source = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY, (openError) => {
            if (openError) return reject(openError);
            const backup = source.backup(destinationPath);
            backup.step(-1, (stepError) => {
                backup.finish((finishError) => {
                    source.close((closeError) => {
                        if (stepError) reject(stepError);
                        else if (finishError) reject(finishError);
                        else if (closeError) reject(closeError);
                        else resolve(destinationPath);
                    });
                });
            });
        });
    });
}

module.exports = { backupDatabase, checkpointDatabase };
