import { sendToAgent, parseActions } from './agent-client.js';
import { createInitialState, advanceSol, applyActions, plantCrop, CROP_DB } from './greenhouse.js';

let state = createInitialState();
let chatHistory = [];
let isListening = false;
let floraState = 'idle'; // idle | listening | thinking | speaking | alert
let activeTab = null; // null = orb view, 'metrics' | 'module-0' | 'module-1' | 'module-2' | 'harvests'

// ── Voice Server Connection ──────────────────────────────────────────
const VOICE_WS_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'ws://localhost:8765'
  : 'wss://d3v21t4hk4pnn3.cloudfront.net';

let voiceSocket = null;
let audioContext = null;
let mediaStream = null;
let audioWorkletNode = null;
let playbackQueue = [];
let isPlaying = false;

// ── State config (colors, scale, labels) ─────────────────────────────
const FLORA_STATES = {
  idle: {
    c1: 'rgba(16,185,129,0.35)', c2: 'rgba(20,184,166,0.35)', c3: 'rgba(74,222,128,0.35)',
    glow: '0 0 60px rgba(16,185,129,0.2)', scale: 1, rotation: 0, petalSpread: 1,
    ringSpeed: 12, label: 'Monitoring Systems', sub: 'All bio-metrics nominal',
    ascii: '.:+*+:.',  stateColor: '#1a1a1a',
  },
  listening: {
    c1: 'rgba(34,211,238,0.45)', c2: 'rgba(59,130,246,0.35)', c3: 'rgba(94,234,212,0.45)',
    glow: '0 0 80px rgba(34,211,238,0.3)', scale: 1.15, rotation: 45, petalSpread: 1.3,
    ringSpeed: 6, label: 'Awaiting Input', sub: 'Audio channels open',
    ascii: '>>||||<<', stateColor: '#2563eb',
  },
  thinking: {
    c1: 'rgba(168,85,247,0.45)', c2: 'rgba(99,102,241,0.45)', c3: 'rgba(74,222,128,0.35)',
    glow: '0 0 60px rgba(168,85,247,0.25)', scale: 0.9, rotation: 180, petalSpread: 0.8,
    ringSpeed: 3, label: 'Processing', sub: 'Querying knowledge base...',
    ascii: '...oOo...', stateColor: '#6b7280',
  },
  speaking: {
    c1: 'rgba(163,230,53,0.5)', c2: 'rgba(16,185,129,0.45)', c3: 'rgba(134,239,172,0.5)',
    glow: '0 0 80px rgba(163,230,53,0.3)', scale: 1.08, rotation: 15, petalSpread: 1.1,
    ringSpeed: 6, label: 'Transmitting', sub: 'Relaying analysis...',
    ascii: '=)))(((=', stateColor: '#15803d',
  },
  alert: {
    c1: 'rgba(249,115,22,0.5)', c2: 'rgba(239,68,68,0.45)', c3: 'rgba(251,191,36,0.5)',
    glow: '0 0 80px rgba(239,68,68,0.3)', scale: 0.85, rotation: -45, petalSpread: 0.5,
    ringSpeed: 2, label: 'Anomaly Detected', sub: 'Check greenhouse alerts',
    ascii: '!!!XXX!!!', stateColor: '#b91c1c',
  },
};

let stateTimeout = null;
function setFloraState(s) {
  floraState = s;
  updateAvatar();
  clearTimeout(stateTimeout);
  if (s === 'thinking' || s === 'speaking') {
    stateTimeout = setTimeout(() => {
      if (floraState === 'thinking' || floraState === 'speaking') setFloraState('idle');
    }, 15000);
  }
}

// ── Audio Playback (PCM 24kHz from Nova Sonic) ──────────────────────
function enqueueAudio(base64Pcm) {
  const raw = atob(base64Pcm);
  const int16 = new Int16Array(raw.length / 2);
  for (let i = 0; i < int16.length; i++) {
    int16[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
  }
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  playbackQueue.push(float32);
  if (!isPlaying) playNextChunk();
}

function playNextChunk() {
  if (playbackQueue.length === 0) { isPlaying = false; return; }
  isPlaying = true;
  if (!audioContext) audioContext = new AudioContext({ sampleRate: 24000 });

  const chunks = playbackQueue.splice(0, Math.min(playbackQueue.length, 8));
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }

  const buffer = audioContext.createBuffer(1, merged.length, 24000);
  buffer.getChannelData(0).set(merged);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.onended = () => playNextChunk();
  source.start();
}

// ── Voice WebSocket Connection ───────────────────────────────────────
function connectVoice() {
  if (voiceSocket?.readyState === WebSocket.OPEN) return;

  voiceSocket = new WebSocket(VOICE_WS_URL);
  voiceSocket.onopen = () => {
    console.log('[voice] Connected to FLORA voice server');
    appendSystemMsg('Voice link established');
  };
  voiceSocket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'audio':
        if (floraState !== 'speaking') setFloraState('speaking');
        enqueueAudio(msg.data);
        break;
      case 'text':
        if (msg.role === 'USER') {
          appendChatMsg(msg.content, 'user');
        } else if (msg.role === 'ASSISTANT') {
          appendChatMsg(msg.content, 'agent');
        }
        break;
      case 'status':
        setFloraState('thinking');
        break;
      case 'turn_end':
        setTimeout(() => {
          if (floraState !== 'listening') setFloraState('idle');
        }, 1500);
        break;
      case 'interrupted':
        playbackQueue.length = 0;
        isPlaying = false;
        if (audioContext) {
          audioContext.close().catch(() => {});
          audioContext = null;
        }
        setFloraState('listening');
        break;
      case 'error':
        appendSystemMsg('Error: ' + msg.message);
        setFloraState('alert');
        break;
    }
  };
  voiceSocket.onclose = () => {
    console.log('[voice] Disconnected');
    voiceSocket = null;
  };
  voiceSocket.onerror = (err) => {
    console.error('[voice] WebSocket error');
    appendSystemMsg('Voice unavailable — text mode active');
    voiceSocket = null;
  };
}

