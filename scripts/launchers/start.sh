#!/bin/sh
# Ruffle3D offline launcher for macOS and Linux: serves the app folder on http://localhost and opens your browser.
# Press Ctrl+C (or close the terminal) to quit.
cd "$(dirname "$0")/app" || exit 1
PORT=47830
URL="http://localhost:$PORT/"
open_browser() { sleep 1; if command -v open >/dev/null 2>&1; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1; fi; }
echo ""
echo "  Ruffle3D is running at $URL"
echo "  Press Ctrl+C to quit."
echo ""
if command -v node >/dev/null 2>&1; then
  open_browser &
  exec node ../serve.mjs . "$PORT"
elif command -v python3 >/dev/null 2>&1; then
  open_browser &
  exec python3 -m http.server "$PORT" --bind 127.0.0.1
else
  echo "Ruffle3D's offline launcher needs Node.js or Python 3."
  echo "Install either one, or use Ruffle3D in your browser from the website and choose 'Install app'."
  read -r _
fi
