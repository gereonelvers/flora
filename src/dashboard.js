import { sendToAgent, parseActions, runAutonomousScan } from './agent-client.js';
import { createInitialState, advanceSol, applyActions, plantCrop, saveState, loadState, resetState, CROP_DB } from './greenhouse.js';
import { scorePendingMutations, getSequenceWindow, getRefBase } from './dna.js';
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend } from 'chart.js';
Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend);

let state = createInitialState(); // overwritten by async init below
let chatHistory = [];
let isListening = false;
let floraState = 'idle'; // idle | listening | thinking | speaking | alert
let activeTab = 'metrics'; // default to mission overview
let suppressPoll = false; // suppress cross-device polling briefly after reset
// simStarted derived from state.mission.started (synced via server)
let chatOpen = false;
let chatMessages = []; // persist chat messages across renders: [{text, role}]

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
  chatMessages.push({ text, role });
  if (chatMessages.length > 50) chatMessages = chatMessages.slice(-50);
  // Update DOM if it exists
  const msgs = document.getElementById('d-messages');
  if (!msgs) return;
  const cls = role === 'user' ? 'd-msg-user' : role === 'system' ? 'd-msg-system' : 'd-msg-agent';
  msgs.innerHTML += `<div class="d-msg ${cls}"><div class="d-msg-text">${md(text)}</div></div>`;
  msgs.scrollTop = msgs.scrollHeight;
}

