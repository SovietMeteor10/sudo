#!/usr/bin/env bash
# Take a timestamped backup of the sudo SQLite database.
# Reads SUDO_DB_PATH and SUDO_DATA_DIR from the environment, falling
# back to ./data/sudo.sqlite and ./data when unset. Backups are written
# to <SUDO_DATA_DIR>/backups and never overwrite an existing file.
set -euo pipefail

DATA_DIR="${SUDO_DATA_DIR:-./data}"
DB_PATH="${SUDO_DB_PATH:-${DATA_DIR}/sudo.sqlite}"
BACKUP_DIR="${DATA_DIR}/backups"

if [ ! -f "$DB_PATH" ]; then
  echo "no database found at ${DB_PATH}" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="${BACKUP_DIR}/sudo-${stamp}.sqlite"

if [ -e "$target" ]; then
  echo "backup already exists: ${target}" >&2
  exit 1
fi

if command -v sqlite3 >/dev/null 2>&1; then
  echo "using sqlite3 .backup -> ${target}"
  sqlite3 "$DB_PATH" ".backup '${target}'"
else
  echo "WARNING: sqlite3 CLI not found. Falling back to a plain file copy." >&2
  echo "         Stop the sudo service before running, or the copy may be inconsistent." >&2
  cp "$DB_PATH" "$target"
fi

echo "backup written: ${target}"