function appendSystemMsg(text) {
  const msgs = document.getElementById('d-messages');
  if (msgs) {
    msgs.innerHTML += `<div class="d-msg d-msg-system"><div class="d-msg-text">${text}</div></div>`;
    msgs.scrollTop = msgs.scrollHeight;
  }
}

function appendChatMsg(text, role) {
  const msgs = document.getElementById('d-messages');
  if (!msgs) return;
  const cls = role === 'user' ? 'd-msg-user' : 'd-msg-agent';
  msgs.innerHTML += `<div class="d-msg ${cls}"><div class="d-msg-text">${md(text)}</div></div>`;
  msgs.scrollTop = msgs.scrollHeight;
}

// ── Mic Audio Capture (PCM 16kHz → base64 → WebSocket) ──────────────
async function startListening() {
  connectVoice();

  if (!audioContext) audioContext = new AudioContext({ sampleRate: 24000 });

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    appendSystemMsg('Microphone access denied');
    return;
  }

  isListening = true;
  setFloraState('listening');

  const micCtx = new AudioContext({ sampleRate: 16000 });
  const source = micCtx.createMediaStreamSource(mediaStream);
  const processor = micCtx.createScriptProcessor(1024, 1, 1);

  processor.onaudioprocess = (e) => {
    if (!isListening || !voiceSocket || voiceSocket.readyState !== WebSocket.OPEN) return;
    const float32 = e.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32768)));
    }
    const bytes = new Uint8Array(int16.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    voiceSocket.send(JSON.stringify({ type: 'audio', data: base64 }));
  };

  source.connect(processor);
  processor.connect(micCtx.destination);

  window._micCtx = micCtx;
  window._processor = processor;
  window._source = source;
}

function stopListening() {
  isListening = false;
  if (floraState === 'listening') setFloraState('idle');

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  try {
    window._processor?.disconnect();
    window._source?.disconnect();
    window._micCtx?.close();
  } catch {}
}