function renderChatMessages() {
  return chatMessages.map(m => {
    const cls = m.role === 'user' ? 'd-msg-user' : m.role === 'system' ? 'd-msg-system' : 'd-msg-agent';
    return `<div class="d-msg ${cls}"><div class="d-msg-text">${md(m.text)}</div></div>`;
  }).join('');
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
    idle:      ['rgba(34,197,94,0.45)','rgba(16,185,129,0.35)','rgba(74,222,128,0.50)'],
    listening: ['rgba(59,130,246,0.50)','rgba(34,211,238,0.40)','rgba(96,165,250,0.55)'],
    thinking:  ['rgba(120,113,108,0.45)','rgba(168,162,158,0.35)','rgba(87,83,78,0.50)'],
    speaking:  ['rgba(34,197,94,0.55)','rgba(22,163,74,0.45)','rgba(74,222,128,0.60)'],
    alert:     ['rgba(239,68,68,0.50)','rgba(249,115,22,0.40)','rgba(220,38,38,0.55)'],
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
    </div>`;
}

function updateAvatar() {
  const el = document.getElementById('flora-fab-orb');
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
    const allCrops = state.modules.flatMap(mod => mod.crops.map(c => ({ ...c, module: mod.name })));
    return `
      <div class="detail-panel">
        <div class="detail-header">
          <span class="detail-title">Mission Overview</span>
        </div>
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
            <div class="detail-sub">Recycling: ${Math.round((state.resources.water_recycling_efficiency || 0.92) * 100)}%</div>
            <div class="detail-sub">Crew need: ${state.crew?.daily_water_need || 22}L/sol</div>
            ${bar(state.resources.water_liters, 5000, '#1a1a1a')}
          </div>
          <div class="detail-item">
            <div class="detail-label">Energy Balance</div>
            <div class="detail-value ${(state.energy?.balance || 0) >= 0 ? '' : 'crit'}">${(state.energy?.balance || 0) >= 0 ? '+' : ''}${state.energy?.balance || 0} kWh</div>
            <div class="detail-sub">Solar: ${state.energy?.solar_production || 0} kWh</div>
            <div class="detail-sub">LEDs: -${state.energy?.led_consumption || 0} kWh</div>
            <div class="detail-sub">HVAC: -${state.energy?.hvac_consumption || 0} kWh</div>
            <div class="detail-sub">Systems: -${(state.energy?.systems_consumption || 0) + (state.energy?.crew_consumption || 0)} kWh</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Battery</div>
            <div class="detail-value">${Math.round(state.resources.energy_stored_kwh || 0)} kWh</div>
            ${bar(state.resources.energy_stored_kwh || 0, 1000, '#1a1a1a')}
          </div>
          <div class="detail-item">
            <div class="detail-label">Crew</div>
            <div class="detail-value">${state.mission.crew}</div>
            <div class="detail-sub">Morale: ${state.mission.morale || 80}%</div>
            <div class="detail-sub">Rations: ${Math.round(state.nutrition.food_reserves_days || 0)}d</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Active Events</div>
            <div class="detail-value">${(state.events || []).length}</div>
            ${(state.events || []).map(e => `<div class="detail-sub">${e.name}</div>`).join('')}
          </div>
        </div>
        ${allCrops.length > 0 ? `
        <div class="detail-section-title">Active Crops</div>
        <div class="detail-crop-grid">
          ${allCrops.map(c => {
            const info = CROP_DB[c.type];
            const pct = Math.round((c.daysGrown / info.cycle) * 100);
            return `<div class="detail-crop-card">
              <img class="detail-crop-icon" src="/icons/${c.type}.png" alt="${info.name}" />
              <div class="detail-crop-card-name">${info.name}</div>
              <div class="detail-crop-card-meta">${pct}% &middot; ${c.module}</div>
            </div>`;
          }).join('')}
        </div>
        <div class="detail-section-title" style="margin-top:16px">Daily Calorie Budget</div>
        <div class="detail-grid" style="grid-template-columns:1fr 1fr 1fr">
          <div class="detail-item">
            <div class="detail-label">Crew Need</div>
            <div class="detail-value">${(state.nutrition.daily_target_kcal || 10000).toLocaleString()}</div>
            <div class="detail-sub">kcal/sol (${(state.crew?.members || []).filter(m => m.alive).length} crew)</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Consumed Today</div>
            <div class="detail-value ${(state.nutrition.current_daily_kcal || 0) >= (state.nutrition.daily_target_kcal || 10000) * 0.8 ? '' : (state.nutrition.current_daily_kcal || 0) > 0 ? 'warn' : 'crit'}">${(state.nutrition.current_daily_kcal || 0).toLocaleString()}</div>
            <div class="detail-sub">kcal (${state.nutrition.coverage_percent || 0}% coverage)</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Food in Storage</div>
            <div class="detail-value ${(state.nutrition.food_stored_kcal || 0) > (state.nutrition.daily_target_kcal || 10000) * 7 ? '' : (state.nutrition.food_stored_kcal || 0) > 0 ? 'warn' : 'crit'}">${Math.round(state.nutrition.food_stored_kcal || 0).toLocaleString()}</div>
            <div class="detail-sub">kcal (~${Math.round((state.nutrition.food_stored_kcal || 0) / (state.nutrition.daily_target_kcal || 10000))}d supply)</div>
          </div>
        </div>
        <div class="detail-grid" style="grid-template-columns:1fr 1fr;margin-top:1px">
          <div class="detail-item">
            <div class="detail-label">Protein Today</div>
            <div class="detail-value">${state.nutrition.current_daily_protein_g || 0}g</div>
            <div class="detail-sub">of ${state.nutrition.daily_target_protein_g || 220}g target</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Emergency Rations</div>
            <div class="detail-value ${(state.nutrition.food_reserves_days || 0) > 10 ? '' : 'crit'}">${Math.round(state.nutrition.food_reserves_days || 0)}d</div>
            <div class="detail-sub">remaining</div>
          </div>
        </div>
        ${(state.nutrition.history || []).length >= 2 ? `
        <div class="detail-section-title" style="margin-top:16px">Calorie History</div>
        <div style="position:relative;height:180px;border:1px solid var(--border);background:#fff;padding:8px">
          <canvas id="cal-canvas"></canvas>
        </div>` : ''}` : '<div class="detail-empty">No crops planted across any module</div>'}
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

  if (activeTab === 'agent-log') {
    const actions = state.agentActions || [];
    return `
      <div class="detail-panel">
        <div class="detail-header">
          <span class="detail-title">FLORA Agent Log</span>
          <button class="detail-close" id="detail-close">&times;</button>
        </div>
        <div class="detail-sub" style="margin-bottom:12px">Proactive actions taken by FLORA to optimize greenhouse operations</div>
        <div class="detail-list">
          ${actions.length === 0 ? '<div class="detail-empty">No autonomous actions recorded yet. Advance sols to see FLORA respond to conditions.</div>' :
            actions.slice().reverse().map(a => `
              <div class="detail-row">
                <span class="detail-row-label">Sol ${a.sol}</span>
                <span>${a.action}</span>
              </div>
              <div style="padding:0 0 6px;font-size:0.58rem;color:var(--text3);font-family:var(--mono)">${a.reason}</div>
            `).join('')}
        </div>
      </div>`;
  }

  if (activeTab === 'crew') {
    const members = state.crew?.members || [];
    const alive = members.filter(m => m.alive);
    const daysOfFood = (state.nutrition.food_stored_kcal || 0) > 0
      ? Math.round((state.nutrition.food_stored_kcal || 0) / (state.nutrition.daily_target_kcal || 10000))
      : 0;
    return `
      <div class="detail-panel">
        <div class="detail-header">
          <span class="detail-title">Crew Status</span>
          <button class="detail-close" id="detail-close">&times;</button>
        </div>
        <div class="detail-grid" style="grid-template-columns:1fr 1fr 1fr;margin-bottom:16px">
          <div class="detail-item">
            <div class="detail-label">Alive</div>
            <div class="detail-value ${alive.length < 4 ? 'crit' : ''}">${alive.length} / ${members.length}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Food Storage</div>
            <div class="detail-value ${daysOfFood < 3 ? 'crit' : daysOfFood < 7 ? 'warn' : ''}">${daysOfFood}d</div>
            <div class="detail-sub">${Math.round(state.nutrition.food_stored_kcal || 0)} kcal</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Emergency Rations</div>
            <div class="detail-value ${(state.nutrition.food_reserves_days || 0) < 5 ? 'crit' : ''}">${Math.round(state.nutrition.food_reserves_days || 0)}d</div>
          </div>
        </div>
        <div class="detail-section-title">Crew Members</div>
        <div class="crew-list">
          ${members.map(m => {
            const healthColor = !m.alive ? 'var(--crit)' : m.health >= 80 ? '#15803d' : m.health >= 50 ? 'var(--warn)' : 'var(--crit)';
            const statusLabel = !m.alive ? 'DECEASED' : m.daysWithoutFood > 0 ? `STARVING (${m.daysWithoutFood}d)` : m.health >= 80 ? 'HEALTHY' : m.health >= 50 ? 'WEAKENED' : 'CRITICAL';
            return `
            <div class="crew-card ${!m.alive ? 'crew-dead' : ''}">
              <div class="crew-card-top">
                ${m.photo ? `<img class="crew-card-photo" src="${m.photo}" alt="${m.name}" />` : ''}
                <div class="crew-card-info">
                  <div class="crew-card-header">
                    <span class="crew-card-name">${m.name}</span>
                    <span class="crew-card-status" style="color:${healthColor}">${statusLabel}</span>
                  </div>
                  <div class="crew-card-role">${m.role}${m.activity ? ` · ${m.activity}` : ''}</div>
                </div>
              </div>
              <div class="crew-card-stats">
                <div class="crew-stat">
                  <span class="crew-stat-label">Health</span>
                  ${bar(m.alive ? m.health : 0, 100, healthColor)}
                  <span class="crew-stat-val">${m.alive ? m.health : 0}%</span>
                </div>
                <div class="crew-stat">
                  <span class="crew-stat-label">Daily need</span>
                  <span class="crew-stat-val">${m.kcal_need} kcal</span>
                </div>
                ${m.daysWithoutFood > 0 && m.alive ? `<div class="crew-stat"><span class="crew-stat-label" style="color:var(--crit)">Days without food</span><span class="crew-stat-val" style="color:var(--crit)">${m.daysWithoutFood}</span></div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  if (activeTab === 'dna') {
    const gen = state.genetics || { mutations: [], totalRadiationEvents: 0 };
    const mutations = gen.mutations || [];
    const scored = mutations.filter(m => m.scored);
    const pending = mutations.filter(m => !m.scored);
    const disruptive = scored.filter(m => m.interpretation === 'disruptive' || m.interpretation === 'suspicious');
    // Helix rungs — render 2 full rotations (36 rungs) so the scroll animation loops seamlessly
    const HELIX_COUNT = 18; // one full rotation
    const helixRungs = Array.from({ length: HELIX_COUNT * 2 }, (_, i) => {
      const phase = (i % HELIX_COUNT) * 20;
      const x = Math.sin(phase * Math.PI / 180) * 28;
      const z = Math.cos(phase * Math.PI / 180);
      const opacity = 0.25 + z * 0.25 + 0.25;
      const bases = ['A—T', 'T—A', 'G—C', 'C—G'];
      return `<div class="helix-rung" style="transform:translateX(${x}px);opacity:${opacity.toFixed(2)}"><span class="helix-dot helix-l" style="transform:scale(${(0.7+z*0.3).toFixed(2)})"></span><span class="helix-bond">${bases[i % 4]}</span><span class="helix-dot helix-r" style="transform:scale(${(0.7-z*0.3+0.6).toFixed(2)})"></span></div>`;
    }).join('');

    const interpretColor = (interp) => {
      if (interp === 'disruptive') return 'var(--crit)';
      if (interp === 'suspicious') return 'var(--warn)';
      if (interp === 'pending') return 'var(--text3)';
      if (interp === 'error') return 'var(--text3)';
      return '#15803d';
    };
    const interpretBg = (interp) => {
      if (interp === 'disruptive') return 'rgba(153,27,27,0.06)';
      if (interp === 'suspicious') return 'rgba(146,64,14,0.06)';
      return 'transparent';
    };
    const interpretLabel = (interp) => {
      if (interp === 'disruptive') return 'DISRUPTIVE — likely loss of function';
      if (interp === 'suspicious') return 'SUSPICIOUS — may affect protein';
      if (interp === 'neutral') return 'NEUTRAL — tolerated by model';
      if (interp === 'favorable') return 'FAVORABLE — model prefers variant';
      if (interp === 'pending') return 'PENDING — awaiting Evo 2 analysis';
      if (interp === 'error') return 'ERROR — scoring failed';
      return interp;
    };
    // Color-code each base in a sequence string
    const colorSeq = (seq) => seq.split('').map(b => `<span class="dna-base-inline dna-b-${b}">${b}</span>`).join('');

    const renderMutCard = (m) => {
      const color = interpretColor(m.interpretation);
      const bg = interpretBg(m.interpretation);
      const refBase = m.ref || getRefBase(m.pos);
      const sw = getSequenceWindow(m.pos, 20);

      // Build the sequence display: before [REF>ALT] after
      const seqBefore = colorSeq(sw.before);
      const seqAfter = colorSeq(sw.after);
      let seqMut;
      if (m.kind === 'del') {
        seqMut = `<span class="dna-seq-del" title="Deleted ${refBase}">${refBase}</span>`;
      } else {
        seqMut = `<span class="dna-seq-ref">${refBase}</span><span class="dna-seq-arrow">›</span><span class="dna-seq-alt ${m.interpretation === 'disruptive' || m.interpretation === 'suspicious' ? 'dna-seq-bad' : 'dna-seq-ok'}">${m.alt}</span>`;
      }

      // Probability bars (only for scored mutations)
      let probBars = '';
      if (m.scored && m.probabilities) {
        const maxP = Math.max(...Object.values(m.probabilities));
        probBars = `<div class="dna-prob-bars">${Object.entries(m.probabilities).map(([b, p]) => {
          const isRef = b === refBase;
          const isAlt = b === m.alt;
          const pct = Math.round(p * 100);
          const barW = Math.max(2, Math.round((p / maxP) * 100));
          return `<div class="dna-prob-bar-row">
            <span class="dna-prob-base dna-base-${b}">${b}</span>
            <div class="dna-prob-bar-track"><div class="dna-prob-bar-fill dna-bar-${b}" style="width:${barW}%"></div></div>
            <span class="dna-prob-pct">${pct.toFixed(1)}%</span>
            ${isRef ? '<span class="dna-tag dna-tag-ref">REF</span>' : ''}${isAlt ? '<span class="dna-tag dna-tag-alt">ALT</span>' : ''}
          </div>`;
        }).join('')}</div>`;
      }

      return `
        <div class="dna-mut-card" style="border-left:3px solid ${color};background:${bg}">
          <div class="dna-mut-header">
            <span class="dna-mut-crop">${CROP_DB[m.crop]?.name || m.crop}</span>
            <span class="dna-mut-interp" style="color:${color}">${m.interpretation?.toUpperCase() || 'PENDING'}</span>
            <span class="dna-mut-sol">Sol ${m.sol}</span>
          </div>
          <div class="dna-mut-change">
            <span class="dna-mut-kind">${m.kind === 'del' ? 'DELETION' : 'SNV'}</span>
            <span class="dna-mut-desc">${m.kind === 'del' ? `${refBase} deleted at` : `${refBase} → ${m.alt} at`} position ${m.pos.toLocaleString()} / 5,428</span>
          </div>
          <div class="dna-seq-view">
            <span class="dna-seq-pos">${sw.start}</span>${seqBefore}${seqMut}${seqAfter}<span class="dna-seq-pos">${sw.pos + 20}</span>
          </div>
          ${m.scored ? `
            <div class="dna-score-detail">
              <div class="dna-score-row">
                <span class="dna-score-label">Evo 2 verdict</span>
                <span class="dna-score-verdict" style="color:${color}">${interpretLabel(m.interpretation)}</span>
              </div>
              <div class="dna-score-row">
                <span class="dna-score-label">Effect score (Δ)</span>
                <span class="dna-score-val">${m.delta_score != null ? (m.delta_score > 0 ? '+' : '') + m.delta_score.toFixed(4) : '—'}</span>
              </div>
              ${m.ref_log_prob != null ? `<div class="dna-score-row"><span class="dna-score-label">Ref log-prob</span><span class="dna-score-val">${m.ref_log_prob.toFixed(4)}</span></div>` : ''}
              ${m.alt_log_prob != null ? `<div class="dna-score-row"><span class="dna-score-label">Alt log-prob</span><span class="dna-score-val">${m.alt_log_prob.toFixed(4)}</span></div>` : ''}
            </div>
            ${probBars}
          ` : '<div class="dna-pending-badge">Awaiting Evo 2 scoring...</div>'}
        </div>`;
    };

    return `
      <div class="detail-panel">
        <div class="detail-header">
          <span class="detail-title">DNA Mutation Analysis</span>
          <button class="detail-close" id="detail-close">&times;</button>
        </div>
        <div class="detail-sub" style="margin-bottom:16px">Evo 2 genomic foundation model scoring mutations in potato GBSS gene (X83220.1, 5,428 bp)</div>

        <div class="dna-top-row">
          <div class="dna-helix-col">
            <div class="dna-helix-wrap">
              <div class="dna-helix">${helixRungs}</div>
            </div>
            <div class="dna-helix-label">GBSS — Granule-bound starch synthase</div>
          </div>
          <div class="dna-stats-col">
            <div class="detail-grid" style="grid-template-columns:1fr 1fr">
              <div class="detail-item">
                <div class="detail-label">Total Mutations</div>
                <div class="detail-value">${mutations.length}</div>
                <div class="detail-sub">${pending.length} pending analysis</div>
              </div>
              <div class="detail-item">
                <div class="detail-label">Disruptive</div>
                <div class="detail-value ${disruptive.length > 0 ? 'crit' : ''}">${disruptive.length}</div>
                <div class="detail-sub">of ${scored.length} scored</div>
              </div>
              <div class="detail-item">
                <div class="detail-label">Radiation Events</div>
                <div class="detail-value">${gen.totalRadiationEvents}</div>
                <div class="detail-sub">cumulative since Sol 1</div>
              </div>
              <div class="detail-item">
                <div class="detail-label">Gene</div>
                <div class="detail-value" style="font-size:0.78rem">GBSS</div>
                <div class="detail-sub">5,428 bp · potato</div>
              </div>
            </div>
            ${pending.length > 0 ? `<button class="d-btn dna-score-btn" id="dna-score-btn">Score ${pending.length} pending with Evo 2</button>` : ''}
          </div>
        </div>

        ${mutations.length > 0 ? `
        <div class="detail-section-title" style="margin-top:20px">Mutation Log</div>
        <div class="dna-mutation-list">
          ${mutations.slice().reverse().map(m => renderMutCard(m)).join('')}
        </div>` : '<div class="detail-empty">No mutations detected yet. Advance sols — Mars radiation will cause DNA damage in crops over time.</div>'}
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

// ── Sol Advance + Proactive AI ───────────────────────────────────────
let lastAnalysisSol = 0;
let prevHarvestCount = 0;

let floraRunning = false; // prevent concurrent agent calls

function advanceAndAnalyze(days) {
  const prevEvents = (state.events || []).length;
  state = advanceSol(state, days);
  saveState(state);
  render();

  // Trigger autonomous FLORA scan based on:
  // 1. FLORA's own wake schedule (next_check_sol)
  // 2. Emergency triggers (regardless of schedule)
  const hasNewEvents = (state.events || []).length > prevEvents;
  const crewStarving = (state.crew?.members || []).some(m => m.alive && m.daysWithoutFood > 0);
  const emptyOnlineModules = state.modules.some(m =>
    (!m.onlineSol || state.mission.currentSol >= m.onlineSol) && m.crops.length === 0
  );
  const newHarvests = state.harvests.length > (prevHarvestCount || 0);
  prevHarvestCount = state.harvests.length;

  // FLORA's self-scheduled wake-up
  const nextCheck = state.floraNextCheckSol || (lastAnalysisSol + 5);
  const scheduledWake = state.mission.currentSol >= nextCheck;

  // Emergency triggers always wake FLORA
  const emergency = hasNewEvents || crewStarving || emptyOnlineModules;

  if (!floraRunning && (emergency || scheduledWake || newHarvests)) {
    lastAnalysisSol = state.mission.currentSol;
    runFloraAutonomous();
  }

  // Auto-score new DNA mutations in background
  const pendingMuts = (state.genetics?.mutations || []).filter(m => !m.scored);
  if (pendingMuts.length > 0) {
    scorePendingMutations(state).then(updated => {
      if (JSON.stringify(updated.genetics) !== JSON.stringify(state.genetics)) {
        state = updated;
        saveState(state);
        render();
      }
    }).catch(() => {});
  }
}

let lastFloraLogLen = 0; // track flora log length to detect new entries

async function runFloraAutonomous() {
  if (floraRunning) return;
  floraRunning = true;
  setFloraState('thinking');
  appendChatMsg(`[FLORA autonomous scan — Sol ${state.mission.currentSol}]`, 'system');

  try {
    // Fire-and-forget: Lambda applies actions server-side even if HTTP times out
    const result = await runAutonomousScan(state);

    if (result && result.autoActions.length > 0) {
      // If response came back in time, also apply client-side for instant feedback
      state = applyActions(state, result.autoActions);
      saveState(state);
    }

    if (result?.summary) {
      appendChatMsg(result.summary, 'agent');
    } else {
      appendChatMsg('FLORA is analyzing the greenhouse state...', 'system');
    }

    setFloraState('idle');
    render();
  } catch (err) {
    appendChatMsg('FLORA analysis running in background...', 'system');
    setFloraState('idle');
  }

  floraRunning = false;
}

// Check for new floraLog entries from server (Lambda writes these directly)
function checkFloraLog() {
  const log = state.floraLog || [];
  if (log.length > lastFloraLogLen) {
    const newEntries = log.slice(lastFloraLogLen);
    lastFloraLogLen = log.length;
    for (const entry of newEntries) {
      if (entry.actions && entry.actions.length > 0) {
        const summary = entry.actions.map(a => {
          if (a.type === 'plant') return `Planted ${a.crop} in Module ${a.module} (${a.area_m2}m²)`;
          if (a.type === 'adjust_temperature') return `Set Module ${a.module} temp to ${a.value}°C`;
          return `${a.type} on Module ${a.module}`;
        }).join(', ');
        appendChatMsg(`**FLORA acted on Sol ${entry.sol}:** ${summary}`, 'agent');
      }
      if (entry.response) {
        // Show truncated reasoning
        const short = entry.response.replace(/```json[\s\S]*?```/g, '').trim().slice(0, 300);
        if (short) appendChatMsg(short, 'agent');
      }
    }
  }
}

// ── Calorie Chart (Chart.js) ─────────────────────────────────────────
let calChart = null;
function drawCalorieChart() {
  const canvas = document.getElementById('cal-canvas');
  if (!canvas) return;
  const hist = state.nutrition?.history || [];
  if (hist.length < 2) return;

  if (calChart) { calChart.destroy(); calChart = null; }

  calChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: hist.map(h => `Sol ${h.sol}`),
      datasets: [
        {
          label: 'Consumed',
          data: hist.map(h => h.consumed),
          borderColor: '#1a1a1a',
          backgroundColor: 'rgba(26,26,26,0.07)',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#1a1a1a',
          fill: true,
          tension: 0.3,
        },
        {
          label: 'Need',
          data: hist.map(h => h.need),
          borderColor: '#b0ada8',
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
        {
          label: 'Stored (÷5)',
          data: hist.map(h => (h.stored || 0) / 5),
          borderColor: '#15803d',
          borderWidth: 1.5,
          pointRadius: 2,
          pointBackgroundColor: '#15803d',
          fill: false,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { family: "'DM Mono', monospace", size: 10 }, boxWidth: 14, boxHeight: 2, padding: 12, color: '#888580' },
        },
        tooltip: {
          backgroundColor: '#1a1a1a',
          titleFont: { family: "'DM Mono', monospace", size: 11 },
          bodyFont: { family: "'DM Mono', monospace", size: 10 },
          padding: 10,
          cornerRadius: 2,
          callbacks: {
            label: (ctx) => {
              const idx = ctx.dataIndex;
              const d = hist[idx];
              if (ctx.datasetIndex === 0) return `Consumed: ${d.consumed.toLocaleString()} kcal`;
              if (ctx.datasetIndex === 1) return `Need: ${d.need.toLocaleString()} kcal`;
              return `Stored: ${(d.stored || 0).toLocaleString()} kcal`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: '#e8e5e0' },
          ticks: { font: { family: "'DM Mono', monospace", size: 9 }, color: '#b0ada8', maxRotation: 0 },
        },
        y: {
          beginAtZero: true,
          grid: { color: '#e8e5e0' },
          ticks: {
            font: { family: "'DM Mono', monospace", size: 9 }, color: '#b0ada8',
            callback: (v) => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v,
          },
        },
      },
    },
  });
}

// ── Render Dashboard ─────────────────────────────────────────────────
function render() {
  const d = document.getElementById('dashboard');

  // ── Start screen (before simulation begins) ──
  // Guard against incomplete state from server — fill ALL missing fields with defaults
  if (!state.mission) state.mission = { name: 'Asterion Four', currentSol: 1, totalSols: 450, crew: 4, phase: 'Pre-planting', morale: 80, started: false };
  if (!state.modules) state.modules = [];
  for (const m of state.modules) { if (!m.crops) m.crops = []; } // ensure every module has crops array
  if (!state.resources) state.resources = { water_liters: 5000, water_recycling_efficiency: 0.92, energy_kwh_daily: 200, energy_stored_kwh: 800, solar_efficiency: 1.0, co2_kg: 50 };
  if (!state.energy) state.energy = { solar_production: 0, led_consumption: 0, hvac_consumption: 0, systems_consumption: 40, crew_consumption: 20, balance: 0 };
  if (!state.nutrition) state.nutrition = { daily_target_kcal: 10000, daily_target_protein_g: 220, current_daily_kcal: 0, current_daily_protein_g: 0, coverage_percent: 0, food_reserves_days: 30, food_stored_kcal: 0, food_stored_protein: 0 };
  if (!state.crew) state.crew = { daily_water_need: 22, daily_kcal_need: 10000, daily_protein_need: 220, members: [] };
  if (!state.crew.members) state.crew.members = [];
  if (!state.genetics) state.genetics = { mutations: [], totalRadiationEvents: 0 };
  if (!state.harvests) state.harvests = [];
  if (!state.events) state.events = [];
  if (!state.agentActions) state.agentActions = [];

  if (!state.mission.started) {
    d.innerHTML = `
      <div class="start-screen" id="start-screen">
        <div class="start-content">
          <div class="start-logo">FLORA</div>
          <div class="start-sub">Frontier Life-support Operations & Resource Agent</div>
          <div class="start-desc">Autonomous greenhouse management for the Asterion Four Mars habitat</div>
          <button class="start-btn" id="start-btn">Initialize Mission</button>
          <div class="start-meta">450-day surface mission · Valles Marineris · 4 crew</div>
        </div>
      </div>`;
    document.getElementById('start-btn').onclick = () => {
      const screen = document.getElementById('start-screen');
      screen.classList.add('start-booting');
      let flickers = 0;
      const interval = setInterval(() => {
        screen.style.opacity = Math.random() > 0.5 ? '1' : '0.3';
        flickers++;
        if (flickers > 8) {
          clearInterval(interval);
          screen.style.opacity = '1';
          state.mission.started = true;
          saveState(state);
          render();
        }
      }, 100);
    };
    return;
  }

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
        </div>

        <div class="d-sidebar-tab ${activeTab === 'metrics' ? 'active' : ''}" data-tab="metrics">
          <div class="d-metric">
            <div class="d-metric-head"><span class="d-metric-label">Nutrition</span><span class="d-metric-value ${state.nutrition.coverage_percent >= 80 ? '' : state.nutrition.coverage_percent >= 50 ? 'warn' : 'crit'}">${state.nutrition.coverage_percent}%</span></div>
            ${bar(state.nutrition.coverage_percent, 100, state.nutrition.coverage_percent >= 80 ? '#1a1a1a' : state.nutrition.coverage_percent >= 50 ? '#92400e' : '#991b1b')}
          </div>
          <div class="d-metric">
            <div class="d-metric-head"><span class="d-metric-label">Water</span><span class="d-metric-value ${waterPct > 40 ? '' : waterPct > 20 ? 'warn' : 'crit'}">${Math.round(state.resources.water_liters)}L</span></div>
          </div>
          <div class="d-metric">
            <div class="d-metric-head"><span class="d-metric-label">Energy</span><span class="d-metric-value ${(state.energy?.balance || 0) >= 0 ? '' : 'crit'}">${state.energy?.balance >= 0 ? '+' : ''}${state.energy?.balance || 0} kWh</span></div>
          </div>
          <div class="d-metric">
            <div class="d-metric-head"><span class="d-metric-label">Morale</span><span class="d-metric-value ${(state.mission.morale || 80) >= 70 ? '' : 'warn'}">${state.mission.morale || 80}</span></div>
          </div>
        </div>

        <div class="d-sidebar-tab ${activeTab === 'crew' ? 'active' : ''} ${(state.crew?.members || []).some(m => !m.alive || m.health < 50) ? 'd-sidebar-event' : ''}" data-tab="crew">
          <div class="d-module-header">
            <span class="d-module-name">Crew</span>
            <span class="d-module-area">${(state.crew?.members || []).filter(m => m.alive).length}/${(state.crew?.members || []).length}</span>
          </div>
          <div class="d-module-env">${(state.crew?.members || []).filter(m => m.alive).map(m => m.name.split(' ').pop()).join(' · ')}</div>
        </div>

        ${state.modules.map((m, i) => {
          const used = m.crops.reduce((s, c) => s + c.area_m2, 0);
          const avgHealth = m.crops.length > 0 ? Math.round(m.crops.reduce((s, c) => s + (c.health || 100), 0) / m.crops.length) : 0;
          const hasEvent = (state.events || []).some(e => e.module === m.id);
          const isOnline = !m.onlineSol || state.mission.currentSol >= m.onlineSol;
          return `
          <div class="d-sidebar-tab ${activeTab === 'module-' + i ? 'active' : ''} ${hasEvent ? 'd-sidebar-event' : ''}" data-tab="module-${i}">
            <div class="d-module-header">
              <span class="d-module-status ${isOnline ? 'd-status-online' : 'd-status-offline'}"></span>
              <span class="d-module-name">${hasEvent ? '! ' : ''}${m.name}</span>
              <span class="d-module-area">${isOnline ? `${used}/${m.area_m2}m²` : 'OFFLINE'}</span>
            </div>
            <div class="d-module-env">${isOnline ? `${m.temp}°C &middot; ${m.crops.length} crop${m.crops.length !== 1 ? 's' : ''}${m.crops.length > 0 ? ` &middot; ${avgHealth}% health` : ''}` : `Deploying Sol ${m.onlineSol}...`}</div>
          </div>`;
        }).join('')}

        <div class="d-sidebar-tab ${activeTab === 'dna' ? 'active' : ''} ${(state.genetics?.mutations || []).some(m => m.interpretation === 'disruptive') ? 'd-sidebar-event' : ''}" data-tab="dna">
          <div class="d-module-header">
            <span class="d-module-name">DNA Analysis</span>
            <span class="d-module-area">${(state.genetics?.mutations || []).length} mut</span>
          </div>
          <div class="d-module-env">Evo 2 · GBSS gene · ${(state.genetics?.mutations || []).filter(m => !m.scored).length} pending</div>
        </div>

        ${(state.events || []).length > 0 ? `<div class="d-sidebar-tab d-sidebar-alert">
          <div class="d-module-name">Active Events</div>
          ${state.events.map(e => `<div class="d-alert">${e.name} (${e.sol_end - state.mission.currentSol}d left)</div>`).join('')}
        </div>` : ''}

        ${(state.agentActions || []).length > 0 ? `<div class="d-sidebar-tab ${activeTab === 'agent-log' ? 'active' : ''}" data-tab="agent-log">
          <div class="d-module-name">FLORA Actions</div>
          <div class="d-module-env">${state.agentActions.length} recent</div>
        </div>` : ''}

        ${state.harvests.length > 0 ? `<div class="d-sidebar-tab ${activeTab === 'harvests' ? 'active' : ''}" data-tab="harvests">
          <div class="d-module-name">Harvests</div>
          <div class="d-module-env">${state.harvests.length} recorded</div>
        </div>` : ''}

      </aside>

      <!-- Center: detail panel (always shows content, defaults to metrics) -->
      <main class="d-center">
        <div class="d-topbar">
          <div class="d-topbar-progress"><div class="d-topbar-fill" style="width:${Math.round((state.mission.currentSol / state.mission.totalSols) * 100)}%"></div></div>
          <span class="d-topbar-sol">SOL ${state.mission.currentSol} / ${state.mission.totalSols} · ${state.mission.phase}</span>
          <span class="d-topbar-clock-wrap">
            <span class="d-topbar-clock" id="d-clock">00:00</span>
            <div class="d-speed-menu" id="d-speed-menu">
            <div class="d-speed-opt" data-speed="0">⏸ Pause</div>
            <div class="d-speed-opt" data-speed="1">1× Real</div>
            <div class="d-speed-opt" data-speed="1500">1.5k×</div>
            <div class="d-speed-opt" data-speed="5000">5k×</div>
            <div class="d-speed-opt" data-speed="15000">15k×</div>
          </div>
          </span>
        </div>
        ${renderDetailPanel()}
      </main>
    </div>
    <div class="flora-chat-panel ${chatOpen ? 'flora-chat-open' : ''}" id="flora-chat-panel">
      <div class="flora-chat-header">
        <span class="flora-chat-title">FLORA</span>
        <span class="flora-chat-state">${FLORA_STATES[floraState].label}</span>
        <button class="flora-chat-close" id="flora-chat-close">&times;</button>
      </div>
      ${floraRunning ? '<div class="flora-status-bar"><span class="flora-status-dot"></span> Analyzing greenhouse state via knowledge base...</div>' : ''}
      <div class="d-messages" id="d-messages">
        <div class="d-msg d-msg-agent"><div class="d-msg-text">FLORA online. Autonomous greenhouse management active.</div></div>
        ${(state.floraJournal || []).map(j => `
          <div class="d-msg d-msg-journal">
            <div class="d-msg-text">
              <div class="journal-header">Sol ${j.sol}${j.next_check ? ` · next scan: Sol ${j.next_check}` : ''}</div>
              ${j.entry}
            </div>
          </div>
        `).join('')}
        ${renderChatMessages()}
      </div>
      <div class="d-input-area">
        <button class="d-mic ${isListening ? 'active' : ''}" id="d-mic">${isListening ? '||' : 'MIC'}</button>
        <input type="text" id="d-input" placeholder="Query FLORA..." autocomplete="off" />
        <button class="d-send" id="d-send">&rarr;</button>
      </div>
    </div>
    <div class="flora-fab ${chatOpen ? 'flora-fab-hidden' : ''} ${isListening ? 'flora-fab-active' : ''} ${floraRunning ? 'flora-fab-thinking' : ''}" id="flora-fab">
      <div id="flora-fab-orb">${renderAvatar()}</div>
      ${floraRunning ? '<div class="flora-fab-label">Thinking...</div>' : ''}
    </div>`;

  // Wire events
  document.getElementById('d-mic').onclick = () => isListening ? stopListening() : startListening();
  document.getElementById('flora-fab').onclick = () => {
    chatOpen = true;
    document.getElementById('flora-chat-panel').classList.add('flora-chat-open');
    document.getElementById('flora-fab').classList.add('flora-fab-hidden');
    document.getElementById('d-input').focus();
  };
  document.getElementById('flora-chat-close').onclick = () => {
    chatOpen = false;
    document.getElementById('flora-chat-panel').classList.remove('flora-chat-open');
    document.getElementById('flora-fab').classList.remove('flora-fab-hidden');
  };
  document.getElementById('d-send').onclick = () => {
    const v = document.getElementById('d-input').value.trim();
    if (v) { document.getElementById('d-input').value = ''; handleSend(v); }
  };
  document.getElementById('d-input').onkeydown = (e) => {
    if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) { e.target.value = ''; handleSend(v); } }
  };

  // Logo → back to metrics
  document.getElementById('logo-home').onclick = () => { activeTab = 'metrics'; render(); };

  // Speed menu on clock click
  const clockEl = document.getElementById('d-clock');
  const speedMenu = document.getElementById('d-speed-menu');
  if (clockEl && speedMenu) {
    clockEl.onclick = (e) => { e.stopPropagation(); speedMenu.classList.toggle('open'); };
    speedMenu.querySelectorAll('.d-speed-opt').forEach(opt => {
      opt.onclick = async () => {
        const s = parseInt(opt.dataset.speed);
        speedMenu.classList.remove('open');
        // Fetch latest state to avoid overwriting 3D view's solFraction
        try {
          const latest = await loadState();
          if (latest) state = latest;
        } catch {}
        // Only change speed — don't touch solFraction or its timestamp
        state.mission.simSpeed = s;
        saveState(state);
      };
    });
    document.addEventListener('click', () => speedMenu.classList.remove('open'));
  }

  // Reset handled from 3D view — dashboard picks it up via polling

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
  if (closeBtn) closeBtn.onclick = () => { activeTab = 'metrics'; render(); };

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
        saveState(state);
        render();
      };
    }
  });

  // Render calorie chart on Canvas (after DOM is ready)
  drawCalorieChart();

  // DNA: score pending mutations with Evo 2
  const dnaBtn = document.getElementById('dna-score-btn');
  if (dnaBtn) {
    dnaBtn.onclick = async () => {
      dnaBtn.textContent = 'Scoring with Evo 2...';
      dnaBtn.disabled = true;
      try {
        state = await scorePendingMutations(state);
        saveState(state);
        render();
      } catch (err) {
        dnaBtn.textContent = 'Error — retry';
        dnaBtn.disabled = false;
      }
    };
  }
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
        saveState(state);
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
.d-sidebar-alert { border-color:var(--crit); }
.d-sidebar-event { border-left:2px solid var(--warn); }

/* ── Detail Panel ── */
.detail-panel {
  padding:24px 28px;
  border-bottom:1px solid var(--border);
  overflow-y:auto;
  flex:1;
  min-height:0;
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
.detail-ascii { font-family:var(--mono);font-size:0.82rem;line-height:1.35;white-space:pre;color:var(--text2);margin-bottom:10px; }
.detail-ascii-legend { display:flex;gap:14px;font-family:var(--mono);font-size:0.58rem;color:var(--text3);margin-top:6px; }
.detail-two-col { display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:4px; }
.detail-env-list { display:flex;flex-direction:column; }
.detail-env-row { display:flex;justify-content:space-between;font-family:var(--mono);font-size:0.68rem;padding:5px 0;border-bottom:1px solid var(--border-light); }
.detail-crop-grid { display:flex;gap:1px;background:var(--border);border:1px solid var(--border);flex-wrap:wrap; }
.detail-crop-card { background:var(--surface);padding:12px 14px;text-align:center;min-width:80px;flex:1; }
.detail-crop-icon { width:36px;height:36px;object-fit:contain;margin-bottom:4px;opacity:0.7; }
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
.d-btn-reset { flex:none;width:100%;color:var(--crit);border-color:var(--border); }
.d-btn-reset:hover { border-color:var(--crit); }
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

/* ── Center ── */
.d-center {
  flex:1;display:flex;flex-direction:column;min-width:0;
}
.d-center-empty {
  flex:1;display:flex;align-items:center;justify-content:center;
}
.d-center-empty-text {
  font-family:var(--mono);font-size:0.68rem;color:var(--text3);letter-spacing:0.04em;
}

/* ── Orb Avatar ── */
@keyframes morph-1{0%,100%{border-radius:60% 40% 30% 70%/60% 30% 70% 40%}50%{border-radius:30% 60% 70% 40%/50% 60% 30% 60%}}
@keyframes morph-2{0%,100%{border-radius:40% 60% 70% 30%/40% 50% 60% 50%}50%{border-radius:70% 30% 40% 60%/60% 40% 50% 40%}}
@keyframes morph-3{0%,100%{border-radius:70% 30% 50% 50%/30% 30% 70% 70%}50%{border-radius:30% 70% 50% 50%/70% 70% 30% 30%}}
@keyframes orbit-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
@keyframes inner-orbit{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}

/* ── FLORA FAB ── */
.flora-fab {
  position:fixed;bottom:24px;right:24px;
  width:60px;height:60px;border-radius:50%;
  cursor:pointer;z-index:100;
  display:flex;align-items:center;justify-content:center;
  background:transparent;
  border:none;
  box-shadow:none;
  transition:transform 0.2s;
  overflow:visible;
}
.flora-fab:hover {
  box-shadow:none;
  transform:scale(1.08);
}
.flora-fab-active {
  border:none;
  box-shadow:none;
}
.flora-fab-hidden {
  opacity:0;transform:scale(0.5);pointer-events:none;
}

/* ── FLORA Chat Panel ── */
.flora-chat-panel {
  position:fixed;bottom:24px;right:24px;
  width:420px;height:520px;max-height:calc(100vh - 48px);
  background:var(--surface);
  border:1px solid var(--border);
  box-shadow:0 8px 40px rgba(0,0,0,0.12);
  display:flex;flex-direction:column;
  z-index:99;
  opacity:0;
  transform:translateY(20px) scale(0.95);
  transform-origin:bottom right;
  pointer-events:none;
  transition:opacity 0.25s ease,transform 0.25s ease;
  border-radius:12px;
  overflow:hidden;
}
.flora-chat-panel.flora-chat-open {
  opacity:1;
  transform:translateY(0) scale(1);
  pointer-events:auto;
}
.flora-chat-header {
  display:flex;align-items:center;gap:10px;
  padding:14px 18px;
  border-bottom:1px solid var(--border);
  flex-shrink:0;
}
.flora-chat-title {
  font-family:var(--serif);font-size:1.1rem;
}
.flora-chat-state {
  font-family:var(--mono);font-size:0.52rem;color:var(--text3);
  text-transform:uppercase;letter-spacing:0.1em;
}
.flora-chat-close {
  margin-left:auto;
  border:1px solid var(--border);background:transparent;
  color:var(--text2);font-size:1rem;width:28px;height:28px;
  cursor:pointer;display:flex;align-items:center;justify-content:center;
  border-radius:6px;
}
.flora-chat-close:hover { background:var(--border-light);color:var(--text); }
.flora-chat-panel .d-messages {
  max-width:none;padding:16px 18px;
}
.flora-chat-panel .d-input-area {
  max-width:none;border-radius:0 0 12px 12px;
}
#flora-fab-orb {
  width:110px;height:110px;
  transform:scale(0.52);
  transform-origin:center;
  pointer-events:none;
  flex-shrink:0;
}
.flora-orb-wrap {
  position:relative;width:110px;height:110px;
  display:flex;align-items:center;justify-content:center;
}
.flora-orb-container {
  position:relative;width:85px;height:85px;
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
  width:46px;height:46px;
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

/* ── DNA Panel ── */
.dna-top-row { display:flex;gap:24px;align-items:flex-start; }
.dna-helix-col { flex-shrink:0;display:flex;flex-direction:column;align-items:center; }
.dna-stats-col { flex:1;min-width:0;display:flex;flex-direction:column;gap:12px; }
.dna-helix-wrap {
  width:120px;height:220px;overflow:hidden;position:relative;
  display:flex;flex-direction:column;justify-content:center;gap:2px;
}
.dna-helix { display:flex;flex-direction:column;gap:2px;animation:helix-scroll 6s linear infinite; }
@keyframes helix-scroll {
  0% { transform:translateY(0); }
  100% { transform:translateY(-252px); }
}
.helix-rung {
  display:flex;align-items:center;justify-content:center;gap:0;height:12px;
  transition:transform 0.3s,opacity 0.3s;
}
.helix-dot {
  width:8px;height:8px;border-radius:50%;flex-shrink:0;
  transition:transform 0.3s;
}
.helix-l { background:#2563eb; }
.helix-r { background:#dc2626; }
.helix-bond {
  font-family:var(--mono);font-size:0.42rem;letter-spacing:0.05em;
  color:var(--text3);width:36px;text-align:center;flex-shrink:0;
}
.dna-helix-label {
  font-family:var(--mono);font-size:0.5rem;color:var(--text3);
  text-align:center;margin-top:8px;letter-spacing:0.06em;
}
.dna-score-btn {
  width:100%;background:var(--text) !important;color:var(--bg) !important;
  border-color:var(--text) !important;padding:8px 16px !important;
  font-size:0.62rem !important;letter-spacing:0.06em;
}
.dna-score-btn:hover { opacity:0.85; }
.dna-score-btn:disabled { opacity:0.5;cursor:wait; }

.dna-mutation-list { display:flex;flex-direction:column;gap:8px; }
.dna-mut-card {
  padding:12px 16px;border:1px solid var(--border);
  transition:background 0.2s;
}
.dna-mut-header {
  display:flex;align-items:baseline;gap:8px;margin-bottom:6px;
}
.dna-mut-crop { font-size:0.75rem;font-weight:500; }
.dna-mut-interp {
  font-family:var(--mono);font-size:0.52rem;font-weight:600;
  letter-spacing:0.08em;
}
.dna-mut-sol { font-family:var(--mono);font-size:0.55rem;color:var(--text3);margin-left:auto; }
.dna-mut-change {
  display:flex;align-items:baseline;gap:8px;margin-bottom:8px;
}
.dna-mut-kind {
  font-family:var(--mono);font-size:0.52rem;font-weight:500;
  padding:2px 7px;border:1px solid var(--border);letter-spacing:0.08em;
  background:var(--bg);
}
.dna-mut-desc { font-family:var(--mono);font-size:0.62rem;color:var(--text2); }

/* Sequence viewer with colored bases */
.dna-seq-view {
  font-family:var(--mono);font-size:0.65rem;letter-spacing:0.08em;
  margin-bottom:8px;padding:6px 10px;background:var(--bg);border:1px solid var(--border-light);
  overflow-x:auto;white-space:nowrap;line-height:1.6;
}
.dna-seq-pos { font-size:0.48rem;color:var(--text3);margin:0 4px;vertical-align:middle; }
.dna-base-inline { font-weight:400; }
.dna-b-A { color:#2563eb; }
.dna-b-T { color:#dc2626; }
.dna-b-G { color:#15803d; }
.dna-b-C { color:#d97706; }
.dna-seq-ref {
  font-weight:700;text-decoration:line-through;opacity:0.5;
}
.dna-seq-arrow { color:var(--text3);margin:0 1px;font-size:0.72rem; }
.dna-seq-alt { font-weight:700;padding:0 2px; }
.dna-seq-bad { color:#dc2626;background:rgba(220,38,38,0.1);border-radius:1px; }
.dna-seq-ok { color:#15803d;background:rgba(21,128,61,0.1);border-radius:1px; }
.dna-seq-del { font-weight:700;color:#dc2626;text-decoration:line-through;background:rgba(220,38,38,0.1);padding:0 2px; }

/* Score details */
.dna-score-detail {
  display:flex;flex-direction:column;gap:2px;margin-bottom:8px;
}
.dna-score-row {
  display:flex;justify-content:space-between;align-items:baseline;
  font-family:var(--mono);font-size:0.58rem;
  padding:2px 0;
}
.dna-score-label { color:var(--text3); }
.dna-score-val { color:var(--text);font-weight:500; }
.dna-score-verdict { font-weight:500;font-size:0.55rem; }

/* Probability bars */
.dna-prob-bars { display:flex;flex-direction:column;gap:3px; }
.dna-prob-bar-row {
  display:flex;align-items:center;gap:6px;
}
.dna-prob-base {
  font-family:var(--mono);font-size:0.52rem;font-weight:600;
  width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;
  border-radius:2px;color:#fff;flex-shrink:0;
}
.dna-base-A { background:#2563eb; }
.dna-base-T { background:#dc2626; }
.dna-base-G { background:#15803d; }
.dna-base-C { background:#d97706; }
.dna-prob-bar-track { flex:1;height:6px;background:var(--border-light);overflow:hidden; }
.dna-prob-bar-fill { height:100%;transition:width 0.4s; }
.dna-bar-A { background:#2563eb; }
.dna-bar-T { background:#dc2626; }
.dna-bar-G { background:#15803d; }
.dna-bar-C { background:#d97706; }
.dna-prob-pct { font-family:var(--mono);font-size:0.52rem;color:var(--text2);min-width:36px;text-align:right; }
.dna-tag {
  font-family:var(--mono);font-size:0.42rem;font-weight:600;
  padding:1px 4px;border-radius:2px;letter-spacing:0.06em;
}
.dna-tag-ref { background:var(--border-light);color:var(--text2); }
.dna-tag-alt { background:rgba(220,38,38,0.1);color:#dc2626; }
.dna-pending-badge {
  font-family:var(--mono);font-size:0.55rem;color:var(--text3);
  padding:6px 0;letter-spacing:0.04em;font-style:italic;
}

/* ── Calorie chart ── */
.cal-legend {
  display:flex;gap:16px;margin-top:8px;
  font-family:var(--mono);font-size:0.52rem;color:var(--text2);
}
.cal-swatch {
  display:inline-block;width:12px;height:2px;vertical-align:middle;
  margin-right:4px;border:1px solid transparent;
}

/* ── FLORA journal entries ── */
.d-msg-journal .d-msg-text {
  background:transparent;border:1px solid var(--border-light);border-left:2px solid var(--text2);
  padding:8px 14px;font-size:0.72rem;line-height:1.5;
}
.journal-header {
  font-family:var(--mono);font-size:0.52rem;font-weight:500;
  text-transform:uppercase;letter-spacing:0.08em;color:var(--text3);margin-bottom:4px;
}

/* ── FLORA FAB thinking state ── */
.flora-fab-thinking {
  animation:flora-fab-pulse 2s infinite;
}
@keyframes flora-fab-pulse {
  0%,100% { box-shadow:0 0 0 0 rgba(168,85,247,0.3); }
  50% { box-shadow:0 0 0 12px rgba(168,85,247,0); }
}
.flora-fab-label {
  position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);
  font-family:var(--mono);font-size:0.48rem;color:var(--text2);
  white-space:nowrap;letter-spacing:0.06em;
}

/* ── FLORA status bar ── */
.flora-status-bar {
  padding:8px 28px;border-bottom:1px solid var(--border-light);
  font-family:var(--mono);font-size:0.58rem;color:var(--text2);
  display:flex;align-items:center;gap:8px;
  background:rgba(34,197,94,0.04);
}
.flora-status-dot {
  width:6px;height:6px;border-radius:50%;background:#22c55e;
  animation:flora-pulse 1.5s infinite;
}
@keyframes flora-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
.flora-last-action {
  padding:4px 28px;border-bottom:1px solid var(--border-light);
  font-family:var(--mono);font-size:0.52rem;color:var(--text3);
}

/* ── Crew cards ── */
.crew-list { display:flex;flex-direction:column;gap:6px; }
.crew-card {
  padding:12px 16px;border:1px solid var(--border);
  border-left:3px solid #15803d;
}
.crew-card.crew-dead { opacity:0.45;border-left-color:var(--crit); }
.crew-card-top { display:flex;gap:12px;align-items:center;margin-bottom:8px; }
.crew-card-photo {
  width:48px;height:48px;border-radius:50%;object-fit:cover;flex-shrink:0;
  border:2px solid var(--border);
}
.crew-card-info { flex:1;min-width:0; }
.crew-card-header { display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px; }
.crew-card-name { font-size:0.78rem;font-weight:500; }
.crew-card-status { font-family:var(--mono);font-size:0.52rem;font-weight:600;letter-spacing:0.06em; }
.crew-card-role { font-family:var(--mono);font-size:0.55rem;color:var(--text2); }
.crew-card-stats { display:flex;flex-direction:column;gap:4px; }
.crew-stat { display:flex;align-items:center;gap:8px; }
.crew-stat-label { font-family:var(--mono);font-size:0.52rem;color:var(--text3);min-width:80px; }
.crew-stat-val { font-family:var(--mono);font-size:0.58rem;font-weight:500;min-width:50px;text-align:right; }
.crew-stat .bar-track { flex:1; }

/* ── Top bar (sol + clock) ── */
.d-topbar {
  display:flex;align-items:center;gap:12px;
  padding:10px 28px;border-bottom:1px solid var(--border-light);
  flex-shrink:0;
}
.d-topbar-progress {
  flex:1;height:3px;background:var(--border-light);border-radius:1px;overflow:hidden;
}
.d-topbar-fill {
  height:100%;background:var(--text);border-radius:1px;transition:width 0.5s;
}
.d-topbar-sol { font-family:var(--mono);font-size:0.58rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text2);white-space:nowrap; }
.d-topbar-clock-wrap { position:relative; }
.d-topbar-clock {
  font-family:var(--mono);font-size:0.78rem;font-weight:500;letter-spacing:0.06em;
  color:var(--text);white-space:nowrap;cursor:pointer;position:relative;
}
.d-topbar-clock:hover { color:var(--text2); }
.d-speed-menu {
  position:absolute;top:100%;right:0;margin-top:6px;
  background:var(--surface);border:1px solid var(--border);
  box-shadow:0 4px 12px rgba(0,0,0,0.08);
  display:none;z-index:50;min-width:100px;
}
.d-speed-menu.open { display:block; }
.d-speed-opt {
  padding:7px 14px;font-family:var(--mono);font-size:0.6rem;
  color:var(--text);cursor:pointer;letter-spacing:0.04em;
  transition:background 0.1s;
}
.d-speed-opt:hover { background:var(--bg); }

/* ── Module online/offline indicator ── */
.d-module-status {
  width:6px;height:6px;border-radius:50%;flex-shrink:0;
  margin-right:4px;display:inline-block;
}
.d-status-online { background:#22c55e;box-shadow:0 0 4px rgba(34,197,94,0.5); }
.d-status-offline { background:var(--text3);opacity:0.4; }

/* ── Start Screen ── */
.start-screen {
  display:flex;align-items:center;justify-content:center;
  width:100%;height:100%;
  background:var(--bg);
  transition:opacity 0.1s;
}
.start-content {
  text-align:center;max-width:400px;padding:40px;
}
.start-logo {
  font-family:var(--serif);font-size:3.5rem;
  letter-spacing:-0.03em;color:var(--text);
  margin-bottom:4px;
}
.start-sub {
  font-family:var(--mono);font-size:0.6rem;
  text-transform:uppercase;letter-spacing:0.14em;
  color:var(--text2);margin-bottom:24px;
}
.start-desc {
  font-family:var(--sans);font-size:0.82rem;
  color:var(--text2);line-height:1.6;margin-bottom:32px;
}
.start-btn {
  padding:12px 36px;
  border:1px solid var(--text);background:var(--text);color:var(--bg);
  font-family:var(--mono);font-size:0.72rem;font-weight:500;
  letter-spacing:0.08em;text-transform:uppercase;
  cursor:pointer;transition:opacity 0.15s;
}
.start-btn:hover { opacity:0.85; }
.start-meta {
  font-family:var(--mono);font-size:0.5rem;
  color:var(--text3);margin-top:20px;letter-spacing:0.06em;
}
.start-booting {
  background:#0a0a0a;color:#22c55e;
}
.start-booting .start-logo { color:#22c55e; }
.start-booting .start-sub,.start-booting .start-desc,.start-booting .start-meta { color:#166534; }
.start-booting .start-btn { display:none; }

/* ── Responsive ── */
@media(max-width:1100px) {
  .d-sidebar{width:220px}
}
@media(max-width:800px) {
  .d-layout{flex-direction:column}
  .d-sidebar{width:100%;flex-direction:row;flex-wrap:wrap;border-right:none;border-bottom:1px solid var(--border);max-height:30vh;overflow-y:auto}
  .d-sidebar-header{width:100%}
  .d-sidebar-section{flex:1;min-width:200px}
  .flora-fab{bottom:16px;right:16px;width:52px;height:52px}
  #flora-fab-orb{transform:scale(0.44)}
  .flora-chat-panel{width:calc(100vw - 32px);right:16px;bottom:16px;height:60vh}
}
`;

// ── Init ─────────────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = STYLES;
document.head.appendChild(style);

// Load state from server, then render
(async () => {
  const saved = await loadState();
  if (saved) {
    if (!saved.genetics) saved.genetics = { mutations: [], totalRadiationEvents: 0 };
    state = saved;
    // If resuming a mission already in progress, skip start screen
    // Ensure started flag exists for old states
    if (!('started' in state.mission)) state.mission.started = state.mission.currentSol > 1;
  }
  render();

  // Trigger initial FLORA scan if mission is running and modules are empty
  if (state.mission.started) {
    const emptyOnline = state.modules.some(m =>
      (!m.onlineSol || state.mission.currentSol >= m.onlineSol) && m.crops.length === 0
    );
    if (emptyOnline && !floraRunning) {
      setTimeout(() => runFloraAutonomous(), 1000);
    }
  }
})();

// Mars clock — interpolates from server state's solFraction + simSpeed + elapsed time
setInterval(() => {
  if (!state.mission?.started) return;
  const el = document.getElementById('d-clock');
  if (!el) return;
  const baseFrac = state.mission.solFraction || 0;
  const speed = state.mission.simSpeed ?? 1500;
  const updatedAt = state.mission.solFractionUpdatedAt || Date.now();
  const elapsed = (Date.now() - updatedAt) / 1000;
  const frac = (baseFrac + (elapsed / 88775) * speed) % 1;
  const hours = Math.floor(frac * 24.65);
  const minutes = Math.floor((frac * 24.65 - hours) * 60);
  el.textContent = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}, 250);

// Poll server for changes every 3s (cross-device sync)
// Also triggers FLORA autonomous scans when sol advances
setInterval(async () => {
  if (suppressPoll) return;
  const saved = await loadState();
  if (saved && JSON.stringify(saved) !== JSON.stringify(state)) {
    const prevSol = state.mission.currentSol;
    // Preserve started flag — never regress from true to false via polling
    if (state.mission?.started && !saved.mission?.started) {
      saved.mission.started = true;
    }
    state = saved;
    if (saved.mission.currentSol < prevSol) {
      window.__flora3d?.resetSolFraction?.();
    }
    render();
    checkFloraLog(); // pick up background FLORA actions

    // Check if FLORA should run after sol change
    if (state.mission.started && saved.mission.currentSol > prevSol) {
      const nextCheck = state.floraNextCheckSol || (lastAnalysisSol + 5);
      const scheduledWake = state.mission.currentSol >= nextCheck;
      const crewStarving = (state.crew?.members || []).some(m => m.alive && m.daysWithoutFood > 0);
      const emptyOnline = state.modules.some(m =>
        (!m.onlineSol || state.mission.currentSol >= m.onlineSol) && m.crops.length === 0
      );
      if (!floraRunning && (crewStarving || emptyOnline || scheduledWake)) {
        lastAnalysisSol = state.mission.currentSol;
        runFloraAutonomous();
      }
    }
  }
}, 3000);

// start/stop synced via server state polling above
