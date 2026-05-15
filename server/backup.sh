#!/usr/bin/env bash
set -euo pipefail
DEST=/var/backups/frogman
DB=/var/lib/frogman/scores.db
mkdir -p "$DEST"
DATE=$(date +%F)
sqlite3 "$DB" ".backup '$DEST/scores-$DATE.db'"
chmod 0640 "$DEST/scores-$DATE.db"
find "$DEST" -name 'scores-*.db' -mtime +14 -delete
