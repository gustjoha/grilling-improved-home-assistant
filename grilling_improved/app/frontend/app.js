/**
 * Grilling Improved — Frontend Application
 * Communicates with FastAPI backend via REST + WebSocket
 */

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  probes: [],
  activeSessions: {},   // session_id -> session
  charts: {},           // probe_id -> Chart.js instance
  historyCharts: {},    // session_id -> Chart.js instance
  historyData: [],
  haEntities: [],
  ws: null,
  wsConnected: false,
  currentTab: 'dashboard',
  editingProbeId: null,
  startCookProbeId: null,
  chartRanges: {},      // probe_id -> minutes
};

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

// ── API helpers ───────────────────────────────────────────────────────────────
const BASE = '';

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

const GET = (path) => api(path);
const POST = (path, data) => api(path, { method: 'POST', body: JSON.stringify(data) });
const PATCH = (path, data) => api(path, { method: 'PATCH', body: JSON.stringify(data) });
const DELETE = (path) => api(path, { method: 'DELETE' });

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsConnected = true;
    document.querySelector('.ws-dot')?.classList.add('connected');
    // Ping loop
    setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 20000);
  };

  ws.onclose = () => {
    state.wsConnected = false;
    document.querySelector('.ws-dot')?.classList.remove('connected');
    setTimeout(connectWS, 5000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWSMessage(msg);
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
  }
}

function handleLiveReading(msg) {
  const { probe_id, session_id, ts, temp, ambient, peak_temp, min_temp, goal_reached_at, auto_end_scheduled } = msg;

  // Update probe in state
  const probe = state.probes.find(p => p.id === probe_id);
  if (probe) {
    probe.current_temp = temp;
    probe.current_ambient = ambient;
    if (probe.active_session) {
      probe.active_session.peak_temp = peak_temp;
      probe.active_session.min_temp = min_temp;
      probe.active_session.goal_reached_at = goal_reached_at;
    }
    // Re-render just this probe card
    const card = document.getElementById(`probe-card-${probe_id}`);
    if (card) {
      const newCard = buildProbeCard(probe);
      card.replaceWith(newCard);
    }
  }

  // Feed live chart
  const chart = state.charts[probe_id];
  if (chart && temp !== null) {
    const label = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const range = (state.chartRanges[probe_id] || 30) * 60; // seconds
    const maxPoints = Math.ceil(range / 10);

    chart.data.labels.push(label);
    chart.data.datasets[0].data.push(temp);
    if (ambient !== null) chart.data.datasets[1].data.push(ambient);

    // Trim to range
    while (chart.data.labels.length > maxPoints) {
      chart.data.labels.shift();
      chart.data.datasets[0].data.shift();
      if (chart.data.datasets[1]) chart.data.datasets[1].data.shift();
    }
    chart.update('quiet');
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function refreshProbes() {
  try {
    state.probes = await GET('/api/probes');
    renderDashboard();
  } catch (e) {
    console.error('Failed to load probes:', e);
  }
}

async function loadHistory() {
  try {
    state.historyData = await GET('/api/history?limit=50');
    renderHistory();
  } catch (e) {
    console.error('Failed to load history:', e);
  }
}

async function loadHAEntities() {
  try {
    state.haEntities = await GET('/api/ha/entities?domain=sensor,switch,binary_sensor,input_boolean');
  } catch (e) {
    console.warn('Could not load HA entities:', e);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  populatePresetDropdowns();
  connectWS();
  await refreshProbes();
  setupNavTabs();
  setupGridDelegation();

  // Poll probe state every 10s as fallback
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
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      switchTab(target);
    });
  });
}

function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-pane').forEach(p => p.style.display = p.dataset.pane === tab ? '' : 'none');
  if (tab === 'history') loadHistory();
}

