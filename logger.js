const SECRET_KEY = /(password|token|secret|cookie|authorization|smtp|csrf|credential|api.?key)/i;

function redact(value, key = '') {
    if (SECRET_KEY.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
    }
    return value;
}

function log(level, event, fields = {}) {
    const record = redact({ timestamp: new Date().toISOString(), level, event, ...fields });
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

function logError(event, error, fields = {}) {
    log('error', event, {
        ...fields,
        errorName: error && error.name ? String(error.name) : 'Error',
        errorMessage: error && error.message ? String(error.message).replace(/(password|token|secret|cookie|authorization|smtp|csrf|api.?key)(\s*[:=]\s*)[^\s,;]+/ig, '$1$2[REDACTED]') : 'Unknown error'
    });
}

module.exports = { log, logError, redact };
