const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { backupDatabase } = require('./database_tools');

async function main() {
    const config = loadConfig();
    const backupDir = path.join(__dirname, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.resolve(process.argv[2] || path.join(backupDir, `orion-${timestamp}.db`));
    if (target === config.databasePath) throw new Error('Backup destination must differ from the live database path.');
    await backupDatabase(config.databasePath, target);
    console.log(`Database backup created at ${target}`);
}

main().catch((error) => {
    console.error('Database backup failed:', error.message || 'unknown error');
    process.exitCode = 1;
});
