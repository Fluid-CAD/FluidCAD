#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$SCRIPT_DIR/.."
ROOT_DIR="$EXT_DIR/../.."

# Convert HTML <img> tags to markdown syntax and strip HTML wrapper tags
sed 's|<img src="\([^"]*\)" alt="\([^"]*\)"[^/]*/> *|![\2](\1)|g
/<p align="center">/d
/<\/p>/d
/<h1 align="center">/d
/<\/h1>/d' "$ROOT_DIR/README.md" > "$EXT_DIR/README.md"
