# tangohop server

Leaderboard API + booth display for the Tangohop / Frogman swag-giveaway promo.

## Live

- `https://tangohop.freepbxapps.com` — production
- Hosted on AWS EC2 t3.micro (us-east-2), Ubuntu 22.04, Elastic IP
- Caddy v2 (auto-HTTPS via Let's Encrypt), Node 20, SQLite, systemd

## Endpoints

- `POST /api/score` — HMAC-signed submission (see signing below)
- `GET  /api/leaderboard` — top 10 JSON
- `GET  /api/leaderboard/sse` — Server-Sent Events; pushes new top10 on every accepted score
- `GET  /leaderboard` — self-contained booth display, dark + FreePBX green (#80c343), auto-updates via SSE
- `GET  /health` — `{"ok":true}`

Static files for `/var/www/frogman/*` (the game client) are served by Caddy directly. Path `/` falls through to the static `index.html` deployed there.

## Signing

```
signature = HMAC-SHA256(secretBytes, `${name}|${score}|${durationMs}|${nonce}`)  → lowercase hex
```

The key is the **hex-decoded bytes** of `TANGOHOP_SECRET` (32 bytes), not the hex string. The browser client uses Web Crypto `importKey("raw", hexDecodedBytes, …)`. The server uses `Buffer.from(SECRET_HEX, "hex")`. **They must match — passing the hex string as the key produces different signatures and submissions will be rejected.**

Constraints enforced server-side:
- `name`: 1–24 chars, `/^[A-Za-z0-9_-]+$/`
- `email`: optional, ≤120 chars
- `score`: integer, 0..1,000,000
- `durationMs`: integer, 1,000..7,200,000
- `nonce`: 8–64 chars (client sends 32 hex). Deduped for 24h.
- `score ≤ durationMs / 50` (1 point per 50ms is the plausibility ceiling)
- Rate-limit: 1 submission / IP / 10s

## Layout on the server

| Path                              | Purpose                                |
|-----------------------------------|----------------------------------------|
| `/opt/frogman/api/`               | Node app                               |
| `/var/lib/frogman/scores.db`      | SQLite (WAL)                           |
| `/etc/frogman/env`                | Secrets (0640 root:frogman)            |
| `/etc/caddy/Caddyfile`            | Caddy config                           |
| `/var/www/frogman/`               | Static game files (deployed separately)|
| `/var/backups/frogman/`           | Nightly SQLite snapshots, 14d retention|

> Note: paths and the service name still use the original "frogman" naming on the running box (deployed before the rename to tangohop). Renaming is a future cleanup; the externally-facing URL and env vars are already `tangohop`.

## Initial deploy on a fresh Ubuntu 22.04 box

```bash
# from your laptop
scp -r server/ ubuntu@<HOST>:/tmp/frogman-stage/
ssh ubuntu@<HOST> 'sudo bash /tmp/frogman-stage/setup.sh'
# secret is printed at the end — copy it into the client's window.TANGOHOP_CONFIG
```

`setup.sh` is idempotent: re-running it upgrades the app code in place without regenerating the secret or wiping the DB.

## Updating the running service

```bash
scp server/server.js frogman:/tmp/server.js
ssh frogman 'sudo install -o frogman -g frogman -m 0644 /tmp/server.js /opt/frogman/api/server.js && sudo systemctl restart frogman-api'
```

## Local curl smoke test

```bash
SECRET=$(ssh frogman 'sudo grep ^TANGOHOP_SECRET /etc/frogman/env | cut -d= -f2')
NONCE=$(openssl rand -hex 16)
NAME=Tango; SCORE=2400; DUR=180000
SIG=$(printf '%s|%s|%s|%s' "$NAME" "$SCORE" "$DUR" "$NONCE" \
  | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$SECRET" | awk '{print $NF}')
curl -X POST https://tangohop.freepbxapps.com/api/score \
  -H "Content-Type: application/json" \
  -H "Origin: https://mwtcmi.github.io" \
  -d "{\"name\":\"$NAME\",\"score\":$SCORE,\"durationMs\":$DUR,\"nonce\":\"$NONCE\",\"signature\":\"$SIG\"}"
```

The `Origin` header is required for CORS-protected requests (only the origins in `TANGOHOP_CORS_ORIGINS` are accepted).

## Stopping to save cost

```bash
aws ec2 stop-instances --profile terraform-admin --region us-east-2 --instance-ids i-057df6b0cc5bb6de5
```

The Elastic IP keeps billing while detached, so leave it attached even when the instance is stopped.