// ── Dashboard rendering ───────────────────────────────────────────────────────
function renderDashboard() {
  renderStats();
  const grid = document.getElementById('probe-grid');

  // Update existing cards or add new ones
  const existingIds = new Set([...grid.querySelectorAll('.probe-card')].map(c => c.id.replace('probe-card-', '')));
  const currentIds = new Set(state.probes.map(p => p.id));

  // Remove deleted probes
  existingIds.forEach(id => {
    if (!currentIds.has(id)) {
      document.getElementById(`probe-card-${id}`)?.remove();
      if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
    }
  });

  if (state.probes.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="icon">🔥</div>
      <h2>No Probes Yet</h2>
      <p>Add your first probe to start monitoring your cook.</p>
      <button class="btn-primary" style="max-width:200px" onclick="openAddProbeModal()">Add Probe</button>
    </div>`;
    return;
  }

  state.probes.forEach(probe => {
    const existing = document.getElementById(`probe-card-${probe.id}`);
    const card = buildProbeCard(probe);
    if (existing) {
      existing.replaceWith(card);
    } else {
      grid.appendChild(card);
    }
    // Init or update chart
    initProbeChart(probe);
  });
}

function renderStats() {
  const active = state.probes.filter(p => p.active_session).length;
  const reached = state.probes.filter(p => p.active_session?.goal_reached_at).length;
  const stalls = state.probes.filter(p => p.active_session && isStalling(p)).length;
  const temps = state.probes.map(p => p.current_temp).filter(t => t !== null && t !== undefined);
  const hottest = temps.length ? Math.max(...temps).toFixed(1) + '°C' : '—';

  document.getElementById('stat-active').textContent = active || '—';
  document.getElementById('stat-reached').textContent = reached;
  document.getElementById('stat-stalls').textContent = stalls;
  document.getElementById('stat-hottest').textContent = hottest;
}

function isStalling(probe) {
  // Stall detection placeholder — backend reports this via readings
  return false;
}

function buildProbeCard(probe) {
  const session = probe.active_session;
  const temp = probe.current_temp;
  const ambient = probe.current_ambient;
  const isOffline = temp === null || temp === undefined;
  const isActive = !!session;
  const goalReached = !!session?.goal_reached_at;

  // Temperature color
  let tempClass = 'offline';
  if (!isOffline) {
    if (temp < 40) tempClass = 'cold';
    else if (goalReached) tempClass = 'done';
    else if (temp >= 80) tempClass = 'hot';
    else tempClass = 'warm';
  }

  // Badge
  let badgeClass = 'badge-idle', badgeText = '⬜ Idle';
  if (isOffline) { badgeClass = 'badge-offline'; badgeText = '⚫ Offline'; }
  else if (!isActive) { badgeClass = 'badge-idle'; badgeText = '⬜ Idle'; }
  else if (goalReached) { badgeClass = 'badge-done'; badgeText = '✅ Done'; }
  else { badgeClass = 'badge-cooking'; badgeText = '🔥 Cooking'; }

  // Progress
  let progressHtml = '';
  if (isActive && session.target_temp && !isOffline) {
    const minTemp = session.min_temp ?? temp;
    const pct = Math.min(100, Math.max(0, (temp - minTemp) / (session.target_temp - minTemp) * 100));
    progressHtml = `
      <div class="progress-wrap">
        <div class="progress-labels"><span>Progress</span><span>${pct.toFixed(0)}%</span></div>
        <div class="progress-bg"><div class="progress-fill${goalReached ? ' done' : ''}" style="width:${pct}%"></div></div>
      </div>`;
  }

  // ETA
  let etaHtml = '';
  if (isActive && !goalReached && !isOffline && session.target_temp && temp < session.target_temp) {
    etaHtml = `<div class="eta-bar"><span class="eta-lbl">⏱ ETA to target</span><span class="eta-val" id="eta-${probe.id}">Calculating…</span></div>`;
  }

  // Auto-end info
  let autoEndHtml = '';
  if (goalReached && session.auto_end) {
    autoEndHtml = `<div class="auto-end-bar">⏳ Auto-ending ${session.auto_end_minutes}min after target reached</div>`;
  }

  // Switch toggle
  let switchHtml = '';
  if (probe.enable_switch) {
    const isOn = probe.switch_state === 'on';
    switchHtml = `
      <div class="switch-row">
        <span>Probe power (${probe.enable_switch.split('.')[1]})</span>
        <label class="toggle">
          <input type="checkbox" ${isOn ? 'checked' : ''} data-action="switch" data-probe-id="${probe.id}" data-state="${isOn ? '1' : '0'}">
          <span class="toggle-slider"></span>
        </label>
      </div>`;
  }

  // Preset picker (only when idle or cooking without goal reached)
  const currentPreset = session?.preset || probe.preset || '';
  const presetPickerHtml = `
    <div class="preset-picker">
      <div class="preset-picker-label">
        🥩 Quick Preset
        <span class="all-presets" data-probe-id="${probe.id}">All presets ▾</span>
      </div>
      <div class="preset-chips">
        ${QUICK_PRESETS.map(([name, t]) => `
          <div class="preset-chip${currentPreset === name ? ' active' : ''}"
               data-probe-id="${probe.id}" data-preset-name="${name}" data-preset-temp="${t}">
            ${name.split(' - ')[1] || name} <span style="opacity:.55">${t}°</span>
          </div>`).join('')}
      </div>
      <select class="preset-select" id="preset-select-${probe.id}" data-probe-id="${probe.id}">
        <option value="">— All presets —</option>
        ${Object.entries(PRESETS).map(([name, t]) =>
          `<option value="${name}|${t}" ${currentPreset === name ? 'selected' : ''}>${name} (${t}°C)</option>`
        ).join('')}
      </select>
    </div>`;

  // Cook controls
  let cookControlsHtml = '';
  if (!isActive) {
    cookControlsHtml = `
      <div class="cook-controls">
        <button class="btn-start-cook" data-action="start-cook" data-probe-id="${probe.id}">🔥 START COOK</button>
      </div>`;
  } else {
    cookControlsHtml = `
      <div class="cook-controls">
        <button class="btn-end-cook" data-action="end-cook" data-probe-id="${probe.id}" data-session-id="${session.id}">■ END COOK</button>
      </div>`;
  }

  // Metrics
  const rorEl = `<div class="metric"><div class="metric-val" id="ror-${probe.id}">—</div><div class="metric-lbl">Rate °/min</div></div>`;
  const peakEl = `<div class="metric"><div class="metric-val">${session?.peak_temp != null ? session.peak_temp.toFixed(1) + '°' : '—'}</div><div class="metric-lbl">Peak</div></div>`;
  const minEl = `<div class="metric"><div class="metric-val">${session?.min_temp != null ? session.min_temp.toFixed(1) + '°' : '—'}</div><div class="metric-lbl">Min</div></div>`;

  // Card HTML
  const div = document.createElement('div');
  div.className = `probe-card${goalReached ? ' goal-reached' : ''}`;
  div.id = `probe-card-${probe.id}`;
  div.innerHTML = `
    <div class="probe-header">
      <div>
        <div class="probe-title-row">
          <div>
            <div class="probe-name">${probe.name}</div>
            <div class="probe-entity">${probe.probe_entity}</div>
          </div>
        </div>
      </div>
      <span class="badge ${badgeClass}">${badgeText}</span>
    </div>

    <div class="temp-section">
      <div class="temp-primary">
        <div class="temp-big ${tempClass}">${isOffline ? '—' : temp.toFixed(1) + '°'}</div>
        ${session?.preset || probe.preset ? `<div class="preset-lbl">🥩 ${session?.preset || probe.preset}</div>` : ''}
        ${session?.target_temp ? `<div class="target-lbl">Target <strong>${session.target_temp}°C</strong></div>` : ''}
      </div>
      ${ambient !== null && ambient !== undefined ? `
      <div class="temp-ambient">
        <div class="ambient-val">${ambient.toFixed(1)}°</div>
        <div class="ambient-lbl">Ambient</div>
      </div>` : ''}
    </div>

    ${switchHtml}
    ${progressHtml}

    <div class="metrics">${rorEl}${peakEl}${minEl}</div>

    ${etaHtml}
    ${autoEndHtml}

    <div class="chart-wrap">
      <div class="chart-header">
        <span class="chart-title">Temperature log</span>
        <div class="chart-range-btns">
          <button class="chart-range-btn${(state.chartRanges[probe.id] || 30) === 30 ? ' active' : ''}" data-probe-id="${probe.id}" data-range="30">30m</button>
          <button class="chart-range-btn${state.chartRanges[probe.id] === 60 ? ' active' : ''}" data-probe-id="${probe.id}" data-range="60">1h</button>
          <button class="chart-range-btn${state.chartRanges[probe.id] === 240 ? ' active' : ''}" data-probe-id="${probe.id}" data-range="240">4h</button>
        </div>
      </div>
      <canvas class="chart-canvas" id="chart-${probe.id}"></canvas>
    </div>

    ${presetPickerHtml}

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

  // Destroy old chart if exists
  if (state.charts[probe.id]) {
    state.charts[probe.id].destroy();
  }

  const range = state.chartRanges[probe.id] || 30;
  let readings = [];

  if (probe.active_session) {
    try {
      const data = await GET(`/api/history/session/${probe.active_session.id}/readings/recent?minutes=${range}`);
      readings = data.readings || [];
    } catch (e) {}
  }

  const hasAmbient = readings.some(r => r.ambient !== null);
  const labels = readings.map(r => new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const temps = readings.map(r => r.temp);
  const ambients = readings.map(r => r.ambient);

  const datasets = [
    {
      label: 'Probe',
      data: temps,
      borderColor: '#FF4D00',
      backgroundColor: 'rgba(255,77,0,0.08)',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.4,
      fill: true,
    },
  ];

  if (hasAmbient) {
    datasets.push({
      label: 'Ambient',
      data: ambients,
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96,165,250,0.06)',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.4,
      fill: false,
      borderDash: [4, 3],
    });
  }

  // Target line
  if (probe.active_session?.target_temp) {
    datasets.push({
      label: 'Target',
      data: Array(labels.length).fill(probe.active_session.target_temp),
      borderColor: '#4ade80',
      borderWidth: 1,
      pointRadius: 0,
      borderDash: [6, 4],
      fill: false,
    });
  }

  const chart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#2d2520',
          titleColor: '#9c8a7a',
          bodyColor: '#f5ede4',
          borderColor: '#3d2e22',
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          ticks: { color: '#9c8a7a', font: { size: 10 }, maxTicksLimit: 6 },
          grid: { color: '#3d2e22' },
        },
        y: {
          ticks: { color: '#9c8a7a', font: { size: 10 }, callback: v => v + '°' },
          grid: { color: '#3d2e22' },
        },
      },
    },
  });

  state.charts[probe.id] = chart;
}

