#!/bin/bash
# ContextForge DB backup — daily, single-file, with N-day rotation.
#
# Backs up ~/.contextforge/contextforge.db to a backup directory of your choice
# (e.g. a synced cloud folder). Designed to run unattended from a scheduler
# (macOS launchd, Linux cron/systemd, Windows Task Scheduler via WSL/Git-Bash).
#
# HOW IT WORKS
#   1. Runs a SQLite *online* backup to a LOCAL staging file (safe even while the
#      MCP server has the DB open; also avoids running SQLite I/O directly over a
#      cloud-sync filesystem, which background jobs are often blocked from doing).
#   2. Verifies the staged copy with PRAGMA integrity_check.
#   3. Copies the finished file into your backup dir as a NEW dated file
#      (contextforge-YYYY-MM-DD.db). It never OVERWRITES an existing file —
#      some cloud providers block background processes from replacing synced files.
#   4. Deletes dated backups older than KEEP_DAYS.
#
# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURE ME:  Set your backup location. Two options —
#   (a) Set the CONTEXTFORGE_BACKUP_DIR environment variable, OR
#   (b) Edit the default path on the DEST_DIR line below.
#
# Examples for DEST_DIR (replace with YOUR actual location):
#   macOS + OneDrive : "$HOME/Library/CloudStorage/OneDrive-<YourOrg>/Documents/contextforge-backups"
#   macOS + iCloud   : "$HOME/Library/Mobile Documents/com~apple~CloudDocs/contextforge-backups"
#   Dropbox          : "$HOME/Dropbox/contextforge-backups"
#   Local only       : "$HOME/.contextforge/backups"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Source DB (override with CONTEXTFORGE_DB if you use a custom path).
DB="${CONTEXTFORGE_DB:-$HOME/.contextforge/contextforge.db}"

# >>> EDIT THIS <<<  Backup destination. Env var wins; otherwise this default.
DEST_DIR="${CONTEXTFORGE_BACKUP_DIR:-$HOME/.contextforge/backups}"

# How many days of dated backups to keep.
KEEP_DAYS="${CONTEXTFORGE_BACKUP_KEEP_DAYS:-7}"

# Local staging dir (never a cloud folder — used for the SQLite backup + logs).
STAGE="$HOME/.contextforge/backups"
STAMP="$(date +%Y-%m-%d)"
TMP="$STAGE/.staging-$STAMP.db"
DEST="$DEST_DIR/contextforge-$STAMP.db"
LOG="$STAGE/backup.log"

mkdir -p "$STAGE" "$DEST_DIR"

if [ ! -f "$DB" ]; then
  echo "$(date '+%F %T') ERROR: DB not found at $DB" >> "$LOG"; exit 1
fi

# Already have today's backup? Do nothing (avoids any overwrite).
if [ -f "$DEST" ]; then
  echo "$(date '+%F %T') SKIP -> today's backup already exists: $DEST" >> "$LOG"; exit 0
fi

# 1) Online, consistent backup to LOCAL staging file.
rm -f "$TMP" "$TMP-wal" "$TMP-shm"
python3 - "$DB" "$TMP" <<'PY'
import sqlite3, sys
src, dest = sys.argv[1], sys.argv[2]
s = sqlite3.connect(src); d = sqlite3.connect(dest)
with d:
    s.backup(d)
d.execute("PRAGMA journal_mode=DELETE")   # single-file, no -wal/-shm sidecars
d.close(); s.close()
PY

# 2) Integrity check on the staged backup.
INTEG="$(python3 -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('PRAGMA integrity_check').fetchone()[0])" "$TMP")"
if [ "$INTEG" != "ok" ]; then
  echo "$(date '+%F %T') ERROR: integrity_check=$INTEG (aborting)" >> "$LOG"
  rm -f "$TMP" "$TMP-wal" "$TMP-shm"; exit 1
fi

# 3) Copy the finished file into the backup dir as a NEW dated file.
cp "$TMP" "$DEST"
rm -f "$TMP" "$TMP-wal" "$TMP-shm"

# 4) Rotation: remove dated backups older than KEEP_DAYS.
find "$DEST_DIR" -name 'contextforge-20*.db' -type f -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true

SIZE="$(du -h "$DEST" | cut -f1)"
echo "$(date '+%F %T') OK  -> $DEST  size=$SIZE  integrity=$INTEG" >> "$LOG"
