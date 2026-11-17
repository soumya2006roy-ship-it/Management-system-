const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const SCRYPT_PREFIX = 'scrypt$';
const KEY_LEN = 32;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const ROLE_MAP = {
    worker: 'worker',
    manager: 'manager',
    exec: 'exec',
    executive: 'exec'
};

function normalizeRole(role) {
    const key = String(role || '').trim().toLowerCase();
    return ROLE_MAP[key] || null;
}

function publicUser(user, extra = {}) {
    if (!user) {
        return null;
    }
    return {
        id: user.id,
        username: user.username,
        name: user.name,
        role: normalizeRole(user.role) || user.role,
        organizationId: user.organizationId == null ? null : user.organizationId,
        ...extra
    };
}

function timingSafeEqualString(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    const size = Math.max(a.length, b.length, 1);
    const padA = Buffer.alloc(size);
    const padB = Buffer.alloc(size);
    a.copy(padA);
    b.copy(padB);
    const sameContent = crypto.timingSafeEqual(padA, padB);
    return sameContent && a.length === b.length;
}

async function hashSecret(value) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await scrypt(String(value), salt, KEY_LEN, SCRYPT_OPTIONS);
    return `${SCRYPT_PREFIX}${salt}$${derived.toString('hex')}`;
}

function isHashedSecret(stored) {
    return String(stored || '').startsWith(SCRYPT_PREFIX);
}

const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';

async function verifySecret(value, stored) {
    if (value == null || value === '' || stored == null || stored === '') {
        return false;
    }
    const recorded = String(stored);
    if (!isHashedSecret(recorded)) {
        return timingSafeEqualString(value, recorded);
    }
    const parts = recorded.split('$');
    if (parts.length !== 3) {
        return false;
    }
    const salt = parts[1];
    const expectedHex = parts[2];
    const derived = await scrypt(String(value), salt, KEY_LEN, SCRYPT_OPTIONS);
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) {
        return false;
    }
    return crypto.timingSafeEqual(derived, expected);
}

function validatePassword(password) {
    const value = String(password || '');
    if (value.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (value.length > MAX_PASSWORD_LENGTH) {
        return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
    }
    return null;
}

function escapeLike(term) {
    return String(term || '')
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
}

module.exports = {
    MIN_PASSWORD_LENGTH,
    hashSecret,
    isHashedSecret,
    normalizeRole,
    publicUser,
    validatePassword,
    verifySecret,
    escapeLike,
    DUMMY_HASH
};
