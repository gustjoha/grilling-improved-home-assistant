'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  probes: [],
  charts: {},
  historyCharts: {},
  analyticsCharts: {},
  historyData: [],
  haEntities: [],
  ws: null,
  wsConnected: false,
  currentTab: 'dashboard',
  editingProbeId: null,
  startCookProbeId: null,
  chartRanges: {},
};

const pendingMilestones = [];

// ── Presets ───────────────────────────────────────────────────────────────────
const PRESETS = {
  "Beef - Blue Rare": 46, "Beef - Rare": 52, "Beef - Medium Rare": 57,
  "Beef - Medium": 63, "Beef - Medium Well": 68, "Beef - Well Done": 74,
  "Beef - Brisket (Smoked)": 96, "Beef - Ribs": 93,
  "Pork - Medium": 63, "Pork - Well Done": 71, "Pork - Pulled Pork": 95,
  "Pork - Ribs (Smoked)": 93, "Pork - Sausage": 71,
  "Chicken - Breast": 74, "Chicken - Whole": 82,
  "Turkey - Breast": 74, "Turkey - Whole": 82,
  "Lamb - Rare": 52, "Lamb - Medium Rare": 57, "Lamb - Medium": 63, "Lamb - Well Done": 74,
  "Fish - Salmon": 52, "Fish - Tuna (Medium Rare)": 46, "Fish - Halibut": 57,
  "Fish - Whole Fish": 63, "Shrimp / Lobster": 63,
  "Venison - Medium Rare": 57, "Venison - Medium": 63,
  "Duck Breast - Medium": 57, "Duck Breast - Well Done": 74,
  "Smoke - Hot Smoke": 66, "Smoke - Low & Slow BBQ": 107, "Smoke - Cold Smoke": 25,
};

const QUICK_PRESETS = [
  ["Beef - Rare", 52], ["Beef - Medium Rare", 57], ["Beef - Medium", 63],
  ["Beef - Well Done", 74], ["Beef - Brisket (Smoked)", 96],
  ["Pork - Pulled Pork", 95], ["Chicken - Breast", 74], ["Fish - Salmon", 52],
];

// ── API ───────────────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}
const GET    = (path)       => api(path);
const POST   = (path, data) => api(path, { method: 'POST',   body: JSON.stringify(data) });
const PATCH  = (path, data) => api(path, { method: 'PATCH',  body: JSON.stringify(data) });
const DELETE = (path)       => api(path, { method: 'DELETE' });

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsConnected = true;
    document.querySelector('.ws-dot')?.classList.add('connected');
    setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 20000);
  };
  ws.onclose = () => {
    state.wsConnected = false;
    document.querySelector('.ws-dot')?.classList.remove('connected');
    setTimeout(connectWS, 5000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    try { handleWSMessage(JSON.parse(e.data)); } catch (_) {}
  };
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'reading':
      handleLiveReading(msg);
      break;
    case 'session_started':
    case 'session_updated':
      refreshProbes();
      break;
    case 'session_ended':
      refreshProbes();
      if (state.currentTab === 'history') loadHistory();
      showToast('Cook session ended', '#4ade80');
      break;
    case 'stall_started':
      showToast(`⏸ Stall detected at ${msg.temp?.toFixed(1)}°C`, '#fbbf24');
      break;
    case 'stall_ended':
      showToast('✅ Stall resolved — temp climbing again!', '#4ade80');
      break;
    case 'milestone_reached':
      showToast(`🎯 Milestone: ${msg.label} reached!`, '#60a5fa');
      break;
    case 'rest_complete':
      showToast('🍖 Rest complete — time to slice!', '#4ade80');
      refreshProbes();
      break;
  }
}