async function changeChartRange(probeId, minutes) {
  state.chartRanges[probeId] = minutes;
  const probe = state.probes.find(p => p.id === probeId);
  if (probe) await initProbeChart(probe);
  // Update button states
  document.querySelectorAll(`.chart-range-btn[data-probe-id="${probeId}"]`).forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.range) === minutes);
  });
}

// ── Event delegation ──────────────────────────────────────────────────────────
function setupGridDelegation() {
  const grid = document.getElementById('probe-grid');
  if (!grid) return;

  grid.addEventListener('click', async (e) => {
    // Chart range buttons
    const rangeBtn = e.target.closest('.chart-range-btn');
    if (rangeBtn) {
      await changeChartRange(rangeBtn.dataset.probeId, parseInt(rangeBtn.dataset.range));
      return;
    }

    // All-presets toggle
    const allPresets = e.target.closest('.all-presets');
    if (allPresets) {
      const sel = document.getElementById(`preset-select-${allPresets.dataset.probeId}`);
      sel?.classList.toggle('open');
      return;
    }

    // Preset chip
    const chip = e.target.closest('.preset-chip');
    if (chip) {
      await applyPreset(chip.dataset.probeId, chip.dataset.presetName, parseFloat(chip.dataset.presetTemp));
      return;
    }

    // Edit probe
    const editBtn = e.target.closest('[data-action="edit-probe"]');
    if (editBtn) { openEditProbeModal(editBtn.dataset.probeId); return; }

    // Delete probe
    const deleteBtn = e.target.closest('[data-action="delete-probe"]');
    if (deleteBtn) { await deleteProbe(deleteBtn.dataset.probeId); return; }

    // Start cook
    const startBtn = e.target.closest('[data-action="start-cook"]');
    if (startBtn) { openStartCookModal(startBtn.dataset.probeId); return; }

    // End cook
    const endBtn = e.target.closest('[data-action="end-cook"]');
    if (endBtn) { await endCook(endBtn.dataset.probeId, endBtn.dataset.sessionId); return; }
  });

  grid.addEventListener('change', async (e) => {
    // Preset select
    const presetSel = e.target.closest('.preset-select');
    if (presetSel && presetSel.value) {
      const [name, temp] = presetSel.value.split('|');
      await applyPreset(presetSel.dataset.probeId, name, parseFloat(temp));
      presetSel.classList.remove('open');
      return;
    }

    // Switch toggle
    const swInput = e.target.closest('[data-action="switch"]');
    if (swInput) {
      const newState = swInput.checked;
      await toggleSwitch(swInput.dataset.probeId, newState);
      return;
    }
  });
}

