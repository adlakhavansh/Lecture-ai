#!/usr/bin/env bash
# Convenience wrapper. There is exactly one build path — `npm run build`
# (vite build + assemble.mjs). assemble.mjs is the single source of truth for
# the dist manifest; this script used to write its own copy and drifted out of
# sync, which silently dropped the sidePanel permission. Don't reintroduce that.
set -e
cd "$(dirname "$0")"

npm run build

echo
echo "Done. Load extension/dist/ at chrome://extensions (Developer mode → Load unpacked)."
echo "Remember to start the server too:  cd ../server && npm run dev"
