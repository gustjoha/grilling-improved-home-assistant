
// ── Analytics ─────────────────────────────────────────────────────────────────

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
  } catch (e) {
    console.error('Analytics load failed:', e);
  }
}

function renderPresetStats(stats) {
  const el = document.getElementById('preset-stats-body');
  if (!el) return;
  if (!stats.length) {
    el.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:16px">No completed cooks yet</td></tr>';
    return;
  }
  el.innerHTML = stats.map(s => {
    const successRate = s.cook_count > 0 ? Math.round(s.success_count / s.cook_count * 100) : 0;
    const avgH = s.avg_duration_min ? Math.floor(s.avg_duration_min / 60) + 'h ' + Math.round(s.avg_duration_min % 60) + 'm' : '—';
    return `<tr>
      <td><strong style="color:var(--pale)">${s.preset}</strong></td>
      <td style="color:var(--fire)">${s.cook_count}</td>
      <td>${avgH}</td>
      <td style="color:var(--ember)">${s.avg_peak_temp ? s.avg_peak_temp.toFixed(1) + '°' : '—'}</td>
      <td>
        ${successRate}%
        <div class="success-bar-bg"><div class="success-bar-fill" style="width:${successRate}%"></div></div>
      </td>
    </tr>`;
  }).join('');
}

function renderWeatherCorrelation(data) {
  const canvas = document.getElementById('weather-chart');
  if (!canvas || !data.length) return;
  if (state.analyticsCharts?.weather) state.analyticsCharts.weather.destroy();

  const points = data.filter(d => d.weather_temp !== null && d.duration_min > 0);
  const chart = new Chart(canvas, {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Cook duration vs ambient temp',
        data: points.map(d => ({ x: d.weather_temp, y: d.duration_min / 60, preset: d.preset })),
        backgroundColor: 'rgba(255,77,0,0.6)',
        pointRadius: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#2d2520',
          callbacks: {
            label: ctx => `${ctx.raw.preset || 'Cook'}: ${ctx.raw.y.toFixed(1)}h @ ${ctx.raw.x}°C ambient`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Ambient Temp (°C)', color: '#9c8a7a', font: { size: 10 } },
          ticks: { color: '#9c8a7a', font: { size: 10 } },
          grid: { color: '#3d2e22' },
        },
        y: {
          title: { display: true, text: 'Duration (hours)', color: '#9c8a7a', font: { size: 10 } },
          ticks: { color: '#9c8a7a', font: { size: 10 }, callback: v => v + 'h' },
          grid: { color: '#3d2e22' },
        },
      },
    },
  });
  if (!state.analyticsCharts) state.analyticsCharts = {};
  state.analyticsCharts.weather = chart;
}