// ── Probe actions ─────────────────────────────────────────────────────────────
async function applyPreset(probeId, name, temp) {
  // Optimistic UI
  const probe = state.probes.find(p => p.id === probeId);
  if (probe) {
    probe.preset = name;
    if (probe.active_session) probe.active_session.preset = name;
    const card = document.getElementById(`probe-card-${probeId}`);
    if (card) card.replaceWith(buildProbeCard(probe));
    await initProbeChart(probe);
  }
  showToast(`Preset → ${name} (${temp}°C)`, '#4ade80');
  try {
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
  try {
    await DELETE(`/api/probes/${probeId}`);
    showToast('Probe removed', '#f87171');
    await refreshProbes();
  } catch (e) { showToast(e.message, '#f87171'); }
}

async function endCook(probeId, sessionId) {
  if (!confirm('End this cook session?')) return;
  try {
    await POST(`/api/cooks/${sessionId}/end`, {});
    showToast('Cook ended', '#4ade80');
    await refreshProbes();
  } catch (e) { showToast(e.message, '#f87171'); }
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
  ['p-name','p-probe-entity','p-ambient-entity','p-enable-switch','p-preset','p-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const goalEl = document.getElementById('p-goal');
  if (goalEl) goalEl.value = 'at_target_temperature';
  const alertEl = document.getElementById('p-alert');
  if (alertEl) alertEl.checked = true;
  updateGoalFields();
}

function fillProbeForm(probe) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('p-name', probe.name);
  set('p-probe-entity', probe.probe_entity);
  set('p-ambient-entity', probe.ambient_entity);
  set('p-enable-switch', probe.enable_switch);
  set('p-goal', probe.goal || 'at_target_temperature');
  set('p-target-temp', probe.target_temp);
  set('p-lower', probe.lower_threshold);
  set('p-upper', probe.upper_threshold);
  set('p-preset', probe.preset);
  set('p-notes', probe.notes);
  const alertEl = document.getElementById('p-alert');
  if (alertEl) alertEl.checked = probe.alert_enabled !== false;
  updateGoalFields();
}

function updateGoalFields() {
  const goal = document.getElementById('p-goal')?.value;
  document.getElementById('row-target')?.style.setProperty('display', goal !== 'in_temperature_range' ? '' : 'none');
  document.getElementById('row-range')?.style.setProperty('display', goal === 'in_temperature_range' ? '' : 'none');
}

async function saveProbe() {
  const name = document.getElementById('p-name')?.value.trim();
  const probeEntity = document.getElementById('p-probe-entity')?.value.trim();
  if (!name || !probeEntity) { showToast('Name and probe sensor are required', '#f87171'); return; }

  const goal = document.getElementById('p-goal')?.value || 'at_target_temperature';
  const data = {
    name,
    probe_entity: probeEntity,
    ambient_entity: document.getElementById('p-ambient-entity')?.value.trim() || null,
    enable_switch: document.getElementById('p-enable-switch')?.value.trim() || null,
    goal,
    target_temp: parseFloat(document.getElementById('p-target-temp')?.value) || null,
    lower_threshold: parseFloat(document.getElementById('p-lower')?.value) || null,
    upper_threshold: parseFloat(document.getElementById('p-upper')?.value) || null,
    preset: document.getElementById('p-preset')?.value || null,
    notes: document.getElementById('p-notes')?.value || '',
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

function closeProbeModal() {
  document.getElementById('probe-modal')?.classList.remove('open');
}

// ── Entity search autocomplete ────────────────────────────────────────────────
function setupEntitySearches() {
  ['p-probe-entity', 'p-ambient-entity', 'p-enable-switch'].forEach(inputId => {
    const input = document.getElementById(inputId);
    const dropdownId = `${inputId}-dropdown`;
    let dropdown = document.getElementById(dropdownId);
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.id = dropdownId;
      dropdown.className = 'entity-dropdown';
      input.parentNode.appendChild(dropdown);
    }

    let domain = 'sensor';
    if (inputId === 'p-enable-switch') domain = 'switch,input_boolean';

    input.addEventListener('input', () => {
      const q = input.value.toLowerCase();
      const filtered = state.haEntities
        .filter(e => {
          const domainMatch = domain === '' || domain.split(',').includes(e.domain);
          return domainMatch && (e.entity_id.includes(q) || e.friendly_name.toLowerCase().includes(q));
        })
        .slice(0, 12);

      dropdown.innerHTML = filtered.map(e => `
        <div class="entity-option" data-entity="${e.entity_id}">
          <div>${e.friendly_name}</div>
          <div class="eid">${e.entity_id}</div>
        </div>`).join('');

      dropdown.classList.toggle('open', filtered.length > 0 && q.length > 0);
    });

    dropdown.addEventListener('click', (e) => {
      const opt = e.target.closest('.entity-option');
      if (opt) {
        input.value = opt.dataset.entity;
        dropdown.classList.remove('open');
      }
    });

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    });
  });

  // Preset auto-fill
  document.getElementById('p-preset')?.addEventListener('change', (e) => {
    const temp = PRESETS[e.target.value];
    if (temp) {
      const tField = document.getElementById('p-target-temp');
      if (tField && !tField.value) tField.value = temp;
    }
  });
}

