'use strict';
// Wipes every attempt (and therefore the leaderboards). Student accounts are kept.
// Usage: npm run reset          -> asks for nothing, just do it
//        npm run reset -- --all -> also deletes all student accounts
const { db } = require('../db');

const all = process.argv.includes('--all');
const attempts = db.prepare('DELETE FROM attempts').run().changes;
let users = 0;
if (all) users = db.prepare('DELETE FROM users').run().changes;

console.log(`Deleted ${attempts} attempt(s)${all ? ` and ${users} account(s)` : ''}.`);
