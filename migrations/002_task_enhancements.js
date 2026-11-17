'use strict';

module.exports = async function taskEnhancements(data) {
    await data.ensureColumn('tasks', 'description', "TEXT DEFAULT ''");
    await data.ensureColumn('tasks', 'priority', "TEXT DEFAULT 'normal'");
};
