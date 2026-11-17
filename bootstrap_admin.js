const readline = require('readline');
const { loadConfig } = require('./config');
const { BackendData } = require('./backend_data');
const { hashSecret, validatePassword } = require('./auth_utils');

function ask(label) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(label, (answer) => { rl.close(); resolve(answer); }));
}

function askSecret(label) {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
        return Promise.reject(new Error('Admin bootstrap requires an interactive terminal for hidden password entry.'));
    }
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        let value = '';
        process.stdout.write(label);
        stdin.setRawMode(true);
        stdin.resume();
        const finish = (error) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            process.stdout.write('\n');
            if (error) reject(error); else resolve(value);
        };
        const onData = (chunk) => {
            for (const char of chunk.toString('utf8')) {
                if (char === '\u0003') return finish(new Error('Admin bootstrap cancelled.'));
                if (char === '\r' || char === '\n') return finish();
                if (char === '\u0008' || char === '\u007f') value = value.slice(0, -1);
                else if (char >= ' ') value += char;
            }
        };
        stdin.on('data', onData);
    });
}

async function main() {
    loadConfig();
    const data = new BackendData();
    try {
        await data.init();
        if (await data.get("SELECT id FROM users WHERE role='exec' LIMIT 1")) {
            throw new Error('A platform administrator already exists; bootstrap is disabled.');
        }
        const email = (await ask('Platform administrator email: ')).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
            throw new Error('Enter a valid email address (254 characters or fewer).');
        }
        const password = await askSecret('Password (input hidden): ');
        const confirm = await askSecret('Confirm password (input hidden): ');
        const passwordError = validatePassword(password);
        if (passwordError) throw new Error(passwordError);
        if (password !== confirm) throw new Error('Passwords do not match.');
        const passwordHash = await hashSecret(password);
        await data.withTransaction(async () => {
            if (await data.get("SELECT id FROM users WHERE role='exec' LIMIT 1")) {
                throw new Error('A platform administrator already exists; bootstrap is disabled.');
            }
            if (await data.get('SELECT id FROM users WHERE lower(username)=?', [email])) {
                throw new Error('An account with that email already exists.');
            }
            await data.run('INSERT INTO users (username,password,name,role) VALUES (?,?,?,?)', [email, passwordHash, email, 'exec']);
        });
        console.log(`Platform administrator initialized for ${email}.`);
    } finally {
        await data.close();
    }
}

main().catch((error) => {
    console.error(error.message || 'Admin bootstrap failed.');
    process.exitCode = 1;
});