function renderGrillPersonality(data) {
  const el = document.getElementById('grill-personality-body');
  if (!el) return;
  if (!data || !data.session_count) {
    el.textContent = 'Not enough data yet. Complete more cook sessions to see grill personality.';
    return;
  }
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="stat-card">
        <div class="stat-val" style="color:var(--blue)">${data.avg_ambient_reading?.toFixed(1) ?? '—'}°</div>
        <div class="stat-lbl">Avg Ambient</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" style="color:var(--fire)">${data.max_ambient?.toFixed(1) ?? '—'}°</div>
        <div class="stat-lbl">Max Ambient</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" style="color:var(--muted)">${data.min_ambient?.toFixed(1) ?? '—'}°</div>
        <div class="stat-lbl">Min Ambient</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" style="color:var(--green)">${data.session_count}</div>
        <div class="stat-lbl">Sessions Tracked</div>
      </div>
    </div>`;
}

function renderCompareUI() {
  const container = document.getElementById('compare-session-list');
  if (!container) return;
  container.innerHTML = state.historyData
    .filter(s => s.ended_at)
    .slice(0, 20)
    .map(s => `
      <label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:0.8rem;cursor:pointer">
        <input type="checkbox" data-session-id="${s.id}" style="accent-color:var(--fire)">
        <span>${s.name} — <span style="color:var(--muted)">${new Date(s.started_at).toLocaleDateString()}</span></span>
      </label>`).join('');
}

async function runComparison() {
  const checked = [...document.querySelectorAll('#compare-session-list input:checked')];
  if (checked.length < 2) { showToast('Select at least 2 sessions to compare', '#f87171'); return; }
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
  if (state.analyticsCharts?.compare) state.analyticsCharts.compare.destroy();

  const COLORS = ['#FF4D00','#60a5fa','#4ade80','#fbbf24','#f87171','#a78bfa'];
  const datasets = data.sessions.map((session, i) => {
    const readings = data.readings[session.id] || [];
    return {
      label: session.name,
      data: readings.map(r => ({ x: parseFloat(r.minutes_elapsed?.toFixed(1) || 0), y: r.temp })),
      borderColor: COLORS[i % COLORS.length],
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3,
      fill: false,
    };
  });

  if (!state.analyticsCharts) state.analyticsCharts = {};
  state.analyticsCharts.compare = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      parsing: false,
      plugins: {
        legend: { labels: { color: '#9c8a7a', font: { size: 10 }, boxWidth: 12 } },
        tooltip: {
          backgroundColor: '#2d2520', titleColor: '#9c8a7a',
          bodyColor: '#f5ede4', borderColor: '#3d2e22', borderWidth: 1,
          callbacks: {
            title: ctx => `${ctx[0].raw.x.toFixed(0)} min`,
            label: ctx => `${ctx.dataset.label}: ${ctx.raw.y?.toFixed(1)}°`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Minutes from start', color: '#9c8a7a', font: { size: 10 } },
          ticks: { color: '#9c8a7a', font: { size: 9 } },
          grid: { color: '#3d2e22' },
        },
        y: {
          ticks: { color: '#9c8a7a', font: { size: 9 }, callback: v => v + '°' },
          grid: { color: '#3d2e22' },
        },
      },
    },
  });
}

// ── Rest timer ─────────────────────────────────────────────────────────────────

async function startRestTimer(sessionId, minutes) {
  try {
    await POST(`/api/cooks/${sessionId}/rest`, { minutes: parseInt(minutes) });
    showToast(`⏱ Rest timer started: ${minutes} min`, '#60a5fa');
    await refreshProbes();
  } catch (e) { showToast(e.message, '#f87171'); }
}

// ── Journal ────────────────────────────────────────────────────────────────────

async function saveJournal(sessionId, text) {
  try {
    await PATCH(`/api/cooks/${sessionId}/journal`, { journal: text });
    showToast('Journal saved ✓', '#4ade80');
  } catch (e) { showToast(e.message, '#f87171'); }
}

// ── Cook again ────────────────────────────────────────────────────────────────

async function cookAgain(sessionId) {
  try {
    const session = await POST(`/api/cooks/${sessionId}/cook-again`, {});
    showToast('Cook started! 🔥', '#4ade80');
    switchTab('dashboard');
    await refreshProbes();
  } catch (e) { showToast(e.message, '#f87171'); }
}

// ── Photo upload ──────────────────────────────────────────────────────────────

function handlePhotoUpload(sessionId, input) {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 3_500_000) { showToast('Image too large (max ~3.5MB)', '#f87171'); return; }
  const reader = new FileReader();
  reader.onload = async (e) => {
    const b64 = e.target.result;
    try {
      await POST(`/api/cooks/${sessionId}/photo`, { photo_data: b64 });
      showToast('Photo saved ✓', '#4ade80');
      await refreshProbes();
    } catch (err) { showToast(err.message, '#f87171'); }
  };
  reader.readAsDataURL(file);
}

// ── Milestone management ──────────────────────────────────────────────────────

const pendingMilestones = [];  // [{temp, label}] for start-cook modal

function addPendingMilestone() {
  const tempEl = document.getElementById('ms-temp');
  const labelEl = document.getElementById('ms-label');
  const temp = parseFloat(tempEl?.value);
  const label = labelEl?.value.trim() || `${temp}°C`;
  if (!temp || isNaN(temp)) { showToast('Enter a temperature', '#f87171'); return; }
  pendingMilestones.push({ temp, label });
  if (tempEl) tempEl.value = '';
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
       <span style="color:var(--pale)">${m.label}</span>
       <span class="remove" onclick="removePendingMilestone(${i})">✕</span>
     </div>`
  ).join('');
}

// Patch startCook to include milestones
const _origStartCook = window.startCook;
window.startCook = async function() {
  // Inject pendingMilestones into form data before calling original
  state._pendingMilestones = [...pendingMilestones];
  await _origStartCook();
  pendingMilestones.length = 0;
  renderPendingMilestones();
};

