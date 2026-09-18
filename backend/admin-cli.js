#!/usr/bin/env node
'use strict';

// One-off local admin seeding, no HTTP server needed.
//   node backend/admin-cli.js create-admin <email>
//   printf '%s' "$PASSWORD" | node backend/admin-cli.js create-admin <email> --password-stdin
//
// Opens the same DB_PATH the server uses (env DB_PATH, else backend/mia-os.db),
// creates the user with role=admin if it doesn't exist yet, or promotes and
// resets the password of an existing row. Uses the real scrypt hash format
// the login route verifies against.

const path = require('path');
const db = require('./db');
const { hashPassword, isValidPassword, MIN_PASSWORD_LENGTH } = require('./admin');

function usage() {
  console.error('Usage: node backend/admin-cli.js create-admin <email> [--password-stdin]');
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      let password = chunks.join('');
      if (password.endsWith('\n')) password = password.slice(0, -1);
      if (password.endsWith('\r')) password = password.slice(0, -1);
      resolve(password);
    });
    process.stdin.on('error', reject);
  });
}

function readHiddenPrompt() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) return readStdin();
  return new Promise((resolve, reject) => {
    let password = '';
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(password);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          password = password.slice(0, -1);
        } else {
          password += char;
        }
      }
    };
    process.stderr.write('Password: ');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

async function main() {
  const [cmd, email, passwordMode, ...extra] = process.argv.slice(2);
  if (cmd !== 'create-admin' || !email || extra.length ||
      (passwordMode && passwordMode !== '--password-stdin')) usage();
  const password = passwordMode === '--password-stdin'
    ? await readStdin()
    : await readHiddenPrompt();
  if (!email.includes('@')) {
    console.error('error: email must look like an email address');
    process.exit(1);
  }
  if (!isValidPassword(password)) {
    console.error(`error: password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    process.exit(1);
  }

  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'mia-os.db');
  const DATA_DIR = process.env.DATA_DIR || '';
  const conn = db.openDb(DB_PATH, DATA_DIR);
  try {
    const normalized = email.trim().toLowerCase();
    const passwordHash = hashPassword(password);
    const existing = db.getUserByEmail(conn, normalized);
    if (existing) {
      db.setUserPassword(conn, normalized, passwordHash);
      db.setUserRole(conn, normalized, 'admin');
      db.setUserDisabled(conn, normalized, false);
      console.log(`Updated existing user ${normalized}: password reset, role=admin.`);
    } else {
      db.createUser(conn, { email: normalized, passwordHash, role: 'admin' });
      console.log(`Created admin user ${normalized}.`);
    }
    db.appendAuditLog(conn, { actor: 'admin-cli', action: 'admin.cli.create_admin', target: normalized });
  } finally {
    conn.close();
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
