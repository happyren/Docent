#!/usr/bin/env bash
# Pull-based continuous deployment for a self-hosted Docent box.
#
# Run periodically (cron — see install-cd.sh). Deploys origin/<branch> when
# it advances, gated on CI: a commit with failing checks is skipped, a
# commit with running checks is retried next tick. Resets hard to origin,
# so it also survives history rewrites. LAN boxes can't receive pushes from
# cloud CI — they pull.
set -euo pipefail

REPO_DIR="${DOCENT_DIR:-$HOME/docent}"
BRANCH="${DOCENT_BRANCH:-master}"
REPO_SLUG="${DOCENT_REPO:-happyren/Docent}"

cd "$REPO_DIR"
STATE_FILE="$REPO_DIR/.deployed-sha"
git fetch --quiet origin "$BRANCH"
REMOTE=$(git rev-parse "origin/$BRANCH")
DEPLOYED=$(cat "$STATE_FILE" 2>/dev/null || echo "none")
# Compare against the last SUCCESSFUL deploy, not just git state — a deploy
# that failed after the reset must retry on the next tick.
[ "$DEPLOYED" = "$REMOTE" ] && exit 0

# CI gate (public repo, unauthenticated API; on API failure, deploy anyway —
# availability beats strictness on a test box).
CHECKS=$(curl -sf --max-time 10 \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO_SLUG/commits/$REMOTE/check-runs" || echo "")
if [ -n "$CHECKS" ]; then
  if printf '%s' "$CHECKS" | grep -q '"conclusion": *"failure"'; then
    echo "$(date -Is) skip $REMOTE: CI failing"
    exit 0
  fi
  if printf '%s' "$CHECKS" | grep -q '"status": *"\(in_progress\|queued\)"'; then
    echo "$(date -Is) wait $REMOTE: CI still running"
    exit 0
  fi
fi

echo "$(date -Is) deploying ${DEPLOYED:0:8} -> ${REMOTE:0:8}"
git reset --hard --quiet "origin/$BRANCH"
docker compose up -d --build 2>&1 | tail -2
echo "$REMOTE" > "$STATE_FILE"
docker image prune -f >/dev/null 2>&1 || true
echo "$(date -Is) deployed $(git rev-parse --short HEAD)"
