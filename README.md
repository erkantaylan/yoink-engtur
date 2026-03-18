# Yoink Tureng

A self-hosted Tureng dictionary proxy with user accounts, spaced repetition flashcards, and Telegram reminders. Every word you look up is automatically saved and scheduled for review.

No browser extensions needed — one Docker stack, accessible from any device.

## Why?

Tureng is one of the best Turkish-English dictionaries, but it has no way to track words you've looked up. If you're learning a language, you want to revisit those words later — ideally through spaced repetition.

A browser extension would work, but breaks down when you're using Chrome, Firefox, Ungoogled Chromium, mobile browsers, and multiple computers — that's 20+ places to install and sync.

Instead: one self-hosted web app with user accounts, accessible from any browser, any device.

## The Problem: Cloudflare

Tureng protects all endpoints behind Cloudflare's managed challenge. Every subdomain returns 403 to non-browser requests.

### What We Tried

1. **The website** (`tureng.com/en/turkish-english/<word>`) — Cloudflare 403
2. **The WCF API** (`ws.tureng.com/TurengSearchServiceV4.svc/Search`) — found via the [tureng npm package](https://www.npmjs.com/package/tureng). Cloudflare 403.
3. **The Android APK** — decompiled it and found a v3 REST API (`api.tureng.com/v3/Dictionary/{lang}/{term}`), API keys, and client headers. Still Cloudflare 403 — the app uses Cloudflare's mobile bot management SDK.
4. **The autocomplete endpoint** (`ac.tureng.co/?t={word}&l={lang}`) — the only endpoint without Cloudflare, but only returns suggestions, not translations.

### The Solution

[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) solves the Cloudflare challenge in a real browser on the first request. We cache the resulting cookies and reuse them with `curl` for subsequent requests:

```
First request:   You → App → FlareSolverr → tureng.com     (~15-20s, solves challenge)
Next requests:   You → App → curl (cached cookies) → tureng.com  (~0.4s)
```

Cookies auto-refresh when they expire (~25 min).

## Features

- **Multi-user** — username/password accounts, each user has their own word list
- **Dictionary search** — search Tureng with autocomplete suggestions
- **Auto-save** — every search saves the word + all translations to PostgreSQL
- **Spaced repetition** — SM-2 algorithm schedules reviews with increasing intervals
- **Flashcards** — built-in Anki-style review (Again / Hard / Easy)
- **Telegram reminders** — each user connects their own Telegram bot for push notifications
  - Flashcard messages with inline Again/Hard/Easy buttons
  - Configurable active hours and daily limits
  - On-demand review via `/review` command
- **Anki export** — download all words as TSV, import directly into Anki
- **Multi-language** — EN-TR, TR-EN, EN-DE, EN-ES, EN-FR
- **Mobile friendly** — responsive UI
- **No extensions** — works from any browser on any device

## Quick Start

```bash
git clone git@github.com:erkantaylan/yoink-engtur.git
cd yoink-engtur
docker compose up -d
```

Open `http://localhost:3000`, create an account, and start searching.

First search takes 15-20 seconds (Cloudflare challenge). After that, searches take under a second.

## Setting Up Telegram Reminders

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the token (looks like `123456789:ABCdefGHI...`)
4. In the app, go to **Settings** and paste the token
5. Open your new bot in Telegram and press **Start**
6. Configure reminder hours and daily card limit in Settings

Each user creates and uses their own bot — no shared infrastructure.

## Architecture

```
docker-compose.yml
├── postgres         (user data, words, sessions)
├── flaresolverr     (Cloudflare bypass — headless Chrome)
└── app              (Node.js)
    ├── server.js    (Express API + auth + routes)
    ├── db.js        (PostgreSQL schema + queries)
    ├── tureng.js    (FlareSolverr + HTML parser)
    ├── telegram.js  (per-user bot manager)
    ├── scheduler.js (cron-based review reminders)
    └── public/
        └── index.html
```

## API

All endpoints except `/api/autocomplete`, `/api/register`, and `/api/login` require authentication (session cookie).

| Endpoint | Method | Description |
|---|---|---|
| `/api/register` | POST | Create account `{username, password}` |
| `/api/login` | POST | Log in `{username, password}` |
| `/api/logout` | POST | Log out |
| `/api/me` | GET | Current user info |
| `/api/search?term=hello&lang=entr` | GET | Search and auto-save |
| `/api/autocomplete?term=hel&lang=entr` | GET | Autocomplete |
| `/api/words?status=new` | GET | List saved words |
| `/api/words/:id` | PATCH | Review word `{action: "again"|"hard"|"easy"}` |
| `/api/words/:id` | DELETE | Delete a word |
| `/api/export/anki` | GET | Download Anki TSV |
| `/api/stats` | GET | Word count stats |
| `/api/settings` | PUT | Update reminder settings |
| `/api/settings/telegram` | POST | Set bot token `{botToken}` |
| `/api/settings/telegram` | DELETE | Remove Telegram bot |

## Spaced Repetition

Uses a simplified SM-2 algorithm:

| Action | Effect |
|---|---|
| **Again** | Reset to 1 day, decrease ease factor |
| **Hard** | Interval x 1.2, slight ease decrease |
| **Easy** | Interval x ease factor, slight ease increase |

Words graduate to "learned" status when their interval reaches 21+ days.

## Notes

- FlareSolverr pulls a ~200MB Chromium image on first run
- PostgreSQL data persists in a Docker volume (`pgdata`)
- Change `SESSION_SECRET` in docker-compose.yml for production
- The HTML parser matches Tureng's current page structure — may need updates if they redesign
- Be respectful of Tureng's servers
