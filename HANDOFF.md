# Tango Hop — handoff brief

You're picking up a project mid-stream. Below is everything you need; the rest is in the repo.

## What this is

**Tango Hop** — a FreePBX-themed HTML5 canvas game in the style of the classic arcade hopper. The player guides **Tango** (the FreePBX mascot frog) across SIP trunk lanes and RTP streams to dock on 5 extension pads. Built for a Sangoma online swag-giveaway promo: high score at end of day wins a FreePBX swag pack.

- **Repo:** https://github.com/mwtcmi/tangohop
- **Local working dir:** `/Users/michael/code/tangodefrogger` (directory wasn't renamed locally; remote was renamed via `gh repo rename tangohop`)
- **GitHub Pages URL:** https://mwtcmi.github.io/tangohop/
- **Production domain (planned):** https://tangohop.freepbxapps.com (user owns it; not pointed at anything yet)

## Branding decisions (important)

- Game was originally a fork of [denodell/frogger](https://github.com/denodell/frogger). All user-visible "Frogger" strings have been replaced — Konami trademark concern.
- **Public name:** "Tango Hop" (in title) or "Tango Hop — FreePBX Edition" (in headers). Character is "Tango".
- **Internal namespace** (`var Frogger = ...` in `scripts/main.js`) intentionally left untouched — 189 references, not a trademark issue (private API identifier), and renaming invites bugs.
- **Attribution kept:** "Forked from denodell/frogger" stays in README and footer. That's correct open-source credit.
- Anything in env vars / service names / paths on the server should use **`TANGOHOP_*`**, not `FROGMAN_*`. An earlier draft used "Frogman" — that's a separate, unrelated repo of the user's, not this project.

## Current game state

Game works in the browser. Reload and play:

```bash
python3 -m http.server 8765
# open http://localhost:8765/
```

Files:
- `index.html` — Sangoma/FreePBX-themed chrome (header with logo, side panels, branded canvas frame). Loads Arcade Classic via `@font-face` and gates game-script loading on `document.fonts.load()` so canvas `fillText` doesn't fall back to a too-large default.
- `scripts/main.js` — original denodell engine, mostly untouched. Expects `<canvas id="canvas">` + `<canvas id="background-canvas">`, both 960×1280 (matches the 11-col × 16-row × 80px grid). CSS scales to 480×640 for display.
- `scripts/theme-freepbx.js` — paints a FreePBX-themed background over the original `gameboard.gif` on `window.load`. Zones (matched to engine row indices):
  - Row 0: top HUD strip (score area)
  - Rows 1–2: pad alcoves with 5 "EXT 101–105" slots, aligned to engine Goal x-positions
  - Rows 3–7: RTP STREAM water (5 rows, blue with packet lines)
  - Row 8: DMZ median (safe row)
  - Rows 9–13: SIP TRUNK LANES asphalt (5 rows, dashed yellow separators)
  - Row 14: CUSTOMER LAN (frog start, bright green)
  - Row 15: bottom HUD (engine draws TIME label and life icons here)
- `scripts/score.js` — current scoring uses `localStorage` key `tangohop-highscore`. This **will be replaced** by an API call to the leaderboard server (see below).

## Leaderboard server (in progress — separate Claude session)

A different Claude window is provisioning the backend right now on **AWS EC2 t3.micro in us-east-2** (Ubuntu 22.04). Stack:

- Node 20 LTS, Express, better-sqlite3, express-rate-limit, helmet
- Caddy v2 for HTTPS + reverse proxy + static file serving
- systemd unit, nightly DB backup cron
- SQLite DB at `/var/lib/tangohop/scores.db`

**Endpoints being built:**
- `POST /api/score` — HMAC-signed submission. Body: `{ name, email?, score, durationMs, nonce, signature }`. Server validates signature, sanity-checks score against duration, rejects replayed nonces, rate-limits 1/IP/10s.
- `GET /api/leaderboard` — top 10 JSON
- `GET /api/leaderboard/sse` — Server-Sent Events; pushes new top10 when it changes
- `GET /leaderboard` — full-screen-friendly HTML page (dark background, FreePBX green `#80c343`) for booth monitor

**CORS allowlist** (env var `TANGOHOP_CORS_ORIGINS`, comma-separated):
```
https://mwtcmi.github.io,https://tangohop.freepbxapps.com,http://localhost:8765,http://localhost:8080,http://127.0.0.1:8765
```

**Pending from that session:**
- Public URL / IP
- HMAC secret (hex, paste into `TANGOHOP_SECRET` in client)
- Sample working `curl` command

## What's next when the server reports back

1. **Client integration** (the next code change):
   - Patch `scripts/score.js`: replace `localStorage` calls with `fetch('https://<host>/api/score', ...)`.
   - On `scoreHook.win()`, compute HMAC-SHA256(`${name}|${score}|${durationMs}|${nonce}`, SECRET) in the client. Send with the POST.
   - Add a name-prompt modal that appears on a new high score (1–24 chars, alnum + `_-`).
   - Keep `localStorage` as a fallback display while the API is unreachable, but the *source of truth* for the contest is the server.
   - Surface server-side rank/top10 in the HUD.
2. **GitHub Pages**: confirm Pages is enabled on the `tangohop` repo (Settings → Pages → deploy from `master` branch root). The renamed-from-`tangodefrogger` redirect should still work but check that the new URL serves.
3. **DNS for `tangohop.freepbxapps.com`**: point an A record at the EC2 elastic IP. Caddy will then auto-issue a Let's Encrypt cert. (User owns the domain; the other Claude session has the IP.)
4. **Booth leaderboard screen**: open `https://<server>/leaderboard` full-screen on a monitor — SSE will push live updates.

## Decisions still open

- **Score formula tuning.** Server rejects `score > durationMs / 50` as a sanity check. We picked 50 ms/point as a placeholder. After playtesting, tune this against actual gameplay rates.
- **Email capture.** Currently optional in the submission. Need to decide whether to require it for swag eligibility (probably yes for prize fulfillment).
- **Anti-cheat hardening.** HMAC + nonce + rate-limit is "raises the bar past URL editing." Not bulletproof. For a one-day giveaway, fine — for a longer-running thing, consider server-side replay validation (game sends a move-log, server replays).
- **Local directory rename.** `~/code/tangodefrogger` → `~/code/tangohop` is a nice-to-have, not required.

## Things to NOT touch

- The `Frogger` JS namespace in `scripts/main.js` (internal, untouched on purpose).
- `images/gameboard.gif` and `images/spritemap.png` — original engine assets, still used.
- `/var/www/tangohop/` on the server — that's where the game files will deploy; the API server should leave it alone.

## Useful commands

```bash
# Run game locally
cd /Users/michael/code/tangodefrogger
python3 -m http.server 8765

# Check the deployed Pages site
open https://mwtcmi.github.io/tangohop/

# Git remote (already updated by gh repo rename)
git remote -v
# origin  https://github.com/mwtcmi/tangohop.git
```

## TL;DR for the receiving Claude

1. Game is rebranded, themed, and pushed to `mwtcmi/tangohop`.
2. A backend is being built right now in a separate session on EC2.
3. When that session hands over the URL + `TANGOHOP_SECRET`, the next step is patching `scripts/score.js` to POST signed scores instead of writing to `localStorage`.
4. Use `TANGOHOP_*` everywhere; do not introduce "Frogger" or "Frogman" into user-facing strings.
