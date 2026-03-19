import { sendToAgent, parseActions } from './agent-client.js';
import { createInitialState, advanceSol, applyActions, CROP_DB } from './greenhouse.js';

let state = createInitialState();
let chatHistory = [];
let isListening = false;
let floraState = 'idle'; // idle | listening | thinking | speaking | alert

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

// ── FLORA Avatar ─────────────────────────────────────────────────────
function renderAvatar() {
  const s = FLORA_STATES[floraState];

  // ASCII art plant that subtly shifts per state
  const asciiPlants = {
    idle:      `     .     \n    .|.    \n   .|.|.   \n  .|.|.|.  \n    |||    \n    |||    \n  ~~~~~   `,
    listening: `     *     \n    *|*    \n   *|.|*   \n  *|.|.|*  \n    |||    \n    |||    \n  ~~~~~   `,
    thinking:  `     .     \n    ..     \n   ...     \n  ....     \n    |||    \n    |||    \n  ~~~~~   `,
    speaking:  `     o     \n    o|o    \n   o|.|o   \n  o|.|.|o  \n    |||    \n    |||    \n  ~~~~~   `,
    alert:     `     !     \n    !|!    \n   !|.|!   \n  !|.|.|!  \n    |||    \n    |||    \n  ~~~~~   `,
  };

  return `
    <div class="flora-indicator" style="color:${s.stateColor}">
      <pre class="flora-ascii">${asciiPlants[floraState]}</pre>
    </div>
    <div class="flora-status">
      <div class="flora-status-label" style="color:${s.stateColor}">${s.label}</div>
      <div class="flora-status-sub">${s.sub}</div>
    </div>`;
}

