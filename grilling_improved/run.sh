#!/usr/bin/with-contenv bashio

export DATA_DIR="/data"

bashio::log.info "Starting Grilling Improved..."

cd /app
exec python3 -m uvicorn main:app --host 0.0.0.0 --port 8099 --log-level info