function handleLiveReading(msg) {
  const { probe_id, temp, ambient, ror, peak_temp, min_temp, goal_reached_at, stall_active } = msg;
  const probe = state.probes.find(p => p.id === probe_id);
  if (probe) {
    probe.current_temp = temp;
    probe.current_ambient = ambient;
    if (probe.active_session) {
      probe.active_session.peak_temp = peak_temp;
      probe.active_session.min_temp = min_temp;
      probe.active_session.goal_reached_at = goal_reached_at;
    }
    const card = document.getElementById(`probe-card-${probe_id}`);
    if (card) card.replaceWith(buildProbeCard(probe));
  }

  const chart = state.charts[probe_id];
  if (chart && temp !== null) {
    const label = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const range = (state.chartRanges[probe_id] || 30) * 60;
    const maxPoints = Math.ceil(range / 10);
    chart.data.labels.push(label);
    chart.data.datasets[0].data.push(temp);
    if (ambient !== null && chart.data.datasets[1]) chart.data.datasets[1].data.push(ambient);
    while (chart.data.labels.length > maxPoints) {
      chart.data.labels.shift();
      chart.data.datasets.forEach(ds => ds.data.shift());
    }
    chart.update('quiet');
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function refreshProbes() {
  try {
    state.probes = await GET('/api/probes');
    renderDashboard();
  } catch (e) { console.error('refreshProbes:', e); }
}

async function loadHistory() {
  const limit = document.getElementById('hist-limit')?.value || 50;
  try {
    state.historyData = await GET(`/api/history?limit=${limit}`);
    renderHistory();
  } catch (e) { console.error('loadHistory:', e); }
}

async function loadHAEntities() {
  try {
    state.haEntities = await GET('/api/ha/entities?domain=sensor,switch,binary_sensor,input_boolean,weather');
  } catch (e) { console.warn('loadHAEntities:', e); }
}

async function loadAnalytics() {
  try {
    const [presetStats, weatherData, personality] = await Promise.all([
      GET('/api/analytics/preset-stats'),
      GET('/api/analytics/weather-correlation'),
      GET('/api/analytics/grill-personality'),
    ]);
    renderPresetStats(presetStats);
    renderWeatherCorrelation(weatherData);
    renderGrillPersonality(personality);
    renderCompareUI();
  } catch (e) { console.error('loadAnalytics:', e); }
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  populatePresetDropdowns();
  connectWS();
  refreshProbes();
  setupNavTabs();
  setupGridDelegation();
  setInterval(refreshProbes, 10000);
});

function populatePresetDropdowns() {
  document.querySelectorAll('.preset-select-global').forEach(sel => {
    Object.entries(PRESETS).forEach(([name, temp]) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = `${name} (${temp}°C)`;
      sel.appendChild(opt);
    });
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────
function setupNavTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.style.display = p.dataset.pane === tab ? '' : 'none');
  if (tab === 'history') loadHistory();
  if (tab === 'analytics') {
    if (!state.historyData.length) loadHistory().then(loadAnalytics);
    else loadAnalytics();
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  renderStats();
  const grid = document.getElementById('probe-grid');

  const existing = new Set([...grid.querySelectorAll('.probe-card')].map(c => c.id.replace('probe-card-', '')));
  const current  = new Set(state.probes.map(p => p.id));

  existing.forEach(id => {
    if (!current.has(id)) {
      document.getElementById(`probe-card-${id}`)?.remove();
      if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
    }
  });

  if (state.probes.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="icon">🔥</div><h2>No Probes Yet</h2>
      <p>Add your first probe to start monitoring your cook.</p>
      <button class="btn-primary" style="max-width:200px;margin:0 auto" onclick="openAddProbeModal()">Add Probe</button>
    </div>`;
    return;
  }

  state.probes.forEach(probe => {
    const card = buildProbeCard(probe);
    const old = document.getElementById(`probe-card-${probe.id}`);
    if (old) old.replaceWith(card);
    else grid.appendChild(card);
    initProbeChart(probe);
  });
}

function renderStats() {
  const active  = state.probes.filter(p => p.active_session).length;
  const reached = state.probes.filter(p => p.active_session?.goal_reached_at).length;
  const temps   = state.probes.map(p => p.current_temp).filter(t => t != null);
  const hottest = temps.length ? Math.max(...temps).toFixed(1) + '°C' : '—';
  document.getElementById('stat-active').textContent  = active  || '—';
  document.getElementById('stat-reached').textContent = reached;
  document.getElementById('stat-stalls').textContent  = '—';
  document.getElementById('stat-hottest').textContent = hottest;
}

// ── Probe card ────────────────────────────────────────────────────────────────
function buildProbeCard(probe) {
  const session    = probe.active_session;
  const temp       = probe.current_temp;
  const ambient    = probe.current_ambient;
  const isOffline  = temp == null;
  const isActive   = !!session;
  const goalReached = !!session?.goal_reached_at;

  let tempClass = 'offline';
  if (!isOffline) {
    if (goalReached)  tempClass = 'done';
    else if (temp < 40)  tempClass = 'cold';
    else if (temp >= 80) tempClass = 'hot';
    else tempClass = 'warm';
  }

  let badgeClass = 'badge-idle', badgeText = '⬜ Idle';
  if (isOffline) { badgeClass = 'badge-offline'; badgeText = '⚫ Offline'; }
  else if (isActive && goalReached) { badgeClass = 'badge-done';    badgeText = '✅ Done'; }
  else if (isActive)                { badgeClass = 'badge-cooking'; badgeText = '🔥 Cooking'; }

  // Progress bar
  let progressHtml = '';
  if (isActive && session.target_temp && !isOffline) {
    const minT = session.min_temp ?? temp;
    const range = session.target_temp - minT;
    const pct = range > 0 ? Math.min(100, Math.max(0, (temp - minT) / range * 100)) : 0;
    progressHtml = `<div class="progress-wrap">
      <div class="progress-labels"><span>Progress</span><span>${pct.toFixed(0)}%</span></div>
      <div class="progress-bg"><div class="progress-fill${goalReached ? ' done' : ''}" style="width:${pct}%"></div></div>
    </div>`;
  }

  // ETA
  let etaHtml = '';
  if (isActive && !goalReached && !isOffline && session.target_temp && temp < session.target_temp) {
    etaHtml = `<div class="eta-bar"><span class="eta-lbl">⏱ ETA to target</span><span class="eta-val">Calculating…</span></div>`;
  }

  // Auto-end
  let autoEndHtml = '';
  if (goalReached && session?.auto_end) {
    autoEndHtml = `<div class="auto-end-bar">⏳ Auto-ending ${session.auto_end_minutes}min after target reached</div>`;
  }

  // Switch toggle
  let switchHtml = '';
  if (probe.enable_switch) {
    const isOn = probe.switch_state === 'on';
    switchHtml = `<div class="switch-row">
      <span>${probe.enable_switch.split('.')[1]}</span>
      <label class="toggle">
        <input type="checkbox" ${isOn ? 'checked' : ''} data-action="switch" data-probe-id="${probe.id}">
        <span class="toggle-slider"></span>
      </label>
    </div>`;
  }

  // Preset picker
  const currentPreset = session?.preset || probe.preset || '';
  const presetPickerHtml = `<div class="preset-picker">
    <div class="preset-picker-label">🥩 Quick Preset
      <span class="all-presets" data-probe-id="${probe.id}">All presets ▾</span>
    </div>
    <div class="preset-chips">${QUICK_PRESETS.map(([name, t]) =>
      `<div class="preset-chip${currentPreset === name ? ' active' : ''}"
           data-probe-id="${probe.id}" data-preset-name="${name}" data-preset-temp="${t}">
        ${name.split(' - ')[1] || name} <span style="opacity:.55">${t}°</span>
      </div>`).join('')}
    </div>
    <select class="preset-select" id="preset-select-${probe.id}" data-probe-id="${probe.id}">
      <option value="">— All presets —</option>
      ${Object.entries(PRESETS).map(([n, t]) =>
        `<option value="${n}|${t}" ${currentPreset === n ? 'selected' : ''}>${n} (${t}°C)</option>`
      ).join('')}
    </select>
  </div>`;

  // Metrics
  const rorVal = probe.last_ror != null ? probe.last_ror.toFixed(2) + '°/m' : '—';
  const metricsHtml = `<div class="metrics">
    <div class="metric"><div class="metric-val">${rorVal}</div><div class="metric-lbl">Rate °/min</div></div>
    <div class="metric"><div class="metric-val">${session?.peak_temp != null ? session.peak_temp.toFixed(1) + '°' : '—'}</div><div class="metric-lbl">Peak</div></div>
    <div class="metric"><div class="metric-val">${session?.min_temp != null ? session.min_temp.toFixed(1) + '°' : '—'}</div><div class="metric-lbl">Min</div></div>
  </div>`;

  // Rest timer section
  let restHtml = '';
  if (session) {
    if (session.rest_ended_at) {
      restHtml = `<div class="rest-done-bar">✅ Resting complete — ready to slice!</div>`;
    } else if (session.rest_started_at) {
      const started = new Date(session.rest_started_at);
      const endAt = new Date(started.getTime() + (session.rest_minutes || 10) * 60000);
      const remaining = Math.max(0, Math.round((endAt - Date.now()) / 60000));
      restHtml = `<div class="rest-timer-bar">
        <span class="rest-timer-label">🌡️ Resting… ${remaining} min left</span>
        <button class="btn-sm" style="flex:none;width:auto;padding:4px 10px"
          data-action="cancel-rest" data-session-id="${session.id}">Cancel</button>
      </div>`;
    } else if (goalReached) {
      restHtml = `<div class="rest-timer-bar">
        <span class="rest-timer-label">Start rest timer?</span>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="number" id="rest-min-${session.id}" value="${session.rest_minutes || 15}"
            min="1" max="120" style="width:50px;background:var(--coal);border:1px solid #3d2e22;
            border-radius:6px;color:var(--pale);padding:3px 6px;font-size:0.78rem;text-align:center">
          <button class="btn-sm" style="flex:none;width:auto;padding:4px 10px"
            data-action="start-rest" data-session-id="${session.id}" data-probe-id="${probe.id}">▶ Start</button>
        </div>
      </div>`;
    }
  }

  // Journal
  let journalHtml = '';
  if (session) {
    journalHtml = `<div class="journal-wrap">
      <div class="journal-label">📝 Cook Journal</div>
      <textarea class="journal-textarea" id="journal-${session.id}"
        placeholder="Notes, what worked, what to try next time…">${session.journal || ''}</textarea>
      <button class="journal-save-btn"
        data-action="save-journal" data-session-id="${session.id}">Save</button>
    </div>`;
  }

  // Cook controls
  const cookControlsHtml = !isActive
    ? `<div class="cook-controls">
        <button class="btn-start-cook" data-action="start-cook" data-probe-id="${probe.id}">🔥 START COOK</button>
       </div>`
    : `<div class="cook-controls">
        <button class="btn-end-cook" data-action="end-cook"
          data-probe-id="${probe.id}" data-session-id="${session.id}">■ END COOK</button>
       </div>`;

  const div = document.createElement('div');
  div.className = `probe-card${goalReached ? ' goal-reached' : ''}`;
  div.id = `probe-card-${probe.id}`;
  div.innerHTML = `
    <div class="probe-header">
      <div>
        <div class="probe-name">${probe.name}</div>
        <div class="probe-entity">${probe.probe_entity}</div>
      </div>
      <span class="badge ${badgeClass}">${badgeText}</span>
    </div>

    <div class="temp-section">
      <div class="temp-primary">
        <div class="temp-big ${tempClass}">${isOffline ? '—' : temp.toFixed(1) + '°'}</div>
        ${session?.preset || probe.preset ? `<div class="preset-lbl">🥩 ${session?.preset || probe.preset}</div>` : ''}
        ${session?.target_temp ? `<div class="target-lbl">Target <strong>${session.target_temp}°C</strong></div>` : ''}
      </div>
      ${ambient != null ? `<div class="temp-ambient">
        <div class="ambient-val">${ambient.toFixed(1)}°</div>
        <div class="ambient-lbl">Ambient</div>
      </div>` : ''}
    </div>

    ${switchHtml}
    ${progressHtml}
    ${metricsHtml}
    ${etaHtml}
    ${autoEndHtml}

    <div class="chart-wrap">
      <div class="chart-header">
        <span class="chart-title">Temperature log</span>
        <div class="chart-range-btns">
          ${[30, 60, 240].map(m =>
            `<button class="chart-range-btn${(state.chartRanges[probe.id] || 30) === m ? ' active' : ''}"
               data-probe-id="${probe.id}" data-range="${m}">${m === 30 ? '30m' : m === 60 ? '1h' : '4h'}</button>`
          ).join('')}
        </div>
      </div>
      <canvas class="chart-canvas" id="chart-${probe.id}"></canvas>
    </div>

    ${presetPickerHtml}
    ${restHtml}
    ${journalHtml}

    <div class="card-actions">
      <button class="btn-sm" data-action="edit-probe" data-probe-id="${probe.id}">✏️ Edit</button>
      <button class="btn-sm danger" data-action="delete-probe" data-probe-id="${probe.id}">🗑 Remove</button>
    </div>

    ${cookControlsHtml}
  `;
  return div;
}

// ── Charts ────────────────────────────────────────────────────────────────────
async function initProbeChart(probe) {
  const canvas = document.getElementById(`chart-${probe.id}`);
  if (!canvas) return;
  if (state.charts[probe.id]) { state.charts[probe.id].destroy(); delete state.charts[probe.id]; }

  const range = state.chartRanges[probe.id] || 30;
  let readings = [];
  if (probe.active_session) {
    try {
      const data = await GET(`/api/history/session/${probe.active_session.id}/readings/recent?minutes=${range}`);
      readings = data.readings || [];
    } catch (_) {}
  }

  const hasAmbient = readings.some(r => r.ambient != null);
  const labels   = readings.map(r => new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const temps    = readings.map(r => r.temp);
  const ambients = readings.map(r => r.ambient);
  const rors     = readings.map(r => r.ror);

  const datasets = [
    { label: 'Probe', data: temps, borderColor: '#FF4D00', backgroundColor: 'rgba(255,77,0,0.08)',
      borderWidth: 2, pointRadius: 0, tension: 0.4, fill: true, yAxisID: 'y' },
  ];
  if (hasAmbient) datasets.push(
    { label: 'Ambient', data: ambients, borderColor: '#60a5fa', borderWidth: 1.5,
      pointRadius: 0, tension: 0.4, fill: false, borderDash: [4, 3], yAxisID: 'y' }
  );
  if (probe.active_session?.target_temp) datasets.push(
    { label: 'Target', data: Array(labels.length).fill(probe.active_session.target_temp),
      borderColor: '#4ade80', borderWidth: 1, pointRadius: 0, borderDash: [6, 4],
      fill: false, yAxisID: 'y' }
  );
  if (readings.some(r => r.ror != null)) datasets.push(
    { label: '°/min', data: rors, borderColor: '#fbbf24', borderWidth: 1,
      pointRadius: 0, tension: 0.4, fill: false, yAxisID: 'y2' }
  );

  const CHART_OPTS = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: {
      legend: { display: hasAmbient || readings.some(r => r.ror != null),
                labels: { color: '#9c8a7a', font: { size: 9 }, boxWidth: 10 } },
      tooltip: { backgroundColor: '#2d2520', titleColor: '#9c8a7a',
                 bodyColor: '#f5ede4', borderColor: '#3d2e22', borderWidth: 1 },
    },
    scales: {
      x: { ticks: { color: '#9c8a7a', font: { size: 9 }, maxTicksLimit: 6 }, grid: { color: '#3d2e22' } },
      y: { ticks: { color: '#9c8a7a', font: { size: 9 }, callback: v => v + '°' }, grid: { color: '#3d2e22' } },
      y2: { display: readings.some(r => r.ror != null), position: 'right',
            ticks: { color: '#fbbf24', font: { size: 8 }, callback: v => v + '/m' },
            grid: { drawOnChartArea: false } },
    },
  };

  state.charts[probe.id] = new Chart(canvas, { type: 'line', data: { labels, datasets }, options: CHART_OPTS });
}

async function changeChartRange(probeId, minutes) {
  state.chartRanges[probeId] = minutes;
  const probe = state.probes.find(p => p.id === probeId);
  if (probe) await initProbeChart(probe);
  document.querySelectorAll(`.chart-range-btn[data-probe-id="${probeId}"]`).forEach(btn =>
    btn.classList.toggle('active', parseInt(btn.dataset.range) === minutes));
}

// ── Event delegation ──────────────────────────────────────────────────────────
function setupGridDelegation() {
  const grid = document.getElementById('probe-grid');
  if (!grid) return;

  grid.addEventListener('click', async (e) => {
    const target = e.target;

    const rangeBtn = target.closest('.chart-range-btn');
    if (rangeBtn) { await changeChartRange(rangeBtn.dataset.probeId, parseInt(rangeBtn.dataset.range)); return; }

    const allPresets = target.closest('.all-presets');
    if (allPresets) {
      document.getElementById(`preset-select-${allPresets.dataset.probeId}`)?.classList.toggle('open');
      return;
    }

    const chip = target.closest('.preset-chip');
    if (chip) { await applyPreset(chip.dataset.probeId, chip.dataset.presetName, parseFloat(chip.dataset.presetTemp)); return; }

    const btn = target.closest('[data-action]');
    if (!btn) return;
    const { action } = btn.dataset;

    if (action === 'edit-probe')    { openEditProbeModal(btn.dataset.probeId); return; }
    if (action === 'delete-probe')  { await deleteProbe(btn.dataset.probeId); return; }
    if (action === 'start-cook')    { openStartCookModal(btn.dataset.probeId); return; }
    if (action === 'end-cook')      { await endCook(btn.dataset.probeId, btn.dataset.sessionId); return; }
    if (action === 'start-rest')    { await startRestTimer(btn.dataset.sessionId, document.getElementById(`rest-min-${btn.dataset.sessionId}`)?.value || 15); return; }
    if (action === 'cancel-rest')   { await cancelRestTimer(btn.dataset.sessionId); return; }
    if (action === 'save-journal')  { await saveJournal(btn.dataset.sessionId, document.getElementById(`journal-${btn.dataset.sessionId}`)?.value || ''); return; }
  });

  grid.addEventListener('change', async (e) => {
    const presetSel = e.target.closest('.preset-select');
    if (presetSel && presetSel.value) {
      const [name, temp] = presetSel.value.split('|');
      await applyPreset(presetSel.dataset.probeId, name, parseFloat(temp));
      presetSel.classList.remove('open');
      return;
    }
    const swInput = e.target.closest('[data-action="switch"]');
    if (swInput) { await toggleSwitch(swInput.dataset.probeId, swInput.checked); return; }
  });
}

// ── Probe actions ─────────────────────────────────────────────────────────────
async function applyPreset(probeId, name, temp) {
  const probe = state.probes.find(p => p.id === probeId);
  if (probe) {
    probe.preset = name;
    if (probe.active_session) {
      probe.active_session.preset = name;
      probe.active_session.target_temp = temp;
    }
    const card = document.getElementById(`probe-card-${probeId}`);
    if (card) { card.replaceWith(buildProbeCard(probe)); await initProbeChart(probe); }
  }
  showToast(`Preset → ${name} (${temp}°C)`, '#4ade80');
  try {
    // Always send both preset and target_temp explicitly
    await PATCH(`/api/probes/${probeId}`, { preset: name, target_temp: temp });
    if (probe?.active_session) {
      await PATCH(`/api/cooks/${probe.active_session.id}`, { preset: name, target_temp: temp });
    }
  } catch (e) { showToast('Save error: ' + e.message, '#f87171'); }
}

async function toggleSwitch(probeId, on) {
  try {
    await POST(`/api/probes/${probeId}/switch`, { state: on });
    showToast(`Probe ${on ? 'enabled' : 'disabled'}`, '#60a5fa');
    await refreshProbes();
  } catch (e) { showToast(e.message, '#f87171'); }
}

async function deleteProbe(probeId) {
  if (!confirm('Remove this probe and all its cook history?')) return;
  try { await DELETE(`/api/probes/${probeId}`); showToast('Probe removed', '#f87171'); await refreshProbes(); }
  catch (e) { showToast(e.message, '#f87171'); }
}

async function endCook(probeId, sessionId) {
  if (!confirm('End this cook session?')) return;
  try { await POST(`/api/cooks/${sessionId}/end`, {}); showToast('Cook ended', '#4ade80'); await refreshProbes(); }
  catch (e) { showToast(e.message, '#f87171'); }
}

async function startRestTimer(sessionId, minutes) {
  try { await POST(`/api/cooks/${sessionId}/rest`, { minutes: parseInt(minutes) }); showToast(`⏱ Rest timer: ${minutes} min`, '#60a5fa'); await refreshProbes(); }
  catch (e) { showToast(e.message, '#f87171'); }
}

async function cancelRestTimer(sessionId) {
  try { await DELETE(`/api/cooks/${sessionId}/rest`); showToast('Rest timer cancelled', '#f87171'); await refreshProbes(); }
  catch (e) { showToast(e.message, '#f87171'); }
}

async function saveJournal(sessionId, text) {
  try { await PATCH(`/api/cooks/${sessionId}/journal`, { journal: text }); showToast('Journal saved ✓', '#4ade80'); }
  catch (e) { showToast(e.message, '#f87171'); }
}

// ── Add/Edit Probe Modal ──────────────────────────────────────────────────────
async function openAddProbeModal() {
  state.editingProbeId = null;
  document.getElementById('probe-modal-title').textContent = '🔥 Add Probe';
  clearProbeForm();
  await loadHAEntities();
  setupEntitySearches();
  document.getElementById('probe-modal').classList.add('open');
}

async function openEditProbeModal(probeId) {
  state.editingProbeId = probeId;
  const probe = state.probes.find(p => p.id === probeId) || await GET(`/api/probes/${probeId}`);
  document.getElementById('probe-modal-title').textContent = '✏️ Edit Probe';
  fillProbeForm(probe);
  await loadHAEntities();
  setupEntitySearches();
  document.getElementById('probe-modal').classList.add('open');
}

function clearProbeForm() {
  ['p-name','p-probe-entity','p-ambient-entity','p-enable-switch','p-weather-entity','p-preset','p-notes'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const g = document.getElementById('p-goal'); if (g) g.value = 'at_target_temperature';
  const a = document.getElementById('p-alert'); if (a) a.checked = true;
  updateGoalFields();
}

function fillProbeForm(probe) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
  set('p-name', probe.name); set('p-probe-entity', probe.probe_entity);
  set('p-ambient-entity', probe.ambient_entity); set('p-enable-switch', probe.enable_switch);
  set('p-weather-entity', probe.weather_entity);
  set('p-goal', probe.goal || 'at_target_temperature');
  set('p-target-temp', probe.target_temp); set('p-lower', probe.lower_threshold);
  set('p-upper', probe.upper_threshold); set('p-preset', probe.preset); set('p-notes', probe.notes);
  const a = document.getElementById('p-alert'); if (a) a.checked = probe.alert_enabled !== false;
  updateGoalFields();
}

function updateGoalFields() {
  const goal = document.getElementById('p-goal')?.value;
  const isRange = goal === 'in_temperature_range';
  document.getElementById('row-target')?.style.setProperty('display', isRange ? 'none' : '');
  document.getElementById('row-range')?.style.setProperty('display', isRange ? '' : 'none');
}

async function saveProbe() {
  const name = document.getElementById('p-name')?.value.trim();
  const probeEntity = document.getElementById('p-probe-entity')?.value.trim();
  if (!name || !probeEntity) { showToast('Name and probe sensor are required', '#f87171'); return; }

  const goal = document.getElementById('p-goal')?.value || 'at_target_temperature';
  const data = {
    name, probe_entity: probeEntity,
    ambient_entity: document.getElementById('p-ambient-entity')?.value.trim() || null,
    enable_switch:  document.getElementById('p-enable-switch')?.value.trim()  || null,
    weather_entity: document.getElementById('p-weather-entity')?.value.trim() || null,
    goal,
    target_temp:     parseFloat(document.getElementById('p-target-temp')?.value) || null,
    lower_threshold: parseFloat(document.getElementById('p-lower')?.value)       || null,
    upper_threshold: parseFloat(document.getElementById('p-upper')?.value)       || null,
    preset:    document.getElementById('p-preset')?.value || null,
    notes:     document.getElementById('p-notes')?.value  || '',
    alert_enabled: document.getElementById('p-alert')?.checked !== false,
  };

  try {
    if (state.editingProbeId) {
      await PATCH(`/api/probes/${state.editingProbeId}`, data);
      showToast('Probe updated ✓', '#4ade80');
    } else {
      await POST('/api/probes', data);
      showToast('Probe added ✓', '#4ade80');
    }
    closeProbeModal();
    await refreshProbes();
  } catch (e) { showToast(e.message, '#f87171'); }
}

function closeProbeModal() { document.getElementById('probe-modal')?.classList.remove('open'); }

// ── Entity autocomplete ────────────────────────────────────────────────────────
function setupEntitySearches() {
  const configs = [
    { id: 'p-probe-entity',   domains: ['sensor'] },
    { id: 'p-ambient-entity', domains: ['sensor'] },
    { id: 'p-enable-switch',  domains: ['switch', 'input_boolean'] },
    { id: 'p-weather-entity', domains: ['weather'] },
  ];

  configs.forEach(({ id, domains }) => {
    const input = document.getElementById(id);
    if (!input) return;

    let dropdown = document.getElementById(`${id}-dropdown`);
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.id = `${id}-dropdown`;
      dropdown.className = 'entity-dropdown';
      input.parentNode.style.position = 'relative';
      input.parentNode.appendChild(dropdown);
    }

    input.addEventListener('input', () => {
      const q = input.value.toLowerCase();
      if (!q) { dropdown.classList.remove('open'); return; }
      const filtered = state.haEntities
        .filter(e => domains.includes(e.domain) && (e.entity_id.includes(q) || e.friendly_name.toLowerCase().includes(q)))
        .slice(0, 10);
      dropdown.innerHTML = filtered.map(e =>
        `<div class="entity-option" data-entity="${e.entity_id}">
          <div>${e.friendly_name}</div>
          <div class="eid">${e.entity_id}</div>
        </div>`).join('');
      dropdown.classList.toggle('open', filtered.length > 0);
    });

    dropdown.addEventListener('click', (e) => {
      const opt = e.target.closest('.entity-option');
      if (opt) { input.value = opt.dataset.entity; dropdown.classList.remove('open'); }
    });

    input.addEventListener('blur', () => setTimeout(() => dropdown.classList.remove('open'), 200));
  });

  document.getElementById('p-preset')?.addEventListener('change', (e) => {
    const temp = PRESETS[e.target.value];
    if (temp) { const t = document.getElementById('p-target-temp'); if (t && !t.value) t.value = temp; }
  });
}

// ── Start Cook Modal ──────────────────────────────────────────────────────────
function openStartCookModal(probeId) {
  state.startCookProbeId = probeId;
  const probe = state.probes.find(p => p.id === probeId);
  if (!probe) return;
  document.getElementById('sc-name').value    = probe.preset ? `${probe.name} — ${probe.preset}` : probe.name;
  document.getElementById('sc-preset').value  = probe.preset  || '';
  document.getElementById('sc-goal').value    = probe.goal    || 'at_target_temperature';
  document.getElementById('sc-target').value  = probe.target_temp      || '';
  document.getElementById('sc-lower').value   = probe.lower_threshold  || '';
  document.getElementById('sc-upper').value   = probe.upper_threshold  || '';
  document.getElementById('sc-notes').value   = '';
  document.getElementById('sc-weight').value  = '';
  document.getElementById('sc-rest-min').value = 15;
  document.getElementById('sc-auto-end').checked = true;
  document.getElementById('sc-auto-minutes').value = 10;
  pendingMilestones.length = 0;
  renderPendingMilestones();
  updateStartCookGoalFields();
  document.getElementById('start-cook-modal').classList.add('open');
}

function updateStartCookGoalFields() {
  const isRange = document.getElementById('sc-goal')?.value === 'in_temperature_range';
  document.getElementById('sc-row-target')?.style.setProperty('display', isRange ? 'none' : '');
  document.getElementById('sc-row-range')?.style.setProperty('display', isRange ? '' : 'none');
}

async function startCook() {
  const probeId = state.startCookProbeId;
  if (!probeId) return;
  const name = document.getElementById('sc-name')?.value.trim();
  if (!name) { showToast('Cook name required', '#f87171'); return; }

  const goal = document.getElementById('sc-goal')?.value || 'at_target_temperature';
  const data = {
    probe_id: probeId, name,
    preset:    document.getElementById('sc-preset')?.value   || null,
    notes:     document.getElementById('sc-notes')?.value    || '',
    goal,
    target_temp:      parseFloat(document.getElementById('sc-target')?.value)      || null,
    lower_threshold:  parseFloat(document.getElementById('sc-lower')?.value)       || null,
    upper_threshold:  parseFloat(document.getElementById('sc-upper')?.value)       || null,
    auto_end:         document.getElementById('sc-auto-end')?.checked !== false,
    auto_end_minutes: parseInt(document.getElementById('sc-auto-minutes')?.value)  || 10,
    meat_weight_kg:   parseFloat(document.getElementById('sc-weight')?.value)      || null,
    rest_minutes:     parseInt(document.getElementById('sc-rest-min')?.value)      || 0,
    milestones: [...pendingMilestones],
  };

  try {
    await POST('/api/cooks/start', data);
    showToast('Cook started! 🔥', '#4ade80');
    closeStartCookModal();
    pendingMilestones.length = 0;
    renderPendingMilestones();
    await refreshProbes();
  } catch (e) { showToast(e.message, '#f87171'); }
}

function closeStartCookModal() { document.getElementById('start-cook-modal')?.classList.remove('open'); }

// ── Milestones ────────────────────────────────────────────────────────────────
function addPendingMilestone() {
  const tempEl  = document.getElementById('ms-temp');
  const labelEl = document.getElementById('ms-label');
  const temp    = parseFloat(tempEl?.value);
  if (!temp || isNaN(temp)) { showToast('Enter a temperature', '#f87171'); return; }
  const label = labelEl?.value.trim() || `${temp}°C`;
  pendingMilestones.push({ temp, label });
  if (tempEl)  tempEl.value  = '';
  if (labelEl) labelEl.value = '';
  renderPendingMilestones();
}

function removePendingMilestone(i) {
  pendingMilestones.splice(i, 1);
  renderPendingMilestones();
}

function renderPendingMilestones() {
  const el = document.getElementById('pending-milestones');
  if (!el) return;
  el.innerHTML = pendingMilestones.map((m, i) =>
    `<div class="milestone-chip">
      <span class="milestone-temp">${m.temp}°</span>
      <span>${m.label}</span>
      <span class="remove" onclick="removePendingMilestone(${i})">✕</span>
    </div>`).join('');
}

// ── History ────────────────────────────────────────────────────────────────────
function renderHistory() {
  const list = document.getElementById('session-list');
  if (!list) return;
  if (!state.historyData.length) {
    list.innerHTML = `<div class="empty-state"><div class="icon">📊</div><h2>No Cook History</h2><p>Complete a cook session to see it here.</p></div>`;
    return;
  }
  list.innerHTML = '';
  state.historyData.forEach(s => list.appendChild(buildSessionCard(s)));
}

function buildSessionCard(session) {
  const started  = new Date(session.started_at);
  const ended    = session.ended_at ? new Date(session.ended_at) : null;
  const duration = ended ? formatDuration((ended - started) / 1000) : '🔴 Active';

  const div = document.createElement('div');
  div.className = 'session-card';
  div.innerHTML = `
    <div class="session-card-header">
      <div>
        <div class="session-name">${session.name}</div>
        <div class="session-meta">${session.probe_name || ''} · ${started.toLocaleDateString()} ${started.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}${session.preset ? ` · 🥩 ${session.preset}` : ''}</div>
      </div>
      <div class="session-stats">
        <div class="session-stat">
          <div class="v" style="color:var(--fire)">${session.peak_temp != null ? session.peak_temp.toFixed(1) + '°' : '—'}</div>
          <div class="l">Peak</div>
        </div>
        <div class="session-stat">
          <div class="v" style="color:var(--muted)">${duration}</div>
          <div class="l">Duration</div>
        </div>
      </div>
    </div>
    <div class="session-detail" id="detail-${session.id}">
      <canvas class="session-chart" id="hchart-${session.id}"></canvas>
      <div style="font-size:0.72rem;color:var(--muted);margin-top:10px;display:flex;gap:14px;flex-wrap:wrap">
        ${session.target_temp ? `<span>Target: <strong style="color:var(--pale)">${session.target_temp}°C</strong></span>` : ''}
        ${session.goal_reached_at ? `<span style="color:var(--green)">✅ Goal reached</span>` : ''}
        ${session.stall_started_at ? `<span style="color:var(--amber)">⏸ Stall @ ${session.stall_temp?.toFixed(1)}°C</span>` : ''}
        ${session.ambient_start != null ? `<span>Ambient start: <strong style="color:var(--blue)">${session.ambient_start.toFixed(1)}°</strong></span>` : ''}
        ${session.ambient_end != null   ? `<span>Ambient end: <strong style="color:var(--blue)">${session.ambient_end.toFixed(1)}°</strong></span>` : ''}
        ${session.weather_temp != null  ? `<span class="weather-badge">🌤 ${session.weather_condition || ''} ${session.weather_temp}°C ${session.weather_humidity ? session.weather_humidity + '% RH' : ''}</span>` : ''}
        ${session.meat_weight_kg        ? `<span>⚖️ ${session.meat_weight_kg}kg</span>` : ''}
        <span>End: <strong style="color:var(--pale)">${session.end_reason || 'active'}</strong></span>
      </div>
      ${session.journal ? `<div style="font-size:0.78rem;color:var(--muted);margin-top:8px;font-style:italic;border-top:1px solid #3d2e22;padding-top:8px">📝 ${session.journal}</div>` : ''}
      ${session.photo_data ? `<img src="${session.photo_data}" style="width:100%;border-radius:8px;margin-top:10px;max-height:200px;object-fit:cover" alt="Cook photo">` : ''}
      <div class="export-btns">
        <a class="btn-export" href="/api/analytics/export/session/${session.id}/csv" download>⬇ CSV</a>
        <a class="btn-export" href="/api/analytics/export/session/${session.id}/json" download>⬇ JSON</a>
        <button class="btn-cook-again" onclick="cookAgain('${session.id}')">🔥 Cook Again</button>
      </div>
    </div>`;

  div.querySelector('.session-card-header').addEventListener('click', async () => {
    const detail = div.querySelector('.session-detail');
    const isOpen = detail.classList.toggle('open');
    if (isOpen && !state.historyCharts[session.id]) await loadSessionChart(session.id);
  });

  return div;
}

async function loadSessionChart(sessionId) {
  const canvas = document.getElementById(`hchart-${sessionId}`);
  if (!canvas) return;
  try {
    const data     = await GET(`/api/history/session/${sessionId}/readings`);
    const readings = data.readings || [];
    if (!readings.length) return;

    const labels     = readings.map(r => new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const temps      = readings.map(r => r.temp);
    const ambients   = readings.map(r => r.ambient);
    const hasAmbient = ambients.some(a => a != null);
    const rors       = readings.map(r => r.ror);
    const hasRor     = rors.some(r => r != null);

    const datasets = [{ label: 'Probe', data: temps, borderColor: '#FF4D00', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false, yAxisID: 'y' }];
    if (hasAmbient) datasets.push({ label: 'Ambient', data: ambients, borderColor: '#60a5fa', borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false, borderDash: [4, 3], yAxisID: 'y' });
    if (data.session?.target_temp) datasets.push({ label: 'Target', data: Array(labels.length).fill(data.session.target_temp), borderColor: '#4ade80', borderWidth: 1, pointRadius: 0, borderDash: [6, 4], fill: false, yAxisID: 'y' });
    if (hasRor) datasets.push({ label: '°/min', data: rors, borderColor: '#fbbf24', borderWidth: 1, pointRadius: 0, tension: 0.4, fill: false, yAxisID: 'y2' });

    state.historyCharts[sessionId] = new Chart(canvas, {
      type: 'line', data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: hasAmbient || hasRor, labels: { color: '#9c8a7a', font: { size: 9 }, boxWidth: 10 } },
          tooltip: { backgroundColor: '#2d2520', titleColor: '#9c8a7a', bodyColor: '#f5ede4', borderColor: '#3d2e22', borderWidth: 1 },
        },
        scales: {
          x: { ticks: { color: '#9c8a7a', font: { size: 9 }, maxTicksLimit: 8 }, grid: { color: '#3d2e22' } },
          y: { ticks: { color: '#9c8a7a', font: { size: 9 }, callback: v => v + '°' }, grid: { color: '#3d2e22' } },
          y2: { display: hasRor, position: 'right', ticks: { color: '#fbbf24', font: { size: 8 }, callback: v => v + '/m' }, grid: { drawOnChartArea: false } },
        },
      },
    });
  } catch (e) { console.error('loadSessionChart:', e); }
}

async function cookAgain(sessionId) {
  try {
    await POST(`/api/cooks/${sessionId}/cook-again`, {});
    showToast('Cook started! 🔥', '#4ade80');
    switchTab('dashboard');
    await refreshProbes();
  } catch (e) { showToast(e.message, '#f87171'); }
}

// ── Analytics ─────────────────────────────────────────────────────────────────
function renderPresetStats(stats) {
  const el = document.getElementById('preset-stats-body');
  if (!el) return;
  if (!stats.length) { el.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:16px">No completed cooks yet</td></tr>'; return; }
  el.innerHTML = stats.map(s => {
    const rate = s.cook_count > 0 ? Math.round(s.success_count / s.cook_count * 100) : 0;
    const avgH = s.avg_duration_min ? Math.floor(s.avg_duration_min / 60) + 'h ' + Math.round(s.avg_duration_min % 60) + 'm' : '—';
    return `<tr>
      <td><strong style="color:var(--pale)">${s.preset}</strong></td>
      <td style="color:var(--fire)">${s.cook_count}</td>
      <td>${avgH}</td>
      <td style="color:var(--ember)">${s.avg_peak_temp ? s.avg_peak_temp.toFixed(1) + '°' : '—'}</td>
      <td>${rate}%<div class="success-bar-bg"><div class="success-bar-fill" style="width:${rate}%"></div></div></td>
    </tr>`;
  }).join('');
}

function renderWeatherCorrelation(data) {
  const canvas = document.getElementById('weather-chart');
  if (!canvas) return;
  if (state.analyticsCharts.weather) { state.analyticsCharts.weather.destroy(); delete state.analyticsCharts.weather; }
  const points = data.filter(d => d.weather_temp != null && d.duration_min > 0);
  if (!points.length) return;
  state.analyticsCharts.weather = new Chart(canvas, {
    type: 'scatter',
    data: { datasets: [{ label: 'Cook duration vs ambient', data: points.map(d => ({ x: d.weather_temp, y: d.duration_min / 60, preset: d.preset })), backgroundColor: 'rgba(255,77,0,0.6)', pointRadius: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#2d2520', callbacks: { label: ctx => `${ctx.raw.preset || 'Cook'}: ${ctx.raw.y.toFixed(1)}h @ ${ctx.raw.x}°C` } } },
      scales: {
        x: { title: { display: true, text: 'Ambient (°C)', color: '#9c8a7a', font: { size: 10 } }, ticks: { color: '#9c8a7a', font: { size: 9 } }, grid: { color: '#3d2e22' } },
        y: { title: { display: true, text: 'Duration (h)', color: '#9c8a7a', font: { size: 10 } }, ticks: { color: '#9c8a7a', font: { size: 9 }, callback: v => v + 'h' }, grid: { color: '#3d2e22' } },
      },
    },
  });
}

function renderGrillPersonality(data) {
  const el = document.getElementById('grill-personality-body');
  if (!el) return;
  if (!data || !data.session_count) { el.textContent = 'Not enough data yet. Complete more cook sessions.'; return; }
  el.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
    <div class="stat-card"><div class="stat-val" style="color:var(--blue)">${data.avg_ambient_reading?.toFixed(1) ?? '—'}°</div><div class="stat-lbl">Avg Ambient</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--fire)">${data.max_ambient?.toFixed(1) ?? '—'}°</div><div class="stat-lbl">Max Ambient</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--muted)">${data.min_ambient?.toFixed(1) ?? '—'}°</div><div class="stat-lbl">Min Ambient</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--green)">${data.session_count}</div><div class="stat-lbl">Sessions</div></div>
  </div>`;
}

function renderCompareUI() {
  const container = document.getElementById('compare-session-list');
  if (!container) return;
  const completed = state.historyData.filter(s => s.ended_at).slice(0, 20);
  if (!completed.length) { container.innerHTML = '<span style="color:var(--muted);font-size:0.8rem">No completed sessions yet</span>'; return; }
  container.innerHTML = completed.map(s =>
    `<label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:0.8rem;cursor:pointer">
      <input type="checkbox" data-session-id="${s.id}" style="accent-color:var(--fire)">
      <span>${s.name} — <span style="color:var(--muted)">${new Date(s.started_at).toLocaleDateString()}</span></span>
    </label>`).join('');
}

async function runComparison() {
  const checked = [...document.querySelectorAll('#compare-session-list input:checked')];
  if (checked.length < 2) { showToast('Select at least 2 sessions', '#f87171'); return; }
  if (checked.length > 6) { showToast('Maximum 6 sessions', '#f87171'); return; }
  const ids = checked.map(c => c.dataset.sessionId).join(',');
  try {
    const data = await GET(`/api/analytics/compare?session_ids=${ids}`);
    renderCompareChart(data);
  } catch (e) { showToast(e.message, '#f87171'); }
}

function renderCompareChart(data) {
  const canvas = document.getElementById('compare-chart');
  if (!canvas) return;
  if (state.analyticsCharts.compare) { state.analyticsCharts.compare.destroy(); delete state.analyticsCharts.compare; }
  const COLORS = ['#FF4D00','#60a5fa','#4ade80','#fbbf24','#f87171','#a78bfa'];
  const datasets = data.sessions.map((session, i) => ({
    label: session.name,
    data: (data.readings[session.id] || []).map(r => ({ x: parseFloat((r.minutes_elapsed || 0).toFixed(1)), y: r.temp })),
    borderColor: COLORS[i % COLORS.length], borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false,
  }));
  state.analyticsCharts.compare = new Chart(canvas, {
    type: 'line', data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, parsing: false,
      plugins: { legend: { labels: { color: '#9c8a7a', font: { size: 9 }, boxWidth: 10 } },
                 tooltip: { backgroundColor: '#2d2520', titleColor: '#9c8a7a', bodyColor: '#f5ede4', borderColor: '#3d2e22', borderWidth: 1,
                            callbacks: { title: ctx => ctx[0].raw.x + ' min', label: ctx => `${ctx.dataset.label}: ${ctx.raw.y?.toFixed(1)}°` } } },
      scales: {
        x: { type: 'linear', title: { display: true, text: 'Minutes from start', color: '#9c8a7a', font: { size: 9 } }, ticks: { color: '#9c8a7a', font: { size: 9 } }, grid: { color: '#3d2e22' } },
        y: { ticks: { color: '#9c8a7a', font: { size: 9 }, callback: v => v + '°' }, grid: { color: '#3d2e22' } },
      },
    },
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (seconds < 60)   return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function showToast(msg, color = '#4ade80') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent    = msg;
  t.style.borderColor = color;
  t.style.color    = color;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

// Expose globals used from HTML onclick attributes
window.openAddProbeModal       = openAddProbeModal;
window.closeProbeModal         = closeProbeModal;
window.saveProbe               = saveProbe;
window.updateGoalFields        = updateGoalFields;
window.closeStartCookModal     = closeStartCookModal;
window.startCook               = startCook;
window.updateStartCookGoalFields = updateStartCookGoalFields;
window.addPendingMilestone     = addPendingMilestone;
window.removePendingMilestone  = removePendingMilestone;
window.cookAgain               = cookAgain;
window.runComparison           = runComparison;
window.loadHistory             = loadHistory;
window.switchTab               = switchTab;
