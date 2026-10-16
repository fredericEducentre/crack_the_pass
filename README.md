# crack_the_pass

A small web game for teaching how weak short passwords are. Students register, log in, and try to
guess a secret password across **13 levels in 3 categories**. The clock runs from the moment
they press *Start* until they find the password. Leaderboards rank students by time for each level.

Built with Node.js, Express and SQLite (the database is one file, using the SQLite that ships inside Node).

## Run it

```bash
npm install
npm start
```

Open <http://localhost:3000>. To let students on the same network join, give them
`http://<your-computer-ip>:3000` (find your IP with `ipconfig` on Windows or `ifconfig` / `ip a` on Mac/Linux).

Requires **Node.js 22.13 or newer** (check with `node -v`). There is nothing to compile: the database is SQLite built into Node, so `npm install` only downloads plain JavaScript packages.

## How the game works

Levels are grouped in three categories. A category fixes which characters the secret is made of;
its levels make the secret longer one step at a time ("any" = the 94 printable keyboard characters:
lowercase, uppercase, digits and symbols; the space and emojis are never used).

| Category | Level | Secret length | Each character is | Possible passwords |
|----------|------:|--------------:|-------------------|-------------------:|
| Digits | 1 | 1 | a digit (0-9) | 10 |
| Digits | 2 | 2 | a digit | 100 |
| Digits | 3 | 3 | a digit | 1,000 |
| Digits | 4 | 4 | a digit | 10,000 |
| Letters | 5 | 1 | a letter (a-z or A-Z) | 52 |
| Letters | 6 | 2 | a letter | 2,704 |
| Letters | 7 | 3 | a letter | 140,608 |
| Letters | 8 | 4 | a letter | 7,311,616 |
| Characters | 9 | 1 | any character | 94 |
| Characters | 10 | 2 | any character | 8,836 |
| Characters | 11 | 3 | any character | 830,584 |
| Characters | 12 | 4 | any character | 78,074,896 |
| Characters | 13 | 8 | any character | about 6.1 x 10^15 |

The categories and levels are defined at the top of `server.js` (`CATEGORIES`). Level ids are numbered
1 to 13 across categories; the API uses these ids. Level 13 is deliberately out of reach of brute force
through the API: it is there to show why length (and variety) matter.

- Categories are **independent**: each one starts unlocked, and a level unlocks when the previous level
  *of the same category* is cracked.
- Each run gets a **new random password**, chosen and stored by the server. The browser never sees it
  until it is found (or the student gives up).
- The server only answers *correct* or *wrong*. Short levels are easy by hand, the 4-character levels are painful,
  and that is where students realise they need to automate. That is the lesson.
- The timer is measured **on the server**, so it can't be faked from the browser.
- A run survives page reloads: reloading resumes the same password and the same clock.
- Each level card shows how many combinations there are (characters to choose from, raised to the
  secret's length), so students can see the effort explode from one level to the next.

### Ranking

- **Per level:** each student appears once with their **best (fastest) time**. If two students have the
  same time, the one who **finished first** ranks higher. The board shows time, finish hour and number
  of guesses.
- **Overall:** most levels cracked first, then smallest total of best times, then earliest last finish.
- The leaderboard refreshes itself every few seconds.

## Configuration

Set with environment variables (e.g. `PORT=8080 npm start`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `GUESS_RATE_PER_SEC` | `1000` | Max guesses per second per student (protects the server) |
| `DATA_DIR` | `./data` | Where the SQLite database and the session secret are stored |
| `JWT_SECRET` | generated | Key that signs login cookies. Generated once into `data/jwt.secret` if not set |
| `COOKIE_SECURE` | `false` | Set to `true` when served over HTTPS |
| `TRUST_PROXY` | unset | Set to `true` behind a reverse proxy (nginx, Render, ...) |
| `REGISTER_RATE_MAX` | `300` | Sign-ups allowed per hour per IP (a whole class may share one IP) |

## Reset between classes

```bash
npm run reset            # clears all runs and leaderboards, keeps student accounts
npm run reset -- --all   # also deletes every student account
```

Stop the server first if you want to be extra safe. You can also just delete the `data/` folder.

## Optional bonus challenge: a real account to log into

Unlike the levels above (a random throwaway secret per run), this is a **real account you create
yourself**, with a real password, that students try to log into through the normal sign-in form —
not through any game mechanic. It has no secret, no timer, and **does not appear in the levels or in
any leaderboard**.

```bash
npm run create-admin -- admin "une phrase de douze !"
# or directly:
node scripts/create-admin.js admin "une phrase de douze !"
```

This creates (or resets the password of) a real account. Running it again with the same username
changes its password, so you can rotate it between classes. A few usernames (`admin`,
`administrateur`, `administrator`, `root`, `teacher`, `professeur`) are reserved: students can never
register them through the sign-up form, so the one you pick stays free for you to claim.

Students log into it exactly like their own account — sign out, then sign in with that username and
their guess. The same password hashing, the same per-username login rate limit (10 failed attempts
per 15 minutes) and the same session cookie apply as for everyone else: the only thing special about
this account is what it unlocks once signed in. That rate limit is itself part of the lesson: it is
what actually makes a weak password survive guessing through the login form, as opposed to the
unprotected `/guess` endpoint the levels above use.

### What logging in as this account unlocks: a read-only "database" page

Once signed in as a reserved username, a **"Base de données"** link appears in the nav, leading to a
page that lists every account and every attempt (secret, level, status, guesses, timing) across every
student. It is **read-only**: there is no button and no API route to add, edit or delete anything from
it — only `GET /api/admin/overview`, guarded server-side so any other account gets a 403. It never
returns password hashes, even to this account: that stays off-limits so a real student's real
password (which they may reuse elsewhere) can never be pulled out and cracked offline through the app.

Never reuse a password you use anywhere else for this account, and don't tell students it when you
want them to guess it.

## Optional: show them what automation does

`examples/bruteforce.js` is a tiny script that logs in as a student and tries every combination:

```bash
node examples/bruteforce.js <username> <password> <level>
```

It cracks levels 1-3 in seconds. Level 4 takes several minutes because it sends one request per guess,
which makes a good discussion: what would change if the attacker had the password *hash* and could try
billions of guesses per second on their own machine? Keep the file private if you would rather students
discover scripting themselves, or hand it out to start the conversation.

## Project layout

```
server.js                 Express API: auth, levels, guesses, leaderboards
db.js                     SQLite schema (users, attempts)
public/                   Single page frontend (index.html, style.css, app.js)
scripts/reset-leaderboard.js
scripts/create-admin.js
examples/bruteforce.js
data/                     Created on first run (database + session key)
```

## Security notes

Account passwords are hashed with bcrypt and must be at least 8 characters (the app that teaches about
weak passwords shouldn't accept them). Sessions are signed, `httpOnly` cookies. Login attempts are
rate-limited per username, API writes require JSON, and the page renders all user-provided text as plain
text. It is meant for a classroom, so tell students not to reuse a real password.

A handful of usernames are reserved (see `RESERVED_USERNAMES` in `server.js`) so students can't grab
them through self-registration; they stay free for the optional bonus-challenge account above.