function updateAvatar() {
  const el = document.getElementById('flora-avatar');
  if (el) el.innerHTML = renderAvatar();
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
      <header class="d-header">
        <div class="d-logo">
          <span class="d-logo-text">FLORA</span>
          <span class="d-logo-sub">Frontier Life-support Operations & Resource Agent</span>
        </div>
        <div class="d-header-center">
          <span class="d-sol">SOL ${state.mission.currentSol}<span class="d-sol-total">/${state.mission.totalSols}</span></span>
          <span class="d-phase">${state.mission.phase}</span>
        </div>
        <div class="d-header-right">
          <button class="d-btn" id="btn-a1">+1</button>
          <button class="d-btn" id="btn-a10">+10</button>
          <button class="d-btn" id="btn-a30">+30</button>
        </div>
      </header>

      <div class="d-main">
        <div class="d-left">
          <div class="d-metrics">
            <div class="d-metric">
              <div class="d-metric-head"><span class="d-metric-label">Mission</span><span class="d-metric-value">${missionPct}%</span></div>
              ${bar(state.mission.currentSol, state.mission.totalSols, '#1a1a1a')}
              <div class="d-metric-detail">${state.mission.totalSols - state.mission.currentSol} sols remaining</div>
            </div>
            <div class="d-metric">
              <div class="d-metric-head"><span class="d-metric-label">Nutrition</span><span class="d-metric-value ${state.nutrition.coverage_percent >= 80 ? '' : state.nutrition.coverage_percent >= 50 ? 'warn' : 'crit'}">${state.nutrition.coverage_percent}%</span></div>
              ${bar(state.nutrition.coverage_percent, 100, state.nutrition.coverage_percent >= 80 ? '#1a1a1a' : state.nutrition.coverage_percent >= 50 ? '#92400e' : '#991b1b')}
              <div class="d-metric-detail">${state.nutrition.current_daily_kcal} kcal / ${state.nutrition.daily_target_kcal} target</div>
            </div>
            <div class="d-metric">
              <div class="d-metric-head"><span class="d-metric-label">Water Reserve</span><span class="d-metric-value ${waterPct > 40 ? '' : waterPct > 20 ? 'warn' : 'crit'}">${Math.round(state.resources.water_liters)}L</span></div>
              ${bar(state.resources.water_liters, 5000, waterPct > 40 ? '#1a1a1a' : waterPct > 20 ? '#92400e' : '#991b1b')}
            </div>
            <div class="d-metric">
              <div class="d-metric-head"><span class="d-metric-label">Cultivation</span><span class="d-metric-value">${usedArea}/${totalArea} m²</span></div>
              ${bar(usedArea, totalArea, '#1a1a1a')}
              <div class="d-metric-detail">${totalCrops} active crop${totalCrops !== 1 ? 's' : ''}</div>
            </div>
          </div>

          <div class="d-modules">
            ${state.modules.map(m => {
              const used = m.crops.reduce((s, c) => s + c.area_m2, 0);
              return `
              <div class="d-module">
                <div class="d-module-header">
                  <span class="d-module-name">${m.name}</span>
                  <span class="d-module-area">${used}/${m.area_m2} m²</span>
                </div>
                <div class="d-module-env">
                  ${m.temp}°C &middot; ${m.humidity}% RH &middot; ${m.light} µmol &middot; ${m.co2} ppm CO₂
                </div>
                <div class="d-crops">
                  ${m.crops.length === 0 ? '<div class="d-crop-empty">— no crops —</div>' :
                    m.crops.map(c => {
                      const info = CROP_DB[c.type];
                      const pct = Math.round((c.daysGrown / info.cycle) * 100);
                      return `<div class="d-crop">
                        <div class="d-crop-top"><span class="d-crop-name">${info.name}</span><span class="d-crop-pct">${pct}%</span></div>
                        ${bar(c.daysGrown, info.cycle, '#1a1a1a')}
                        <div class="d-crop-detail">${c.area_m2} m² &middot; ${info.cycle - c.daysGrown}d to harvest</div>
                      </div>`;
                    }).join('')}
                </div>
              </div>`;
            }).join('')}
          </div>

          ${state.harvests.length > 0 ? `<div class="d-harvests"><div class="d-section-title">Harvest Log</div>
            <div class="d-harvest-list">${state.harvests.slice(-5).reverse().map(h =>
              `<div class="d-harvest"><span class="d-harvest-sol">Sol ${h.sol}</span> ${h.crop} — ${h.yield_kg} kg</div>`).join('')}
            </div></div>` : ''}

          ${state.alerts.length > 0 ? `<div class="d-alerts">${state.alerts.map(a =>
            `<div class="d-alert">Sol ${a.sol} — ${a.message}</div>`).join('')}</div>` : ''}
        </div>

        <!-- Right: FLORA + Chat -->
        <div class="d-right">
          <div id="flora-avatar" class="flora-avatar-section">${renderAvatar()}</div>
          <div class="d-messages" id="d-messages">
            <div class="d-msg d-msg-agent"><div class="d-msg-text">FLORA online. Crop planning, resource analysis, and emergency response ready. How can I assist?</div></div>
          </div>
          <div class="d-input-area">
            <button class="d-mic ${isListening ? 'active' : ''}" id="d-mic">${isListening ? '||' : 'MIC'}</button>
            <input type="text" id="d-input" placeholder="Query FLORA..." autocomplete="off" />
            <button class="d-send" id="d-send">&rarr;</button>
          </div>
        </div>
      </div>
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

/* ── Layout ── */
.d-layout { display:flex;flex-direction:column;height:100%; }

/* ── Header ── */
.d-header {
  display:flex;align-items:center;justify-content:space-between;
  padding:12px 28px;
  border-bottom:1px solid var(--border);
  background:var(--surface);
  flex-shrink:0;
}
.d-logo { display:flex;align-items:baseline;gap:12px; }
.d-logo-text {
  font-family:var(--serif);
  font-size:1.6rem;
  letter-spacing:-0.02em;
  color:var(--text);
}
.d-logo-sub {
  font-family:var(--mono);
  font-size:0.6rem;
  color:var(--text3);
  letter-spacing:0.02em;
}
.d-header-center {
  display:flex;align-items:baseline;gap:16px;
}
.d-sol {
  font-family:var(--mono);
  font-size:1.1rem;font-weight:500;
  letter-spacing:0.04em;
}
.d-sol-total { color:var(--text3);font-weight:300; }
.d-phase {
  font-family:var(--mono);
  font-size:0.65rem;
  text-transform:uppercase;
  letter-spacing:0.12em;
  color:var(--text2);
  padding:2px 10px;
  border:1px solid var(--border);
}
.d-header-right { display:flex;gap:4px; }

/* ── Buttons ── */
.d-btn {
  padding:5px 14px;
  border:1px solid var(--border);
  background:transparent;
  color:var(--text);
  font-family:var(--mono);
  font-size:0.68rem;
  cursor:pointer;
  transition:background 0.15s;
  letter-spacing:0.04em;
}
.d-btn:hover { background:var(--border-light); }
.d-btn-apply {
  margin-left:16px;
  padding:3px 12px;
  border:1px solid var(--text);
  background:var(--text);
  color:var(--bg);
  font-family:var(--mono);
  font-size:0.65rem;
  cursor:pointer;
  letter-spacing:0.04em;
}
.d-btn-apply:hover { opacity:0.8; }

/* ── Main ── */
.d-main { display:flex;flex:1;min-height:0; }

/* ── Left ── */
.d-left {
  flex:1;overflow-y:auto;padding:24px 28px;
  display:flex;flex-direction:column;gap:20px;
}

/* ── Metrics ── */
.d-metrics { display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);border:1px solid var(--border); }
.d-metric { background:var(--surface);padding:16px 18px; }
.d-metric-head { display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px; }
.d-metric-label {
  font-family:var(--mono);
  font-size:0.6rem;
  text-transform:uppercase;
  letter-spacing:0.1em;
  color:var(--text2);
}
.d-metric-value {
  font-family:var(--mono);
  font-size:1.1rem;
  font-weight:500;
}
.d-metric-value.warn { color:var(--warn); }
.d-metric-value.crit { color:var(--crit); }
.d-metric-detail { font-family:var(--mono);font-size:0.58rem;color:var(--text3);margin-top:6px; }