function speak(text) {
  if (voiceSocket?.readyState === WebSocket.OPEN) return;
  const clean = text.replace(/[#*`|_\[\]{}()>]/g, '').replace(/\n+/g, '. ').slice(0, 600);
  const u = new SpeechSynthesisUtterance(clean);
  u.rate = 1.05;
  u.pitch = 0.95;
  setFloraState('speaking');
  u.onend = () => setFloraState('idle');
  speechSynthesis.speak(u);
}

// ── Markdown ─────────────────────────────────────────────────────────
function md(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```json\s*([\s\S]*?)```/g, '<pre class="d-code">$1</pre>')
    .replace(/```([\s\S]*?)```/g, '<pre class="d-code">$1</pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/\n/g, '<br>');
}

function bar(value, max, color = '#222') {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return `<div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>`;
}

// ── FLORA Avatar (morphing orb, light theme) ────────────────────────
function renderAvatar() {
  const s = FLORA_STATES[floraState];
  // Light-theme orb colors per state
  const orbColors = {
    idle:      ['rgba(34,197,94,0.18)','rgba(16,185,129,0.14)','rgba(74,222,128,0.22)'],
    listening: ['rgba(59,130,246,0.22)','rgba(34,211,238,0.18)','rgba(96,165,250,0.25)'],
    thinking:  ['rgba(120,113,108,0.18)','rgba(168,162,158,0.14)','rgba(87,83,78,0.20)'],
    speaking:  ['rgba(34,197,94,0.25)','rgba(22,163,74,0.20)','rgba(74,222,128,0.30)'],
    alert:     ['rgba(239,68,68,0.22)','rgba(249,115,22,0.18)','rgba(220,38,38,0.25)'],
  };
  const [c1,c2,c3] = orbColors[floraState];

  const petals = [0, 45, 90, 135, 180, 225, 270, 315];
  const petalPaths = petals.map((angle, i) => {
    const primary = i % 2 === 0;
    const spread = primary ? s.petalSpread : s.petalSpread * 0.7;
    return `<path d="M 50 50 C 30 20, 30 0, 50 -15 C 70 0, 70 20, 50 50"
      fill="currentColor" fill-opacity="${primary ? 0.3 : 0.15}"
      stroke="currentColor" stroke-width="${primary ? 1 : 0.5}"
      style="transform-origin:50px 50px;transform:rotate(${angle}deg) scaleY(${spread}) scaleX(${spread * 0.8});transition:all 1.2s cubic-bezier(0.4,0,0.2,1)"/>`;
  }).join('');

  return `
    <div class="flora-orb-wrap">
      <div class="flora-orb-container" style="transform:scale(${s.scale});transition:transform 1s cubic-bezier(0.34,1.56,0.64,1)">
        <div class="flora-blob blob-1" style="background:${c1}"></div>
        <div class="flora-blob blob-2" style="background:${c2}"></div>
        <div class="flora-blob blob-3" style="background:${c3}">
          <div class="flora-lotus" style="transform:rotate(${s.rotation}deg);transition:transform 1.2s cubic-bezier(0.34,1.56,0.64,1)">
            <svg viewBox="-20 -20 140 140" class="flora-svg">
              <g>${petalPaths}</g>
              <circle cx="50" cy="50" r="7" fill="currentColor" opacity="0.4"/>
              <circle cx="50" cy="50" r="13" fill="none" stroke="currentColor" stroke-width="0.5"
                stroke-dasharray="3 3" class="flora-orbit-inner"
                style="animation-duration:${floraState === 'thinking' ? '2s' : '8s'};
                       animation-direction:${floraState === 'thinking' ? 'reverse' : 'normal'}"/>
            </svg>
          </div>
        </div>
      </div>
      <div class="flora-ring" style="animation-duration:${s.ringSpeed}s">
        <div class="flora-ring-dot" style="background:${s.stateColor}"></div>
      </div>
    </div>
    <div class="flora-status">
      <div class="flora-status-label">${s.label}</div>
      <div class="flora-status-sub">${s.sub}</div>
    </div>`;
}

function updateAvatar() {
  const el = document.getElementById('flora-avatar');
  if (el) el.innerHTML = renderAvatar();
}

// ── Detail Panel (shown when a sidebar tab is active) ────────────────
// ASCII crop icons by growth stage
function cropAscii(pct) {
  if (pct >= 90) return '  @\n /|\\\n/ | \\\n__|__';
  if (pct >= 60) return '  .\n /|\\\n  |  \n__|__';
  if (pct >= 30) return '  .\n /|\n  |  \n__|__';
  return '  .\n  |\n  |  \n__|__';
}

// ASCII area map for a module
function moduleAsciiMap(m) {
  const totalSlots = m.area_m2;
  const used = m.crops.reduce((s, c) => s + c.area_m2, 0);
  const free = totalSlots - used;
  const cols = 10;
  let cells = [];
  // Fill with crop symbols
  for (const c of m.crops) {
    const info = CROP_DB[c.type];
    const pct = Math.round((c.daysGrown / info.cycle) * 100);
    const ch = pct >= 90 ? '@' : pct >= 60 ? '#' : pct >= 30 ? '+' : '.';
    for (let i = 0; i < c.area_m2; i++) cells.push(ch);
  }
  // Fill remaining with empty
  for (let i = 0; i < free; i++) cells.push('_');
  // Build grid
  let lines = [];
  for (let r = 0; r < Math.ceil(cells.length / cols); r++) {
    lines.push('  |' + cells.slice(r * cols, r * cols + cols).join(' ') + '|');
  }
  const border = '  +' + '-'.repeat(cols * 2 - 1) + '+';
  return border + '\n' + lines.join('\n') + '\n' + border;
}

function renderDetailPanel() {
  if (!activeTab) return '';

  if (activeTab === 'metrics') {
    const missionPct = Math.round((state.mission.currentSol / state.mission.totalSols) * 100);
    const waterPct = Math.round((state.resources.water_liters / 5000) * 100);
    // ASCII timeline
    const tLen = 40;
    const tFill = Math.round((state.mission.currentSol / state.mission.totalSols) * tLen);
    const timeline = '[' + '='.repeat(tFill) + '>'.repeat(tFill < tLen ? 1 : 0) + '.'.repeat(Math.max(0, tLen - tFill - 1)) + ']';
    // All modules summary
    const allCrops = state.modules.flatMap(mod => mod.crops.map(c => ({ ...c, module: mod.name })));
    return `
      <div class="detail-panel">
        <div class="detail-header">
          <span class="detail-title">Mission Overview</span>
          <button class="detail-close" id="detail-close">&times;</button>
        </div>
        <pre class="detail-ascii">${'SOL ' + state.mission.currentSol + ' / ' + state.mission.totalSols + '  ' + state.mission.phase}\n${timeline}\n${'Day 1' + ' '.repeat(tLen - 6) + 'Day 450'}</pre>
        <div class="detail-grid">
          <div class="detail-item">
            <div class="detail-label">Nutrition</div>
            <div class="detail-value ${state.nutrition.coverage_percent >= 80 ? '' : 'warn'}">${state.nutrition.coverage_percent}%</div>
            <div class="detail-sub">${state.nutrition.current_daily_kcal} / ${state.nutrition.daily_target_kcal} kcal</div>
            <div class="detail-sub">${state.nutrition.current_daily_protein_g} / ${state.nutrition.daily_target_protein_g}g protein</div>
            ${bar(state.nutrition.coverage_percent, 100, '#1a1a1a')}
          </div>
          <div class="detail-item">
            <div class="detail-label">Water</div>
            <div class="detail-value ${waterPct > 40 ? '' : waterPct > 20 ? 'warn' : 'crit'}">${Math.round(state.resources.water_liters)}L</div>
            <div class="detail-sub">${state.resources.water_daily_budget}L/sol budget</div>
            ${bar(state.resources.water_liters, 5000, '#1a1a1a')}
          </div>
          <div class="detail-item">
            <div class="detail-label">Energy</div>
            <div class="detail-value">${state.resources.energy_kwh} kWh</div>
            <div class="detail-sub">CO₂: ${state.resources.co2_kg} kg</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Crew</div>
            <div class="detail-value">${state.mission.crew}</div>
            <div class="detail-sub">${state.mission.name}</div>
          </div>
        </div>
        ${allCrops.length > 0 ? `
        <div class="detail-section-title">Active Crops</div>
        <div class="detail-crop-grid">
          ${allCrops.map(c => {
            const info = CROP_DB[c.type];
            const pct = Math.round((c.daysGrown / info.cycle) * 100);
            return `<div class="detail-crop-card">
              <pre class="detail-crop-ascii">${cropAscii(pct)}</pre>
              <div class="detail-crop-card-name">${info.name}</div>
              <div class="detail-crop-card-meta">${pct}% &middot; ${c.module}</div>
            </div>`;
          }).join('')}
        </div>` : '<div class="detail-empty">No crops planted across any module</div>'}
      </div>`;
  }

  if (activeTab === 'harvests') {
    const totalYield = state.harvests.reduce((s, h) => s + h.yield_kg, 0);
    return `
      <div class="detail-panel">
        <div class="detail-header">
          <span class="detail-title">Harvest Log</span>
          <button class="detail-close" id="detail-close">&times;</button>
        </div>
        ${state.harvests.length > 0 ? `
        <div class="detail-grid" style="margin-bottom:16px">
          <div class="detail-item">
            <div class="detail-label">Total Harvests</div>
            <div class="detail-value">${state.harvests.length}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Total Yield</div>
            <div class="detail-value">${Math.round(totalYield * 10) / 10} kg</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Last Harvest</div>
            <div class="detail-value">Sol ${state.harvests[state.harvests.length - 1].sol}</div>
          </div>
        </div>` : ''}
        <div class="detail-list">
          ${state.harvests.length === 0 ? '<div class="detail-empty">No harvests recorded yet. Plant crops and advance sols to see harvests here.</div>' :
            state.harvests.slice().reverse().map(h => `
              <div class="detail-row">
                <span class="detail-row-label">Sol ${h.sol}</span>
                <span>${h.crop}</span>
                <span class="detail-row-value">${h.yield_kg} kg</span>
                <span class="detail-row-sub">Module ${h.module}</span>
              </div>
            `).join('')}
        </div>
      </div>`;
  }

  const moduleMatch = activeTab.match(/^module-(\d+)$/);
  if (moduleMatch) {
    const mi = parseInt(moduleMatch[1]);
    const m = state.modules[mi];
    if (!m) return '';
    const used = m.crops.reduce((s, c) => s + c.area_m2, 0);
    const free = m.area_m2 - used;
    return `
      <div class="detail-panel">
        <div class="detail-header">
          <span class="detail-title">${m.name}</span>
          <button class="detail-close" id="detail-close">&times;</button>
        </div>

        <div class="detail-two-col">
          <div>
            <div class="detail-section-title">Area Map</div>
            <pre class="detail-ascii">${moduleAsciiMap(m)}</pre>
            <div class="detail-ascii-legend">
              <span>_ empty</span><span>. seedling</span><span>+ growing</span><span># maturing</span><span>@ harvest-ready</span>
            </div>
          </div>
          <div>
            <div class="detail-section-title">Environment</div>
            <div class="detail-env-list">
              <div class="detail-env-row"><span>Temperature</span><span>${m.temp}°C</span></div>
              <div class="detail-env-row"><span>Humidity</span><span>${m.humidity}%</span></div>
              <div class="detail-env-row"><span>Light (PAR)</span><span>${m.light} µmol/m²/s</span></div>
              <div class="detail-env-row"><span>CO₂</span><span>${m.co2} ppm</span></div>
              <div class="detail-env-row"><span>Area Used</span><span>${used} / ${m.area_m2} m²</span></div>
              <div class="detail-env-row"><span>Available</span><span>${free} m²</span></div>
            </div>
          </div>
        </div>

        ${m.crops.length > 0 ? `
        <div class="detail-section-title" style="margin-top:16px">Planted Crops</div>
        <div class="detail-crops">
          ${m.crops.map(c => {
            const info = CROP_DB[c.type];
            const pct = Math.round((c.daysGrown / info.cycle) * 100);
            const daysLeft = info.cycle - c.daysGrown;
            return `
            <div class="detail-crop">
              <div class="detail-crop-header">
                <span class="detail-crop-name">${info.name}</span>
                <span class="detail-crop-pct">${pct}%${pct >= 90 ? ' READY' : ''}</span>
              </div>
              ${bar(c.daysGrown, info.cycle, '#1a1a1a')}
              <div class="detail-crop-meta">
                ${c.area_m2} m² &middot; ${daysLeft}d to harvest &middot; ${info.role}
              </div>
              <div class="detail-crop-meta">
                Planted Sol ${c.plantedSol} &middot; Cycle ${info.cycle}d &middot; Yield ${info.yield_kg_m2} kg/m² &middot; ${info.kcal_100g} kcal/100g
              </div>
            </div>`;
          }).join('')}
        </div>` : ''}

        ${free > 0 ? `
        <div class="detail-section-title" style="margin-top:16px">Plant Crop</div>
        <div class="plant-controls">
          <select class="plant-select" id="plant-crop-${mi}">
            ${Object.entries(CROP_DB).map(([key, info]) => `<option value="${key}">${info.name} — ${info.cycle}d cycle, ${info.role}</option>`).join('')}
          </select>
          <div class="plant-area-row">
            <label class="plant-label">Area (m²)</label>
            <input type="number" class="plant-input" id="plant-area-${mi}" value="4" min="1" max="${free}" />
            <span class="plant-avail">${free} m² available</span>
          </div>
          <button class="d-btn plant-btn" id="plant-btn-${mi}">Plant</button>
        </div>` : '<div class="detail-sub" style="margin-top:12px">Module at full capacity — no space to plant</div>'}
      </div>`;
  }

  return '';
}

// ── Render Dashboard ─────────────────────────────────────────────────
function render() {
  const d = document.getElementById('dashboard');
  const totalCrops = state.modules.reduce((s, m) => s + m.crops.length, 0);
  const usedArea = state.modules.reduce((s, m) => s + m.crops.reduce((a, c) => a + c.area_m2, 0), 0);
  const totalArea = state.modules.reduce((s, m) => s + m.area_m2, 0);
  const missionPct = Math.round((state.mission.currentSol / state.mission.totalSols) * 100);
  const waterPct = Math.round((state.resources.water_liters / 5000) * 100);

  if (state.alerts.length > 0 && floraState === 'idle') floraState = 'alert';

  d.innerHTML = `
    <div class="d-layout">
      <!-- Narrow data sidebar -->
      <aside class="d-sidebar">
        <div class="d-sidebar-header">
          <span class="d-logo-text" id="logo-home" style="cursor:pointer">FLORA</span>
          <span class="d-sol">SOL ${state.mission.currentSol}<span class="d-sol-total">/${state.mission.totalSols}</span></span>
        </div>

        <div class="d-sidebar-tab ${activeTab === 'metrics' ? 'active' : ''}" data-tab="metrics">
          <div class="d-metric">
            <div class="d-metric-head"><span class="d-metric-label">Mission</span><span class="d-metric-value">${missionPct}%</span></div>
            ${bar(state.mission.currentSol, state.mission.totalSols, '#1a1a1a')}
          </div>
          <div class="d-metric">
            <div class="d-metric-head"><span class="d-metric-label">Nutrition</span><span class="d-metric-value ${state.nutrition.coverage_percent >= 80 ? '' : state.nutrition.coverage_percent >= 50 ? 'warn' : 'crit'}">${state.nutrition.coverage_percent}%</span></div>
            ${bar(state.nutrition.coverage_percent, 100, state.nutrition.coverage_percent >= 80 ? '#1a1a1a' : state.nutrition.coverage_percent >= 50 ? '#92400e' : '#991b1b')}
          </div>
          <div class="d-metric">
            <div class="d-metric-head"><span class="d-metric-label">Water</span><span class="d-metric-value ${waterPct > 40 ? '' : waterPct > 20 ? 'warn' : 'crit'}">${Math.round(state.resources.water_liters)}L</span></div>
          </div>
          <div class="d-metric">
            <div class="d-metric-head"><span class="d-metric-label">Area</span><span class="d-metric-value">${usedArea}/${totalArea}m²</span></div>
          </div>
        </div>

        ${state.modules.map((m, i) => {
          const used = m.crops.reduce((s, c) => s + c.area_m2, 0);
          return `
          <div class="d-sidebar-tab ${activeTab === 'module-' + i ? 'active' : ''}" data-tab="module-${i}">
            <div class="d-module-header">
              <span class="d-module-name">${m.name}</span>
              <span class="d-module-area">${used}/${m.area_m2}m²</span>
            </div>
            <div class="d-module-env">${m.temp}°C &middot; ${m.crops.length} crop${m.crops.length !== 1 ? 's' : ''}</div>
          </div>`;
        }).join('')}

        ${state.harvests.length > 0 ? `<div class="d-sidebar-tab ${activeTab === 'harvests' ? 'active' : ''}" data-tab="harvests">
          <div class="d-module-name">Harvests</div>
          <div class="d-module-env">${state.harvests.length} recorded</div>
        </div>` : ''}

        ${state.alerts.length > 0 ? `<div class="d-sidebar-tab d-sidebar-alert" data-tab="alerts">
          ${state.alerts.map(a => `<div class="d-alert">Sol ${a.sol} — ${a.message}</div>`).join('')}
        </div>` : ''}

        <div class="d-sidebar-footer">
          <button class="d-btn" id="btn-a1">+1 Sol</button>
          <button class="d-btn" id="btn-a10">+10</button>
          <button class="d-btn" id="btn-a30">+30</button>
        </div>
      </aside>

      <!-- Center: FLORA orb OR detail panel + chat -->
      <main class="d-center">
        ${activeTab
          ? renderDetailPanel()
          : `<div id="flora-avatar" class="flora-avatar-section">${renderAvatar()}</div>`
        }
        <div class="d-messages" id="d-messages">
          <div class="d-msg d-msg-agent"><div class="d-msg-text">FLORA online. Crop planning, resource optimization, and emergency response ready.</div></div>
        </div>
        <div class="d-input-area">
          <button class="d-mic ${isListening ? 'active' : ''}" id="d-mic">${isListening ? '||' : 'MIC'}</button>
          <input type="text" id="d-input" placeholder="Query FLORA..." autocomplete="off" />
          <button class="d-send" id="d-send">&rarr;</button>
        </div>
      </main>
    </div>`;

  // Wire events
  document.getElementById('btn-a1').onclick = () => { state = advanceSol(state, 1); render(); };
  document.getElementById('btn-a10').onclick = () => { state = advanceSol(state, 10); render(); };
  document.getElementById('btn-a30').onclick = () => { state = advanceSol(state, 30); render(); };
  document.getElementById('d-mic').onclick = () => isListening ? stopListening() : startListening();
  document.getElementById('d-send').onclick = () => {
    const v = document.getElementById('d-input').value.trim();
    if (v) { document.getElementById('d-input').value = ''; handleSend(v); }
  };
  document.getElementById('d-input').onkeydown = (e) => {
    if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) { e.target.value = ''; handleSend(v); } }
  };

  // Logo → back to orb view
  document.getElementById('logo-home').onclick = () => { activeTab = null; render(); };

  // Tab click handlers
  document.querySelectorAll('.d-sidebar-tab').forEach(tab => {
    tab.onclick = () => {
      const t = tab.dataset.tab;
      activeTab = (activeTab === t) ? null : t; // toggle
      render();
    };
  });

  // Detail close button
  const closeBtn = document.getElementById('detail-close');
  if (closeBtn) closeBtn.onclick = () => { activeTab = null; render(); };

  // Plant crop buttons
  state.modules.forEach((m, i) => {
    const btn = document.getElementById(`plant-btn-${i}`);
    if (btn) {
      btn.onclick = () => {
        const cropSelect = document.getElementById(`plant-crop-${i}`);
        const areaInput = document.getElementById(`plant-area-${i}`);
        const cropType = cropSelect.value;
        const area = parseInt(areaInput.value) || 4;
        state = plantCrop(state, m.id, cropType, area);
        render();
      };
    }
  });
}

