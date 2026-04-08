#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

echo "Cleaning dist/..."
rm -rf dist
mkdir -p dist/bin dist/lib dist/server dist/ui

echo "Copying lib/dist -> dist/lib (excluding tests)..."
rsync -a \
  --exclude='tests/' \
  --exclude='*.test.js' \
  --exclude='*.test.d.ts' \
  --exclude='tsconfig.tsbuildinfo' \
  lib/dist/ dist/lib/

echo "Copying server/dist -> dist/server..."
cp -r server/dist/* dist/server/

echo "Copying ui/dist -> dist/ui..."
cp -r ui/dist/* dist/ui/

echo "Copying and patching bin/fluidcad.js -> dist/bin/fluidcad.js..."
sed "s|'..', 'server', 'dist', 'index.js'|'..', 'server', 'index.js'|" \
  bin/fluidcad.js > dist/bin/fluidcad.js
chmod +x dist/bin/fluidcad.js

echo "Patching dist/server UI_DIST path..."
sed -i "s|'../../ui/dist'|'../ui'|" dist/server/index.js

echo "Done. dist/ is ready for publishing."
