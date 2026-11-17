const sqlite3 = require('sqlite3').verbose();

function backupDatabase(sourcePath, destinationPath) {
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

module.exports = { backupDatabase };