// ── Chat Handler ─────────────────────────────────────────────────────
async function handleSend(text) {
  const msgs = document.getElementById('d-messages');
  msgs.innerHTML += `<div class="d-msg d-msg-user"><div class="d-msg-text">${md(text)}</div></div>`;
  msgs.innerHTML += `<div class="d-msg d-msg-loading" id="d-loading"><div class="d-msg-text"><span class="d-dots">...</span></div></div>`;
  msgs.scrollTop = msgs.scrollHeight;

  chatHistory.push({ role: 'user', content: text });
  setFloraState('thinking');

  try {
    const response = await sendToAgent(chatHistory, state);
    chatHistory.push({ role: 'assistant', content: response });
    document.getElementById('d-loading')?.remove();
    msgs.innerHTML += `<div class="d-msg d-msg-agent"><div class="d-msg-text">${md(response)}</div></div>`;

    speak(response);
    if (voiceSocket?.readyState === WebSocket.OPEN) setFloraState('idle');

    const actions = parseActions(response);
    if (actions.length > 0) {
      const id = 'act-' + Date.now();
      msgs.innerHTML += `<div class="d-msg d-msg-action" id="${id}"><div class="d-msg-text">
        <strong>${actions.length} action(s) recommended</strong>
        <button class="d-btn d-btn-apply" id="${id}-btn">Apply</button>
      </div></div>`;
      document.getElementById(`${id}-btn`).onclick = () => {
        state = applyActions(state, actions);
        render();
      };
    }
    msgs.scrollTop = msgs.scrollHeight;
  } catch (err) {
    document.getElementById('d-loading')?.remove();
    msgs.innerHTML += `<div class="d-msg d-msg-error"><div class="d-msg-text">Error: ${err.message}</div></div>`;
    chatHistory.pop();
    setFloraState('alert');
  }
}

