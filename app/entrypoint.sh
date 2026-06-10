#!/bin/bash
# NOTE: ensure this file is executable before building the image:
#   chmod +x app/entrypoint.sh

set -e

# Graceful shutdown: forward SIGTERM to both child processes
_term() {
    echo "Caught SIGTERM, shutting down..."
    kill -TERM "$UVICORN_PID" 2>/dev/null || true
    kill -TERM "$NGINX_PID" 2>/dev/null || true
    wait "$UVICORN_PID" "$NGINX_PID" 2>/dev/null
    exit 0
}
trap _term SIGTERM SIGINT

# Start FastAPI via uvicorn in the background (internal only, not exposed)
uvicorn backend.main:app --host 127.0.0.1 --port 8000 &
UVICORN_PID=$!
echo "uvicorn started (pid $UVICORN_PID)"

# Start nginx in the foreground so the container stays alive
nginx -g 'daemon off;' &
NGINX_PID=$!
echo "nginx started (pid $NGINX_PID)"

# Wait for both processes; exit if either dies
wait -n 2>/dev/null || wait
