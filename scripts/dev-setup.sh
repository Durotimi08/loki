#!/usr/bin/env bash
# Full cold-start dev setup. Idempotent — safe to re-run.
#
# 1. Build + pack Loki packages
# 2. Copy tarballs into chidori-new/vendor/loki/
# 3. Install them as file: deps in chidori-new (first run only)
# 4. npm link Loki packages live into chidori-new so edits flow through
set -euo pipefail

LOKI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHIDORI="${CHIDORI_NEW_PATH:-${LOKI_ROOT}/../chidori/chidori-new}"
VENDOR="$CHIDORI/vendor/loki"

# Packages exposed to chidori-new. adapter-mocked + bench stay loki-internal.
LINK_PACKAGES=(core client adapter-sdk)
SHIP_STEMS=(loki-core loki-client loki-adapter-sdk loki-cli)

if [[ ! -d "$CHIDORI" ]]; then
  echo "ERROR: chidori-new not found at $CHIDORI" >&2
  echo "       set CHIDORI_NEW_PATH if it lives elsewhere" >&2
  exit 1
fi

cd "$LOKI_ROOT"

echo "==> Step 1/4  Building + packing Loki"
pnpm pack:all >/dev/null

echo "==> Step 2/4  Vendoring tarballs into chidori-new"
mkdir -p "$VENDOR"
rm -f "$VENDOR"/loki-*.tgz
for stem in "${SHIP_STEMS[@]}"; do
  cp "$LOKI_ROOT"/dist-tarballs/${stem}-*.tgz "$VENDOR/"
done

echo "==> Step 3/4  Refreshing @loki/* file: deps + lockfile integrity"
cd "$CHIDORI"
# Always re-install the file: tarballs (even when already in package.json)
# so npm re-resolves their sha512 and writes the new integrity into
# package-lock.json. Without this, Step 2 silently overwrites the
# tarballs but the lock keeps the old hash — `npm link` in Step 4 hides
# the drift locally (symlinks, not file: deps), and the next Docker
# build fails with EINTEGRITY.
#
# `--package-lock-only --ignore-scripts` keeps node_modules untouched so
# any active npm-link symlinks (set up by a previous run of Step 4)
# survive across reruns.
ARGS=()
for pkg in "${LINK_PACKAGES[@]}"; do
  TARBALL=$(ls "$VENDOR"/loki-${pkg}-*.tgz | head -1)
  REL="vendor/loki/$(basename "$TARBALL")"
  ARGS+=("file:$REL")
done
echo "    refreshing: ${ARGS[*]}"
npm install "${ARGS[@]}" --package-lock-only --ignore-scripts

echo "==> Step 4/4  Linking live Loki packages into chidori-new"
cd "$LOKI_ROOT"
for pkg in "${LINK_PACKAGES[@]}"; do
  (cd "packages/$pkg" && npm link >/dev/null)
done
cd "$CHIDORI"
NAMES=()
for pkg in "${LINK_PACKAGES[@]}"; do NAMES+=("@loki/$pkg"); done
npm link "${NAMES[@]}"

echo
echo "Setup complete."
echo "  - chidori-new now imports live from loki via npm link"
echo "  - vendored tarballs in $VENDOR are the prod-install fallback"
echo "  - run 'pnpm dev:watch' in loki to rebuild on save"
