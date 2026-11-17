const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadConfig } = require('./config');
const { backupDatabase } = require('./database_tools');

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
    const config = loadConfig();
    const source = path.resolve(process.argv[2] || process.env.ORION_RESTORE_PATH || '');
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('Pass an existing SQLite backup path.');
    if (source === config.databasePath) throw new Error('Restore source must differ from the live database path.');
    const confirmation = await ask(`This replaces ${config.databasePath}. Stop the server first. Type RESTORE to continue: `);
    if (confirmation !== 'RESTORE') throw new Error('Restore cancelled.');
    const backupDir = path.join(__dirname, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(config.databasePath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await backupDatabase(config.databasePath, path.join(backupDir, `pre-restore-${timestamp}.db`));
    }
    await backupDatabase(source, config.databasePath);
    console.log('Database restore completed. Start the server and verify readiness.');
}

main().catch((error) => {
    console.error('Database restore failed:', error.message || 'unknown error');
    process.exitCode = 1;
});
