#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="${1:-$SCRIPT_DIR/lambda-edge-router.zip}"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

cp "$SCRIPT_DIR/index.mjs" "$BUILD_DIR/index.mjs"
cp "$SCRIPT_DIR/package.json" "$BUILD_DIR/package.json"
npm install --prefix "$BUILD_DIR" --omit=dev --ignore-scripts --no-audit --no-fund
rm "$BUILD_DIR/package.json"
(
  cd "$BUILD_DIR"
  zip -qr "$OUTPUT" index.mjs node_modules
)
printf 'Created %s\n' "$OUTPUT"
