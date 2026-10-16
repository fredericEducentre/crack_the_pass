'use strict';
// Creates (or resets the password of) the real "admin" account used for the optional bonus
// challenge: students try to log into it through the normal sign-in form, like any other
// account. It is NOT a game level - no secret, no timer, no leaderboard entry.
//
// This is a real account with a real password you choose, protected the same way as any other
// account here (bcrypt hash, rate-limited login). Pick a username the public /api/register
// endpoint refuses on its own (admin, administrateur, administrator, root, teacher, professeur -
// see RESERVED_USERNAMES in server.js), so no student can grab it first, and choose a password
// you are comfortable students trying to guess - never reuse a password you use anywhere else.
//
// Usage: node scripts/create-admin.js <username> <password>
//        node scripts/create-admin.js admin "une phrase de douze !"
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node scripts/create-admin.js <username> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Le mot de passe doit faire au moins 8 caractères (même règle que pour les élèves).');
  process.exit(1);
}
if (Buffer.byteLength(password) > 72) {
  console.error('Le mot de passe est trop long (72 octets max, même règle que pour les élèves).');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

if (existing) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
  console.log(`Mot de passe mis à jour pour le compte "${username}" (id ${existing.id}).`);
} else {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hash, Date.now());
  console.log(`Compte "${username}" créé (id ${lastInsertRowid}).`);
}
