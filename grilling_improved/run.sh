#!/usr/bin/with-contenv bashio

export DATA_DIR="/data"
export HA_URL="http://supervisor/core"

bashio::log.info "Starting Grilling Improved..."
bashio::log.info "HA URL: ${HA_URL}"
bashio::log.info "SUPERVISOR_TOKEN length: ${#SUPERVISOR_TOKEN}"

cd /app
exec python3 -m uvicorn main:app --host 0.0.0.0 --port 8099 --log-level info