// ── Start Cook Modal ──────────────────────────────────────────────────────────
function openStartCookModal(probeId) {
  state.startCookProbeId = probeId;
  const probe = state.probes.find(p => p.id === probeId);
  if (!probe) return;

  // Pre-fill from probe config
  document.getElementById('sc-name').value = probe.preset ? `${probe.name} — ${probe.preset}` : probe.name;
  document.getElementById('sc-preset').value = probe.preset || '';
  document.getElementById('sc-goal').value = probe.goal || 'at_target_temperature';
  document.getElementById('sc-target').value = probe.target_temp || '';
  document.getElementById('sc-lower').value = probe.lower_threshold || '';
  document.getElementById('sc-upper').value = probe.upper_threshold || '';
  document.getElementById('sc-notes').value = '';
  document.getElementById('sc-auto-end').checked = true;
  document.getElementById('sc-auto-minutes').value = 10;
  updateStartCookGoalFields();

  document.getElementById('start-cook-modal').classList.add('open');
}

function updateStartCookGoalFields() {
  const goal = document.getElementById('sc-goal')?.value;
  document.getElementById('sc-row-target')?.style.setProperty('display', goal !== 'in_temperature_range' ? '' : 'none');
  document.getElementById('sc-row-range')?.style.setProperty('display', goal === 'in_temperature_range' ? '' : 'none');
}