/* ── Bars ── */
.bar-track { height:2px;background:var(--border-light);overflow:hidden; }
.bar-fill { height:100%;transition:width 0.4s ease; }

/* ── Modules ── */
.d-modules { display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border:1px solid var(--border); }
.d-module { background:var(--surface);padding:16px 18px; }
.d-module-header { display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px; }
.d-module-name { font-family:var(--mono);font-size:0.72rem;font-weight:500;text-transform:uppercase;letter-spacing:0.06em; }
.d-module-area { font-family:var(--mono);font-size:0.62rem;color:var(--text3); }
.d-module-env {
  font-family:var(--mono);font-size:0.58rem;color:var(--text2);
  padding:6px 0 8px;margin-bottom:8px;border-bottom:1px solid var(--border-light);
  letter-spacing:0.02em;
}
.d-crops { display:flex;flex-direction:column;gap:8px; }
.d-crop-empty { font-family:var(--mono);font-size:0.62rem;color:var(--text3);padding:8px 0;text-align:center; }
.d-crop-top { display:flex;justify-content:space-between;margin-bottom:3px; }
.d-crop-name { font-size:0.72rem;font-weight:500; }
.d-crop-pct { font-family:var(--mono);font-size:0.62rem;color:var(--text2); }
.d-crop-detail { font-family:var(--mono);font-size:0.55rem;color:var(--text3);margin-top:3px; }

/* ── Harvests ── */
.d-harvests { border:1px solid var(--border);background:var(--surface);padding:16px 18px; }
.d-section-title { font-family:var(--mono);font-size:0.6rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--text2);margin-bottom:8px; }
.d-harvest-list { display:flex;flex-direction:column;gap:3px; }
.d-harvest { font-family:var(--mono);font-size:0.62rem;color:var(--text2); }
.d-harvest-sol { color:var(--text); }

/* ── Alerts ── */
.d-alerts { display:flex;flex-direction:column;gap:1px;background:var(--border);border:1px solid var(--crit); }
.d-alert { padding:10px 18px;font-family:var(--mono);font-size:0.65rem;background:var(--surface);color:var(--crit); }

/* ── Right Panel ── */
.d-right {
  width:380px;flex-shrink:0;
  display:flex;flex-direction:column;
  border-left:1px solid var(--border);
  background:var(--surface);
}

/* ── Avatar ── */
.flora-avatar-section {
  padding:24px;
  display:flex;flex-direction:column;align-items:center;
  border-bottom:1px solid var(--border-light);
  flex-shrink:0;
}
.flora-indicator {
  transition:color 0.8s ease;
}
.flora-ascii {
  font-family:var(--mono);
  font-size:0.7rem;
  line-height:1.1;
  text-align:center;
  white-space:pre;
  transition:opacity 0.5s;
  letter-spacing:0.1em;
}
.flora-status { text-align:center;margin-top:12px; }
.flora-status-label {
  font-family:var(--mono);
  font-size:0.62rem;
  font-weight:500;
  text-transform:uppercase;
  letter-spacing:0.14em;
  transition:color 0.5s;
}
.flora-status-sub {
  font-family:var(--mono);
  font-size:0.55rem;
  color:var(--text3);
  margin-top:3px;
}