// ── Styles ───────────────────────────────────────────────────────────
const STYLES = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root {
  --bg: #f5f3f0;
  --surface: #ffffff;
  --border: #d4d0cb;
  --border-light: #e8e5e0;
  --text: #1a1a1a;
  --text2: #888580;
  --text3: #b0ada8;
  --warn: #92400e;
  --crit: #991b1b;
  --mono: 'DM Mono', 'Courier New', monospace;
  --serif: 'Instrument Serif', Georgia, serif;
  --sans: 'DM Sans', system-ui, sans-serif;
}

html,body,#dashboard {
  width:100%;height:100%;overflow:hidden;
  background:var(--bg);color:var(--text);
  font-family:var(--sans);
  -webkit-font-smoothing:antialiased;
  font-size:14px;
}

/* ── Layout: sidebar + center ── */
.d-layout { display:flex;height:100%; }

/* ── Sidebar ── */
.d-sidebar {
  width:260px;flex-shrink:0;
  border-right:1px solid var(--border);
  background:var(--surface);
  display:flex;flex-direction:column;
  overflow-y:auto;
}
.d-sidebar-header {
  padding:16px 18px;
  border-bottom:1px solid var(--border);
  display:flex;align-items:baseline;justify-content:space-between;
}
.d-logo-text {
  font-family:var(--serif);
  font-size:1.5rem;
  letter-spacing:-0.02em;
}
.d-sol { font-family:var(--mono);font-size:0.75rem;font-weight:500;letter-spacing:0.04em; }
.d-sol-total { color:var(--text3);font-weight:300; }