async function startCook() {
  const probeId = state.startCookProbeId;
  if (!probeId) return;

  const name = document.getElementById('sc-name')?.value.trim();
  if (!name) { showToast('Cook name required', '#f87171'); return; }

  const goal = document.getElementById('sc-goal')?.value || 'at_target_temperature';
  const data = {
    probe_id: probeId,
    name,
    preset: document.getElementById('sc-preset')?.value || null,
    notes: document.getElementById('sc-notes')?.value || '',
    goal,
    target_temp: parseFloat(document.getElementById('sc-target')?.value) || null,
    lower_threshold: parseFloat(document.getElementById('sc-lower')?.value) || null,
    upper_threshold: parseFloat(document.getElementById('sc-upper')?.value) || null,
    auto_end: document.getElementById('sc-auto-end')?.checked !== false,
    auto_end_minutes: parseInt(document.getElementById('sc-auto-minutes')?.value) || 10,
  };

  try {
    await POST('/api/cooks/start', data);
    showToast('Cook started! 🔥', '#4ade80');
    closeStartCookModal();
    await refreshProbes();
  } catch (e) { showToast(e.message, '#f87171'); }
}

function closeStartCookModal() {
  document.getElementById('start-cook-modal')?.classList.remove('open');
}

// ── History ───────────────────────────────────────────────────────────────────
function renderHistory() {
  const list = document.getElementById('session-list');
  if (!list) return;

  if (state.historyData.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="icon">📊</div><h2>No Cook History</h2><p>Complete a cook session to see history here.</p></div>`;
    return;
  }

  list.innerHTML = '';
  state.historyData.forEach(session => {
    const card = buildSessionCard(session);
    list.appendChild(card);
  });
}

function buildSessionCard(session) {
  const started = new Date(session.started_at);
  const ended = session.ended_at ? new Date(session.ended_at) : null;
  const duration = ended
    ? formatDuration((ended - started) / 1000)
    : '🔴 Active';

  const div = document.createElement('div');
  div.className = 'session-card';
  div.innerHTML = `
    <div class="session-card-header">
      <div>
        <div class="session-name">${session.name}</div>
        <div class="session-meta">
          ${session.probe_name || ''} · ${started.toLocaleDateString()} ${started.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}
          ${session.preset ? ` · 🥩 ${session.preset}` : ''}
        </div>
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
      <div style="font-size:0.72rem;color:var(--muted);margin-top:8px;display:flex;gap:16px;flex-wrap:wrap">
        ${session.target_temp ? `<span>Target: <strong style="color:var(--pale)">${session.target_temp}°C</strong></span>` : ''}
        ${session.goal_reached_at ? `<span style="color:var(--green)">✅ Goal reached</span>` : ''}
        ${session.ambient_start != null ? `<span>Ambient start: <strong style="color:var(--blue)">${session.ambient_start.toFixed(1)}°</strong></span>` : ''}
        ${session.ambient_end != null ? `<span>Ambient end: <strong style="color:var(--blue)">${session.ambient_end.toFixed(1)}°</strong></span>` : ''}
        <span>End reason: <strong style="color:var(--pale)">${session.end_reason || 'active'}</strong></span>
      </div>
    </div>
  `;

  // Toggle detail on click
  div.querySelector('.session-card-header').addEventListener('click', async () => {
    const detail = div.querySelector('.session-detail');
    const isOpen = detail.classList.toggle('open');
    if (isOpen && !state.historyCharts[session.id]) {
      await loadSessionChart(session.id);
    }
  });

  return div;
}

async function loadSessionChart(sessionId) {
  const canvas = document.getElementById(`hchart-${sessionId}`);
  if (!canvas) return;

  try {
    const data = await GET(`/api/history/session/${sessionId}/readings`);
    const readings = data.readings || [];
    if (readings.length === 0) return;

    const labels = readings.map(r => {
      const d = new Date(r.ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    const temps = readings.map(r => r.temp);
    const ambients = readings.map(r => r.ambient);
    const hasAmbient = ambients.some(a => a !== null);

    const datasets = [{
      label: 'Probe',
      data: temps,
      borderColor: '#FF4D00',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3,
      fill: false,
    }];

    if (hasAmbient) {
      datasets.push({
        label: 'Ambient',
        data: ambients,
        borderColor: '#60a5fa',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: false,
        borderDash: [4, 3],
      });
    }

    if (data.session?.target_temp) {
      datasets.push({
        label: 'Target',
        data: Array(labels.length).fill(data.session.target_temp),
        borderColor: '#4ade80',
        borderWidth: 1,
        pointRadius: 0,
        borderDash: [6, 4],
        fill: false,
      });
    }

    const chart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: {
            display: hasAmbient,
            labels: { color: '#9c8a7a', font: { size: 10 } },
          },
          tooltip: {
            backgroundColor: '#2d2520',
            titleColor: '#9c8a7a',
            bodyColor: '#f5ede4',
            borderColor: '#3d2e22',
            borderWidth: 1,
          },
        },
        scales: {
          x: {
            ticks: { color: '#9c8a7a', font: { size: 9 }, maxTicksLimit: 8 },
            grid: { color: '#3d2e22' },
          },
          y: {
            ticks: { color: '#9c8a7a', font: { size: 9 }, callback: v => v + '°' },
            grid: { color: '#3d2e22' },
          },
        },
      },
    });

    state.historyCharts[sessionId] = chart;
  } catch (e) {
    console.error('Failed to load session chart:', e);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function showToast(msg, color = '#4ade80') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.borderColor = color;
  t.style.color = color;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

// Expose for HTML onclick
window.openAddProbeModal = openAddProbeModal;
window.saveProbe = saveProbe;
window.closeProbeModal = closeProbeModal;
window.updateGoalFields = updateGoalFields;
window.startCook = startCook;
window.closeStartCookModal = closeStartCookModal;
window.updateStartCookGoalFields = updateStartCookGoalFields;
