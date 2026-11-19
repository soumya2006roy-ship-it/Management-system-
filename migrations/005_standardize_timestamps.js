'use strict';

function toCanonicalTimestamp(val) {
    if (!val) return null;
    const str = String(val).trim();
    if (!str) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        return str;
    }
    let d;
    if (/^\d+$/.test(str)) {
        d = new Date(Number(str));
    } else {
        d = new Date(str);
    }
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
}

module.exports = async function standardizeTimestamps(data) {
    // 1. Standardize tasks.deadline to canonical date / ISO text
    const tasks = await data.all("SELECT id, deadline FROM tasks WHERE deadline IS NOT NULL AND deadline != ''");
    for (const t of tasks) {
        const canonical = toCanonicalTimestamp(t.deadline);
        if (canonical && canonical !== t.deadline) {
            await data.run('UPDATE tasks SET deadline = ? WHERE id = ?', [canonical, t.id]);
        }
    }

    // 2. Standardize subtasks.dueDate to canonical date / ISO text
    const subtasks = await data.all("SELECT id, dueDate FROM subtasks WHERE dueDate IS NOT NULL AND dueDate != ''");
    for (const s of subtasks) {
        const canonical = toCanonicalTimestamp(s.dueDate);
        if (canonical && canonical !== s.dueDate) {
            await data.run('UPDATE subtasks SET dueDate = ? WHERE id = ?', [canonical, s.id]);
        }
    }
};
