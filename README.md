# Yoink Tureng

A self-hosted proxy for [Tureng](https://tureng.com) dictionary that automatically saves every word you look up and turns them into flashcards. No browser extensions, no accounts — just a Docker container accessible from any device on your network.

## Why?

Tureng is one of the best Turkish-English dictionaries out there, but it has no built-in way to track words you've looked up. If you're learning a language, you want to revisit those words later — ideally as Anki-style flashcards.

The obvious solution would be a browser extension, but that falls apart fast when you're using Chrome, Firefox, Ungoogled Chromium, mobile browsers, and multiple computers. You'd need to install and sync the extension across 20+ places.

So instead: one self-hosted web app, accessible from any browser, any device.

## The Problem: Cloudflare

Tureng protects all of its endpoints behind Cloudflare's managed challenge. Every subdomain — `api.tureng.com`, `ws.tureng.com`, `tureng.com` itself — returns a 403 to any non-browser request. You can't just `curl` or `fetch()` from a server.

### What We Tried

We investigated every angle:

1. **The website** (`tureng.com/en/turkish-english/<word>`) — Cloudflare 403
2. **The old WCF API** (`ws.tureng.com/TurengSearchServiceV4.svc/Search`) — found via the [tureng npm package](https://www.npmjs.com/package/tureng), uses an MD5 token (`word + "46E59BAC-E593-4F4F-A4DB-960857086F9C"`). Cloudflare 403.
3. **The Android APK** — decompiled it and found:
   - A **v3 REST API** at `api.tureng.com/v3/Dictionary/{lang}/{term}`
   - API key: `Tureng-Api-Key: b7e2c4d9...`
   - Client headers: `Tureng-Client-Id: tureng-android`
   - A sentence translation service at `translate-lb.tureng.com`
   - Still Cloudflare 403 — the app uses Cloudflare's mobile bot management SDK to bypass challenges, which can't be replicated server-side
4. **The autocomplete endpoint** (`ac.tureng.co/?t={word}&l={lang}`) — the *only* endpoint that works without Cloudflare. But it only returns word suggestions, not translations.

### The Solution

[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) — a headless Chrome instance that solves Cloudflare challenges. On the first search, FlareSolverr navigates to tureng.com in a real browser, waits for the challenge to clear, and returns the page HTML along with the `cf_clearance` cookies and User-Agent string.

We then cache those cookies and reuse them with `curl` for all subsequent requests. This brings response times down from ~20 seconds (full browser render) to **~0.4 seconds** (direct HTTP with cached cookies). Cookies are valid for ~25 minutes and automatically refresh when they expire.

```
First request:  Browser (you) → App → FlareSolverr (solves Cloudflare) → tureng.com  (~15-20s)
                                  ↓
                          caches cookies + user-agent
                                  ↓
Next requests:  Browser (you) → App → curl (with cached cookies) → tureng.com       (~0.4s)
```

## Features

- **Dictionary search** — search Tureng from a clean, fast interface
- **Autocomplete** — instant suggestions as you type (hits `ac.tureng.co` directly, no Cloudflare)
- **Auto-save** — every search automatically saves the word and all translations to a local SQLite database
- **Word management** — browse, filter, and organize saved words by status: new / reviewing / learned
- **Flashcards** — built-in Anki-style review with Again / Hard / Easy buttons
- **Anki export** — download all saved words as a TSV file, import directly into Anki
- **Multi-language** — EN-TR, TR-EN, EN-DE, EN-ES, EN-FR
- **Mobile friendly** — responsive UI, works on any screen size
- **Zero extensions** — access from any browser, any device on your network

## Quick Start

```bash
git clone <repo-url> && cd yoink-tureng
docker compose up -d
```

Open `http://localhost:3000` (or `http://<your-local-ip>:3000` from other devices).

The first search will take 15-20 seconds while FlareSolverr solves the Cloudflare challenge. Every search after that takes under a second.

## Architecture

```
docker-compose.yml
├── flaresolverr     (Cloudflare bypass — headless Chrome)
└── app              (Node.js — Express API + static frontend)
    ├── server.js    (API routes)
    ├── tureng.js    (FlareSolverr integration + HTML parser)
    ├── db.js        (SQLite via better-sqlite3)
    └── public/
        └── index.html  (single-file frontend)
```

Data is persisted in `./data/words.db` (SQLite, volume-mounted).

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/search?term=hello&lang=entr` | GET | Search and auto-save |
| `/api/autocomplete?term=hel&lang=entr` | GET | Autocomplete suggestions |
| `/api/words?status=new` | GET | List saved words (optional status filter) |
| `/api/words/:id` | PATCH | Update word status (`{"status": "learned"}`) |
| `/api/words/:id` | DELETE | Delete a word |
| `/api/export/anki` | GET | Download Anki-compatible TSV |
| `/api/stats` | GET | Word count stats |

## Language Codes

| Code | Direction |
|---|---|
| `entr` | English → Turkish |
| `tren` | Turkish → English |
| `ende` | English → German |
| `deen` | German → English |
| `enes` | English → Spanish |
| `esen` | Spanish → English |
| `enfr` | English → French |
| `fren` | French → English |

## Importing into Anki

1. Go to the **My Words** tab
2. Click **Export Anki**
3. In Anki: File → Import → select the downloaded `.txt` file
4. Set field separator to **Tab**, map fields to Front/Back

## Notes

- FlareSolverr pulls a ~200MB Chromium image on first run
- Cloudflare cookies expire after ~30 minutes; the app re-solves automatically when needed
- The HTML parser handles Tureng's current page structure; if Tureng redesigns their site, the parser may need updating
- This is a personal tool for language learning — be respectful of Tureng's servers