.d-sidebar-tab {
  padding:12px 18px;
  border-bottom:1px solid var(--border-light);
  display:flex;flex-direction:column;gap:6px;
  cursor:pointer;
  transition:background 0.15s;
}
.d-sidebar-tab:hover { background:var(--border-light); }
.d-sidebar-tab.active { background:var(--bg);border-left:2px solid var(--text); }
.d-sidebar-alert { border-color:var(--crit);cursor:default; }
.d-sidebar-alert:hover { background:transparent; }

/* ── Detail Panel ── */
.detail-panel {
  padding:24px 28px;
  border-bottom:1px solid var(--border);
  overflow-y:auto;
  flex-shrink:0;
  max-height:50vh;
}
.detail-header {
  display:flex;justify-content:space-between;align-items:baseline;
  margin-bottom:20px;
}
.detail-title { font-family:var(--serif);font-size:1.3rem; }
.detail-close {
  border:1px solid var(--border);background:transparent;
  color:var(--text2);font-size:1rem;width:28px;height:28px;
  cursor:pointer;font-family:var(--sans);display:flex;align-items:center;justify-content:center;
}
.detail-close:hover { background:var(--border-light);color:var(--text); }
.detail-grid {
  display:grid;grid-template-columns:repeat(3,1fr);gap:1px;
  background:var(--border);border:1px solid var(--border);
  margin-bottom:16px;
}
.detail-item { background:var(--surface);padding:14px 16px; }
.detail-label { font-family:var(--mono);font-size:0.58rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--text2);margin-bottom:4px; }
.detail-value { font-family:var(--mono);font-size:1rem;font-weight:500;margin-bottom:4px; }
.detail-value.warn { color:var(--warn); }
.detail-value.crit { color:var(--crit); }
.detail-sub { font-family:var(--mono);font-size:0.55rem;color:var(--text3);margin-top:2px; }
.detail-crops { display:flex;flex-direction:column;gap:1px;background:var(--border);border:1px solid var(--border); }
.detail-crop { background:var(--surface);padding:12px 16px; }
.detail-crop-header { display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px; }
.detail-crop-name { font-size:0.82rem;font-weight:500; }
.detail-crop-pct { font-family:var(--mono);font-size:0.72rem;color:var(--text2); }
.detail-crop-meta { font-family:var(--mono);font-size:0.55rem;color:var(--text3);margin-top:4px; }
.detail-empty { font-family:var(--mono);font-size:0.65rem;color:var(--text3);padding:20px 0;text-align:center; }
.detail-section-title { font-family:var(--mono);font-size:0.58rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--text2);margin-bottom:8px; }
.detail-ascii { font-family:var(--mono);font-size:0.62rem;line-height:1.3;white-space:pre;color:var(--text2);margin-bottom:8px; }
.detail-ascii-legend { display:flex;gap:12px;font-family:var(--mono);font-size:0.5rem;color:var(--text3);margin-top:4px; }
.detail-two-col { display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:4px; }
.detail-env-list { display:flex;flex-direction:column; }
.detail-env-row { display:flex;justify-content:space-between;font-family:var(--mono);font-size:0.68rem;padding:5px 0;border-bottom:1px solid var(--border-light); }
.detail-crop-grid { display:flex;gap:1px;background:var(--border);border:1px solid var(--border);flex-wrap:wrap; }
.detail-crop-card { background:var(--surface);padding:12px 14px;text-align:center;min-width:80px;flex:1; }
.detail-crop-ascii { font-family:var(--mono);font-size:0.55rem;line-height:1.15;color:var(--text2);margin-bottom:4px; }
.detail-crop-card-name { font-size:0.72rem;font-weight:500; }
.detail-crop-card-meta { font-family:var(--mono);font-size:0.52rem;color:var(--text3);margin-top:2px; }

