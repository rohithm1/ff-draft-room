#!/usr/bin/env bash
# Launch the draft assistant. Serves over HTTP (not file://) so that saving
# your draft to browser storage works reliably.
set -e
PORT=8777
DIR="$(cd "$(dirname "$0")" && pwd)"
URL="http://127.0.0.1:$PORT/index.html"

if curl -s -o /dev/null -m 1 "$URL"; then
  echo "Already serving on $PORT."
else
  python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR" >/dev/null 2>&1 &
  echo "Serving $DIR on port $PORT (pid $!)"
  sleep 1
fi

echo "Opening $URL"
open "$URL" 2>/dev/null || echo "Open it manually: $URL"
