'use strict';

module.exports = async function deprecateDeadUserColumns(data) {
    const columns = await data.all('PRAGMA table_info(users)');
    const columnNames = columns.map(c => c.name);

    if (columnNames.includes('securityQuestion')) {
        try {
            await data.run('ALTER TABLE users DROP COLUMN securityQuestion');
        } catch (err) {
            console.warn('[Migration 006] Could not drop securityQuestion column:', err.message);
        }
    }

    if (columnNames.includes('securityAnswer')) {
        try {
            await data.run('ALTER TABLE users DROP COLUMN securityAnswer');
        } catch (err) {
            console.warn('[Migration 006] Could not drop securityAnswer column:', err.message);
        }
    }
};
