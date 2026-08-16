#!/usr/bin/env bash
# Update a running AutoSub host from origin/main.
#
# The one failure this exists to prevent: editing source directly on the host.
# A dirty tree makes `git pull` refuse silently, so the files keep drifting
# while git metadata stays pinned to an old commit, and nobody notices until
# the checkout and the running image disagree about what is deployed.
set -euo pipefail

cd "$(dirname "$0")/.."

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    sudo docker compose "$@"
  fi
}

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "Refusing to deploy: the working tree has local changes." >&2
  echo "Commit them upstream and pull, or run 'git stash --include-untracked' first." >&2
  git status --short >&2
  exit 1
fi

before="$(git rev-parse HEAD)"
git fetch origin main
git merge --ff-only origin/main
after="$(git rev-parse HEAD)"

if [ "$before" = "$after" ]; then
  echo "Already at $after; rebuilding anyway to pick up base-image updates."
else
  echo "Updating $before -> $after"
  git --no-pager log --oneline "$before..$after"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$(pwd)/../autosub-backups/$stamp"
sudo install -d -m 700 "$backup"
[ ! -f .env ] || sudo cp -p .env "$backup/.env"
[ ! -d data ] || sudo tar -C . -czf "$backup/data.tar.gz" data
echo "Backed up .env and data to $backup"

compose build --pull
compose up -d --remove-orphans

for _ in $(seq 1 30); do
  state="$(compose ps --format '{{.Health}}' autosub 2>/dev/null | head -1)"
  [ "$state" = "healthy" ] && break
  sleep 2
done

if [ "${state:-}" != "healthy" ]; then
  echo "Container did not report healthy; showing recent logs." >&2
  compose logs --tail=60 autosub >&2
  exit 1
fi

echo "Deployed $(git rev-parse --short HEAD), container healthy."
