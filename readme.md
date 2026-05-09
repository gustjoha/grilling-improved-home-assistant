# Grilling Improved — Home Assistant Addon

A feature-rich BBQ temperature monitoring addon for Home Assistant with live charts, full cook history, ambient temperature tracking, and probe power management.

## Features

- **Live temperature charts** — real-time Chart.js graphs fed via WebSocket
- **Cook history** — full SQLite log of every temperature reading for every cook
- **Ambient temperature** — configurable ambient sensor per probe, tracked alongside internal temp
- **Probe enable switch** — optional toggle to power your probe (e.g. Inkbird enable switch)
- **35 meat presets** — beef doneness, poultry, fish, smoking temps
- **Auto-end cook** — configurable automatic session end after target temp is reached
- **Multiple probes** — add as many probes as you like, each fully configurable
- **HA Ingress** — works on desktop and mobile app with no token setup required

## Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**
2. Click the ⋮ menu → **Repositories** → add:
   ```
   https://github.com/gustjoha/grilling-improved-home-assistant
   ```
3. Find **Grilling Improved** in the store and click **Install**
4. Start the addon and open the **Grilling** panel in your sidebar

## Probe Setup

When adding a probe you configure:

1. **Internal temperature sensor** — the entity reporting probe temperature (e.g. `sensor.terrace_inkbird_internal`)
2. **Ambient temperature sensor** — optional outdoor/grill ambient temp (e.g. `sensor.terrace_inkbird_ambient`)
3. **Enable switch** — optional switch to power your probe device (e.g. `switch.terrace_enable_inkbird_int_11p_b`)
4. **Goal type** — at target, range, above/below threshold
5. **Target temperature + preset** — choose from 35 presets or set manually

## Starting a Cook

Click **Start Cook** on any probe card to begin a session. Each cook session:

- Records every temperature reading with timestamp
- Tracks peak and minimum temperatures
- Tracks ambient start/end temperatures
- Detects goal reached and triggers auto-end timer
- Can be manually ended at any time

## Cook History

The **Cook History** tab shows all past cook sessions with:
- Full temperature chart (probe + ambient + target line)
- Peak temp, duration, ambient start/end
- Goal reached timestamp
- Expandable per-session detail

## Data Storage

All data is stored in SQLite at `/data/grilling.db` inside the addon. This persists across addon restarts and HA reboots.

## Architecture

- **FastAPI** backend (Python 3.12)
- **SQLite** via aiosqlite
- **WebSocket** to HA for real-time state streaming
- **Chart.js** for live and history charts
- **HA Ingress** for seamless authentication