/* Plant controls */
.plant-controls { border:1px solid var(--border);padding:14px 16px;display:flex;flex-direction:column;gap:8px; }
.plant-select { font-family:var(--mono);font-size:0.68rem;padding:6px 8px;border:1px solid var(--border);background:var(--surface);color:var(--text);outline:none;width:100%; }
.plant-area-row { display:flex;align-items:center;gap:8px; }
.plant-label { font-family:var(--mono);font-size:0.6rem;color:var(--text2);white-space:nowrap; }
.plant-input { font-family:var(--mono);font-size:0.72rem;padding:4px 8px;border:1px solid var(--border);background:var(--surface);color:var(--text);width:60px;outline:none; }
.plant-avail { font-family:var(--mono);font-size:0.55rem;color:var(--text3); }
.plant-btn { align-self:flex-end;background:var(--text);color:var(--bg);border-color:var(--text); }
.plant-btn:hover { opacity:0.8;background:var(--text); }
.detail-list { display:flex;flex-direction:column; }
.detail-row {
  display:flex;gap:12px;align-items:baseline;
  padding:6px 0;border-bottom:1px solid var(--border-light);
  font-size:0.72rem;
}
.detail-row-label { font-family:var(--mono);font-size:0.62rem;color:var(--text2);min-width:50px; }
.detail-row-value { font-family:var(--mono);font-weight:500;margin-left:auto; }
.detail-row-sub { font-family:var(--mono);font-size:0.55rem;color:var(--text3); }
.d-sidebar-footer {
  padding:14px 18px;
  margin-top:auto;
  border-top:1px solid var(--border);
  display:flex;gap:4px;
}

/* ── Metrics ── */
.d-metric {}
.d-metric-head { display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px; }
.d-metric-label { font-family:var(--mono);font-size:0.58rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--text2); }
.d-metric-value { font-family:var(--mono);font-size:0.85rem;font-weight:500; }
.d-metric-value.warn { color:var(--warn); }
.d-metric-value.crit { color:var(--crit); }
.d-metric-detail { font-family:var(--mono);font-size:0.52rem;color:var(--text3);margin-top:3px; }

.bar-track { height:2px;background:var(--border-light);overflow:hidden; }
.bar-fill { height:100%;transition:width 0.4s ease; }

/* ── Modules in sidebar ── */
.d-module-header { display:flex;justify-content:space-between;align-items:baseline; }
.d-module-name { font-family:var(--mono);font-size:0.62rem;font-weight:500;text-transform:uppercase;letter-spacing:0.06em; }
.d-module-area { font-family:var(--mono);font-size:0.55rem;color:var(--text3); }
.d-module-env { font-family:var(--mono);font-size:0.52rem;color:var(--text2);margin:3px 0 6px;letter-spacing:0.02em; }
.d-crop { }
.d-crop-top { display:flex;justify-content:space-between;margin-bottom:2px; }
.d-crop-name { font-size:0.65rem;font-weight:500; }
.d-crop-pct { font-family:var(--mono);font-size:0.55rem;color:var(--text2); }
.d-crop-empty { font-family:var(--mono);font-size:0.55rem;color:var(--text3); }
.d-alert { font-family:var(--mono);font-size:0.58rem;color:var(--crit); }

/* ── Buttons ── */
.d-btn {
  padding:5px 12px;border:1px solid var(--border);background:transparent;
  color:var(--text);font-family:var(--mono);font-size:0.62rem;
  cursor:pointer;transition:background 0.15s;letter-spacing:0.04em;flex:1;text-align:center;
}
.d-btn:hover { background:var(--border-light); }
.d-btn-apply {
  margin-left:16px;padding:3px 12px;border:1px solid var(--text);
  background:var(--text);color:var(--bg);font-family:var(--mono);
  font-size:0.6rem;cursor:pointer;letter-spacing:0.04em;
}
.d-btn-apply:hover { opacity:0.8; }

/* ── Center: orb hero + chat ── */
.d-center {
  flex:1;display:flex;flex-direction:column;min-width:0;
}

/* ── Orb Avatar ── */
@keyframes morph-1{0%,100%{border-radius:60% 40% 30% 70%/60% 30% 70% 40%}50%{border-radius:30% 60% 70% 40%/50% 60% 30% 60%}}
@keyframes morph-2{0%,100%{border-radius:40% 60% 70% 30%/40% 50% 60% 50%}50%{border-radius:70% 30% 40% 60%/60% 40% 50% 40%}}
@keyframes morph-3{0%,100%{border-radius:70% 30% 50% 50%/30% 30% 70% 70%}50%{border-radius:30% 70% 50% 50%/70% 70% 30% 30%}}
@keyframes orbit-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
@keyframes inner-orbit{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}

