#!/usr/bin/with-contenv bashio

# Read config
export HA_URL=$(bashio::config 'ha_url')
export SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"
export DATA_DIR="/data"

bashio::log.info "Starting Grilling Improved..."
bashio::log.info "HA URL: ${HA_URL}"

cd /app
python3 -m uvicorn main:app --host 0.0.0.0 --port 8099 --log-level info
