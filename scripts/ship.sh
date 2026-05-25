#!/usr/bin/env bash
# Pack publishable Loki packages, copy tarballs into chidori-new/vendor/loki/,
# commit, and push chidori-new. Invoked by the pre-push hook when pushing
# Loki to main, or runnable manually as `pnpm ship`.
set -euo pipefail

LOKI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHIDORI="${CHIDORI_NEW_PATH:-${LOKI_ROOT}/../chidori/chidori-new}"
VENDOR="$CHIDORI/vendor/loki"

# What gets shipped to chidori-new. adapter-mocked is tests-only and
# bench is private.
SHIP_TARBALLS=(loki-core loki-client loki-adapter-sdk loki-cli)

if [[ ! -d "$CHIDORI" ]]; then
  echo "ERROR: chidori-new not found at $CHIDORI" >&2
  exit 1
fi

cd "$LOKI_ROOT"

# Warn (don't block) if working tree is dirty — tarballs will reflect
# whatever's on disk, not just committed code.
if ! git diff --quiet || ! git diff --staged --quiet; then
  echo "WARNING: Loki working tree is dirty — packed tarballs include uncommitted edits." >&2
fi

echo "==> Building + packing Loki"
pnpm pack:all >/dev/null

mkdir -p "$VENDOR"
echo "==> Copying tarballs to $VENDOR"
# Clear stale loki tarballs first so version bumps don't leave duplicates.
rm -f "$VENDOR"/loki-*.tgz
for stem in "${SHIP_TARBALLS[@]}"; do
  cp "$LOKI_ROOT"/dist-tarballs/${stem}-*.tgz "$VENDOR/"
done

cd "$CHIDORI"

if git diff --quiet -- vendor/loki && git diff --staged --quiet -- vendor/loki; then
  # Check untracked files in vendor/loki too.
  if [[ -z "$(git ls-files --others --exclude-standard vendor/loki)" ]]; then
    echo "==> No tarball changes in chidori-new — nothing to commit"
    exit 0
  fi
fi

LOKI_SHA="$(git -C "$LOKI_ROOT" rev-parse --short HEAD)"
LOKI_BRANCH="$(git -C "$LOKI_ROOT" rev-parse --abbrev-ref HEAD)"

echo "==> Committing in chidori-new"
git add vendor/loki
git commit -m "chore(loki): sync vendor tarballs from loki@${LOKI_SHA} (${LOKI_BRANCH})"

CHIDORI_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "==> Pushing chidori-new (${CHIDORI_BRANCH})"
git push origin "$CHIDORI_BRANCH"

echo
echo "Synced. Continuing with original loki push."
