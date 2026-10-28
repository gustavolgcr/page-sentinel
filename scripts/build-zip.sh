#!/bin/sh
# Builds the .zip to upload to the Chrome Web Store, in dist/.
set -e
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="dist/page-sentinel-$VERSION.zip"
mkdir -p dist
rm -f "$OUT"
zip -q -r -X "$OUT" manifest.json background.js frame-reader.js offscreen.html offscreen.js \
  popup.html popup.css popup.js icons fonts -x '*.DS_Store'
echo "Package created: $OUT"
