#!/usr/bin/env bash
# One-time setup on a deploy box: registers a cron entry that runs
# self-deploy.sh every 2 minutes, then performs the initial deploy.
#
#   git clone https://github.com/happyren/Docent.git ~/docent
#   ~/docent/scripts/install-cd.sh
set -euo pipefail

REPO_DIR="${DOCENT_DIR:-$HOME/docent}"
LOG="$HOME/docent-deploy.log"

CRON_LINE="*/2 * * * * DOCENT_DIR=$REPO_DIR $REPO_DIR/scripts/self-deploy.sh >> $LOG 2>&1"
( crontab -l 2>/dev/null | grep -v "self-deploy.sh" || true; echo "$CRON_LINE" ) | crontab -
echo "CD installed — $(crontab -l | grep -c self-deploy.sh) cron entry, log: $LOG"

echo "Initial deploy…"
cd "$REPO_DIR"
docker compose up -d --build 2>&1 | tail -2
echo "Done: $(git rev-parse --short HEAD) serving on port 3000"