/* ── Messages ── */
.d-messages { flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px; }
.d-msg { max-width:92%; }
.d-msg-user { align-self:flex-end; }
.d-msg-user .d-msg-text {
  background:var(--text);color:var(--bg);
  border-radius:0;padding:10px 14px;
}
.d-msg-agent .d-msg-text {
  background:transparent;
  border:1px solid var(--border);
  border-radius:0;padding:10px 14px;
}
.d-msg-text { font-size:0.78rem;line-height:1.6; }
.d-msg-text h2,.d-msg-text h3,.d-msg-text h4 { margin:6px 0 4px;font-family:var(--serif);font-size:0.9rem;font-weight:400;color:var(--text); }
.d-msg-text strong { font-weight:600; }
.d-msg-text li { margin-left:16px;font-size:0.75rem; }
.d-msg-text code {
  background:var(--border-light);padding:1px 5px;
  font-family:var(--mono);font-size:0.68rem;
}
.d-code {
  background:var(--bg);border:1px solid var(--border);
  padding:8px 10px;
  font-family:var(--mono);font-size:0.62rem;
  overflow-x:auto;white-space:pre-wrap;word-break:break-word;
}
.d-msg-action .d-msg-text {
  background:transparent;border:1px solid var(--text);
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 14px;
}
.d-msg-error .d-msg-text {
  background:transparent;border:1px solid var(--crit);color:var(--crit);
  padding:10px 14px;
}
.d-msg-system .d-msg-text {
  background:transparent;border:none;
  color:var(--text3);
  font-family:var(--mono);font-size:0.6rem;text-align:center;
  padding:4px;letter-spacing:0.06em;
}
.d-msg-loading .d-msg-text { color:var(--text3);font-family:var(--mono); }
.d-dots { animation:pulse 1.4s infinite;letter-spacing:3px; }
@keyframes pulse { 0%,100%{opacity:0.2} 50%{opacity:1} }

/* ── Input ── */
.d-input-area {
  display:flex;gap:0;
  border-top:1px solid var(--border);
  flex-shrink:0;
}
.d-mic {
  width:56px;
  border:none;border-right:1px solid var(--border);
  background:transparent;
  color:var(--text2);
  font-family:var(--mono);
  font-size:0.6rem;
  letter-spacing:0.08em;
  cursor:pointer;
  transition:all 0.2s;
  flex-shrink:0;
}
.d-mic:hover { background:var(--border-light);color:var(--text); }
.d-mic.active {
  background:var(--text);color:var(--bg);
}
#d-input {
  flex:1;padding:12px 16px;
  border:none;
  background:transparent;
  color:var(--text);
  font-family:var(--sans);
  font-size:0.8rem;
  outline:none;
}
#d-input::placeholder { color:var(--text3); }
.d-send {
  width:56px;
  border:none;border-left:1px solid var(--border);
  background:transparent;
  color:var(--text);
  font-size:1rem;
  cursor:pointer;
  transition:background 0.15s;
  flex-shrink:0;
}
.d-send:hover { background:var(--border-light); }

/* ── Scrollbar ── */
.d-left::-webkit-scrollbar,.d-messages::-webkit-scrollbar { width:3px; }
.d-left::-webkit-scrollbar-track,.d-messages::-webkit-scrollbar-track { background:transparent; }
.d-left::-webkit-scrollbar-thumb,.d-messages::-webkit-scrollbar-thumb { background:var(--border);border-radius:0; }

/* ── Responsive ── */
@media(max-width:1100px) {
  .d-metrics{grid-template-columns:repeat(2,1fr)}
  .d-modules{grid-template-columns:1fr 1fr}
  .d-right{width:320px}
  .d-logo-sub{display:none}
}
@media(max-width:800px) {
  .d-main{flex-direction:column}
  .d-right{width:100%;border-left:none;border-top:1px solid var(--border);max-height:45vh}
  .d-modules{grid-template-columns:1fr}
}
`;

// ── Init ─────────────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = STYLES;
document.head.appendChild(style);
render();