.flora-avatar-section {
  padding:32px 24px 20px;
  display:flex;flex-direction:column;align-items:center;
  border-bottom:1px solid var(--border-light);
  flex-shrink:0;
}
.flora-orb-wrap {
  position:relative;width:160px;height:160px;
  display:flex;align-items:center;justify-content:center;
}
.flora-orb-container {
  position:relative;width:120px;height:120px;
  display:flex;align-items:center;justify-content:center;
}
.flora-blob {
  position:absolute;inset:0;
  transition:background 0.8s ease;
}
.blob-1 { animation:morph-1 8s ease-in-out infinite;filter:blur(16px); }
.blob-2 { animation:morph-2 10s ease-in-out infinite reverse;filter:blur(10px);inset:8px; }
.blob-3 {
  animation:morph-3 7s ease-in-out infinite;inset:16px;
  filter:blur(1px);
  border:1px solid rgba(0,0,0,0.06);
  display:flex;align-items:center;justify-content:center;
  transition:background 0.8s ease;
}
.flora-lotus {
  width:60px;height:60px;
  color:rgba(0,0,0,0.35);
}
.flora-svg { width:100%;height:100%;overflow:visible; }
.flora-orbit-inner { transform-origin:50px 50px;animation:inner-orbit 8s linear infinite; }

.flora-ring {
  position:absolute;inset:-6px;
  border:1px solid var(--border-light);
  border-radius:50%;
  animation:orbit-spin 12s linear infinite;
}
.flora-ring-dot {
  position:absolute;top:-2px;left:50%;width:4px;height:4px;margin-left:-2px;
  border-radius:50%;transition:background 0.6s;
}

.flora-status { text-align:center;margin-top:14px; }
.flora-status-label {
  font-family:var(--mono);font-size:0.6rem;font-weight:500;
  text-transform:uppercase;letter-spacing:0.14em;color:var(--text2);
}
.flora-status-sub { font-family:var(--mono);font-size:0.52rem;color:var(--text3);margin-top:2px; }

/* ── Messages ── */
.d-messages {
  flex:1;overflow-y:auto;
  padding:20px 32px;
  display:flex;flex-direction:column;gap:10px;
  max-width:680px;
  margin:0 auto;
  width:100%;
}
.d-msg { max-width:88%; }
.d-msg-user { align-self:flex-end; }
.d-msg-user .d-msg-text { background:var(--text);color:var(--bg);padding:10px 16px; }
.d-msg-agent .d-msg-text { background:transparent;border:1px solid var(--border);padding:10px 16px; }
.d-msg-text { font-size:0.78rem;line-height:1.6; }
.d-msg-text h2,.d-msg-text h3,.d-msg-text h4 { margin:6px 0 4px;font-family:var(--serif);font-size:0.9rem;font-weight:400; }
.d-msg-text strong { font-weight:600; }
.d-msg-text li { margin-left:16px;font-size:0.75rem; }
.d-msg-text code { background:var(--border-light);padding:1px 5px;font-family:var(--mono);font-size:0.68rem; }
.d-code { background:var(--bg);border:1px solid var(--border);padding:8px 10px;font-family:var(--mono);font-size:0.62rem;overflow-x:auto;white-space:pre-wrap;word-break:break-word; }
.d-msg-action .d-msg-text { background:transparent;border:1px solid var(--text);display:flex;align-items:center;justify-content:space-between;padding:8px 16px; }
.d-msg-error .d-msg-text { background:transparent;border:1px solid var(--crit);color:var(--crit);padding:10px 16px; }
.d-msg-system .d-msg-text { background:transparent;border:none;color:var(--text3);font-family:var(--mono);font-size:0.58rem;text-align:center;padding:4px;letter-spacing:0.06em; }
.d-msg-loading .d-msg-text { color:var(--text3);font-family:var(--mono); }
.d-dots { animation:pulse 1.4s infinite;letter-spacing:3px; }
@keyframes pulse { 0%,100%{opacity:0.2} 50%{opacity:1} }

/* ── Input ── */
.d-input-area {
  display:flex;gap:0;
  border-top:1px solid var(--border);
  flex-shrink:0;
  max-width:680px;
  margin:0 auto;
  width:100%;
}
.d-mic {
  width:56px;border:none;border-right:1px solid var(--border);
  background:transparent;color:var(--text2);
  font-family:var(--mono);font-size:0.6rem;letter-spacing:0.08em;
  cursor:pointer;transition:all 0.2s;flex-shrink:0;
}
.d-mic:hover { background:var(--border-light);color:var(--text); }
.d-mic.active { background:var(--text);color:var(--bg); }
#d-input {
  flex:1;padding:14px 18px;border:none;background:transparent;
  color:var(--text);font-family:var(--sans);font-size:0.82rem;outline:none;
}
#d-input::placeholder { color:var(--text3); }
.d-send {
  width:56px;border:none;border-left:1px solid var(--border);
  background:transparent;color:var(--text);font-size:1rem;
  cursor:pointer;transition:background 0.15s;flex-shrink:0;
}
.d-send:hover { background:var(--border-light); }

/* ── Scrollbar ── */
.d-sidebar::-webkit-scrollbar,.d-messages::-webkit-scrollbar { width:3px; }
.d-sidebar::-webkit-scrollbar-track,.d-messages::-webkit-scrollbar-track { background:transparent; }
.d-sidebar::-webkit-scrollbar-thumb,.d-messages::-webkit-scrollbar-thumb { background:var(--border);border-radius:0; }

/* ── Responsive ── */
@media(max-width:1100px) {
  .d-sidebar{width:220px}
}
@media(max-width:800px) {
  .d-layout{flex-direction:column}
  .d-sidebar{width:100%;flex-direction:row;flex-wrap:wrap;border-right:none;border-bottom:1px solid var(--border);max-height:30vh;overflow-y:auto}
  .d-sidebar-header{width:100%}
  .d-sidebar-section{flex:1;min-width:200px}
  .flora-orb-wrap{width:100px;height:100px}
  .flora-orb-container{width:80px;height:80px}
}
`;

// ── Init ─────────────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = STYLES;
document.head.appendChild(style);
render();