// Patch saveProbe to include weather_entity
const _origSaveProbe = window.saveProbe;
window.saveProbe = async function() {
  // The form now includes weather_entity, handled by updated saveProbe below
  await _origSaveProbe();
};

// ── Extended buildProbeCard (adds RoR overlay, rest timer, journal, milestones) ──

const _origBuildProbeCard = buildProbeCard;

function buildProbeCard(probe) {
  // Use original to get base card, then enhance it
  const div = _origBuildProbeCard(probe);
  const session = probe.active_session;

  // Add rest timer section if session has rest data
  if (session) {
    const existingActions = div.querySelector('.card-actions');
    if (session.rest_started_at && !session.rest_ended_at) {
      const restBar = document.createElement('div');
      restBar.className = 'rest-timer-bar';
      const started = new Date(session.rest_started_at);
      const endAt = new Date(started.getTime() + (session.rest_minutes || 10) * 60000);
      const remaining = Math.max(0, Math.round((endAt - Date.now()) / 60000));
      restBar.innerHTML = `<span class="rest-timer-label">🌡️ Resting… ${remaining} min left</span>
        <button class="btn-sm" onclick="cancelRestTimer('${session.id}')">Cancel</button>`;
      if (existingActions) div.insertBefore(restBar, existingActions);
    } else if (session.rest_ended_at) {
      const doneBar = document.createElement('div');
      doneBar.className = 'rest-done-bar';
      doneBar.textContent = '✅ Resting complete — ready to slice!';
      if (existingActions) div.insertBefore(doneBar, existingActions);
    } else if (session.goal_reached_at && !session.rest_started_at) {
      // Show start rest timer option
      const restStart = document.createElement('div');
      restStart.className = 'rest-timer-bar';
      restStart.innerHTML = `
        <span class="rest-timer-label">Start rest timer?</span>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="number" id="rest-min-${session.id}" value="${session.rest_minutes || 15}"
            min="1" max="120" style="width:50px;background:var(--coal);border:1px solid #3d2e22;
            border-radius:6px;color:var(--pale);padding:3px 6px;font-size:0.78rem;text-align:center">
          <button class="btn-sm" style="flex:none" onclick="startRestTimer('${session.id}',document.getElementById('rest-min-${session.id}').value)">▶ Start</button>
        </div>`;
      if (existingActions) div.insertBefore(restStart, existingActions);
    }

    // Journal section
    const journalWrap = document.createElement('div');
    journalWrap.className = 'journal-wrap';
    journalWrap.innerHTML = `
      <div class="journal-label">📝 Cook Journal</div>
      <textarea class="journal-textarea" id="journal-${session.id}" placeholder="Notes, observations, what to try next time…">${session.journal || ''}</textarea>
      <button class="journal-save-btn" onclick="saveJournal('${session.id}', document.getElementById('journal-${session.id}').value)">Save</button>`;
    if (existingActions) div.insertBefore(journalWrap, existingActions);
  }

  return div;
}

async function cancelRestTimer(sessionId) {
  try {
    await api(`/api/cooks/${sessionId}/rest`, { method: 'DELETE' });
    showToast('Rest timer cancelled', '#f87171');
    await refreshProbes();
  } catch (e) { showToast(e.message, '#f87171'); }
}

// ── Extended buildSessionCard (cook-again, export, milestones, weather, photo, journal) ──

const _origBuildSessionCard = buildSessionCard;

function buildSessionCard(session) {
  const div = _origBuildSessionCard(session);
  const detail = div.querySelector('.session-detail');
  if (!detail) return div;

  // Extra detail content
  const extra = document.createElement('div');
  extra.innerHTML = `
    <div class="export-btns">
      <a class="btn-export" href="/api/analytics/export/session/${session.id}/csv" download>⬇ CSV</a>
      <a class="btn-export" href="/api/analytics/export/session/${session.id}/json" download>⬇ JSON</a>
      <button class="btn-cook-again" onclick="cookAgain('${session.id}')">🔥 Cook Again</button>
    </div>
    ${session.weather_temp != null ? `
      <div style="margin-top:8px">
        <span class="weather-badge">🌤 ${session.weather_condition || 'Weather'} · ${session.weather_temp}°C · ${session.weather_humidity ? session.weather_humidity + '% humidity' : ''}</span>
      </div>` : ''}
    ${session.meat_weight_kg ? `<div style="font-size:0.72rem;color:var(--muted);margin-top:6px">⚖️ Weight: <strong style="color:var(--pale)">${session.meat_weight_kg}kg</strong></div>` : ''}
    ${session.stall_started_at ? `<div style="font-size:0.72rem;color:var(--amber);margin-top:6px">⏸ Stall at ${session.stall_temp?.toFixed(1)}°C ${session.stall_ended_at ? '(resolved)' : '(ongoing)'}</div>` : ''}
    ${session.journal ? `<div style="font-size:0.78rem;color:var(--muted);margin-top:8px;font-style:italic;border-top:1px solid #3d2e22;padding-top:8px">📝 ${session.journal}</div>` : ''}
    ${session.photo_data ? `<img class="photo-preview" src="${session.photo_data}" style="margin-top:10px" alt="Cook photo">` : ''}
  `;
  detail.appendChild(extra);

  return div;
}

// ── WS handler extensions ─────────────────────────────────────────────────────

const _origHandleWSMessage = handleWSMessage;
function handleWSMessage(msg) {
  _origHandleWSMessage(msg);
  switch (msg.type) {
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

// ── Nav tab extension for analytics ──────────────────────────────────────────

const _origSwitchTab = switchTab;
function switchTab(tab) {
  _origSwitchTab(tab);
  if (tab === 'analytics') {
    if (!state.historyData.length) {
      loadHistory().then(loadAnalytics);
    } else {
      loadAnalytics();
    }
  }
}

// ── Extend startCook to pass milestones and weather_entity, weight ─────────────

// Override the whole startCook to add new fields
window.startCook = async function() {
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
    meat_weight_kg: parseFloat(document.getElementById('sc-weight')?.value) || null,
    rest_minutes: parseInt(document.getElementById('sc-rest-min')?.value) || 0,
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
};

// Extend saveProbe to include weather_entity
window.saveProbe = async function() {
  const name = document.getElementById('p-name')?.value.trim();
  const probeEntity = document.getElementById('p-probe-entity')?.value.trim();
  if (!name || !probeEntity) { showToast('Name and probe sensor are required', '#f87171'); return; }

  const goal = document.getElementById('p-goal')?.value || 'at_target_temperature';
  const data = {
    name,
    probe_entity: probeEntity,
    ambient_entity: document.getElementById('p-ambient-entity')?.value.trim() || null,
    enable_switch: document.getElementById('p-enable-switch')?.value.trim() || null,
    weather_entity: document.getElementById('p-weather-entity')?.value.trim() || null,
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
};

// Extend entity search setup to include weather entity
const _origSetupEntitySearches = setupEntitySearches;
function setupEntitySearches() {
  _origSetupEntitySearches();
  // Add weather entity search
  const inputId = 'p-weather-entity';
  const input = document.getElementById(inputId);
  if (!input) return;
  let dropdown = document.getElementById(`${inputId}-dropdown`);
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = `${inputId}-dropdown`;
    dropdown.className = 'entity-dropdown';
    input.parentNode.appendChild(dropdown);
  }
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    const filtered = state.haEntities
      .filter(e => e.domain === 'weather' && (e.entity_id.includes(q) || e.friendly_name.toLowerCase().includes(q)))
      .slice(0, 8);
    dropdown.innerHTML = filtered.map(e => `
      <div class="entity-option" data-entity="${e.entity_id}">
        <div>${e.friendly_name}</div>
        <div class="eid">${e.entity_id}</div>
      </div>`).join('');
    dropdown.classList.toggle('open', filtered.length > 0 && q.length > 0);
  });
  dropdown.addEventListener('click', (e) => {
    const opt = e.target.closest('.entity-option');
    if (opt) { input.value = opt.dataset.entity; dropdown.classList.remove('open'); }
  });
}

// Expose new globals
window.cookAgain = cookAgain;
window.startRestTimer = startRestTimer;
window.cancelRestTimer = cancelRestTimer;
window.saveJournal = saveJournal;
window.addPendingMilestone = addPendingMilestone;
window.removePendingMilestone = removePendingMilestone;
window.runComparison = runComparison;
window.handlePhotoUpload = handlePhotoUpload;
window.setupEntitySearches = setupEntitySearches;
window.buildProbeCard = buildProbeCard;
window.buildSessionCard = buildSessionCard;
window.handleWSMessage = handleWSMessage;
window.switchTab = switchTab;
