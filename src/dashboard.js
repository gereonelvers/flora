import { sendToAgent, parseActions } from './agent-client.js';
import { createInitialState, advanceSol, applyActions, CROP_DB } from './greenhouse.js';

let state = createInitialState();
let chatHistory = [];
let isListening = false;
let floraState = 'idle'; // idle | listening | thinking | speaking | alert

// ── Voice Server Connection ──────────────────────────────────────────
const VOICE_WS_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'ws://localhost:8765'
  : `wss://${location.hostname}:8765`; // adjust for deployment

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
  },
  listening: {
    c1: 'rgba(34,211,238,0.45)', c2: 'rgba(59,130,246,0.35)', c3: 'rgba(94,234,212,0.45)',
    glow: '0 0 80px rgba(34,211,238,0.3)', scale: 1.15, rotation: 45, petalSpread: 1.3,
    ringSpeed: 6, label: 'Awaiting Input', sub: 'Audio channels open',
  },
  thinking: {
    c1: 'rgba(168,85,247,0.45)', c2: 'rgba(99,102,241,0.45)', c3: 'rgba(74,222,128,0.35)',
    glow: '0 0 60px rgba(168,85,247,0.25)', scale: 0.9, rotation: 180, petalSpread: 0.8,
    ringSpeed: 3, label: 'Processing', sub: 'Querying knowledge base...',
  },
  speaking: {
    c1: 'rgba(163,230,53,0.5)', c2: 'rgba(16,185,129,0.45)', c3: 'rgba(134,239,172,0.5)',
    glow: '0 0 80px rgba(163,230,53,0.3)', scale: 1.08, rotation: 15, petalSpread: 1.1,
    ringSpeed: 6, label: 'Transmitting', sub: 'Relaying analysis...',
  },
  alert: {
    c1: 'rgba(249,115,22,0.5)', c2: 'rgba(239,68,68,0.45)', c3: 'rgba(251,191,36,0.5)',
    glow: '0 0 80px rgba(239,68,68,0.3)', scale: 0.85, rotation: -45, petalSpread: 0.5,
    ringSpeed: 2, label: 'Anomaly Detected', sub: 'Check greenhouse alerts',
  },
};

function setFloraState(s) {
  floraState = s;
  updateAvatar();
}

// ── Audio Playback (PCM 24kHz from Nova Sonic) ──────────────────────
function enqueueAudio(base64Pcm) {
  // Decode base64 → Int16 PCM → Float32
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

  // Batch multiple chunks for smoother playback
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
    appendSystemMsg('Voice connected — tap mic to speak');
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
          // ASR transcription of user speech
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
          if (floraState === 'speaking') setFloraState('idle');
        }, 1500); // small delay for audio queue to drain
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
    appendSystemMsg('Voice server not available — using text mode');
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
  // Connect to voice server if not connected
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

  // Use ScriptProcessorNode for broad compatibility (AudioWorklet not on all iPads)
  const micCtx = new AudioContext({ sampleRate: 16000 });
  const source = micCtx.createMediaStreamSource(mediaStream);
  const processor = micCtx.createScriptProcessor(1024, 1, 1);

  processor.onaudioprocess = (e) => {
    if (!isListening || !voiceSocket || voiceSocket.readyState !== WebSocket.OPEN) return;
    const float32 = e.inputBuffer.getChannelData(0);
    // Convert Float32 → Int16
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32768)));
    }
    // Convert to base64
    const bytes = new Uint8Array(int16.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    voiceSocket.send(JSON.stringify({ type: 'audio', data: base64 }));
  };

  source.connect(processor);
  processor.connect(micCtx.destination);

  // Store refs for cleanup
  window._micCtx = micCtx;
  window._processor = processor;
  window._source = source;
}

function stopListening() {
  isListening = false;
  if (floraState === 'listening') setFloraState('idle');

  // Stop mic
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

// Fallback: text-to-speech for text-only mode
function speak(text) {
  if (voiceSocket?.readyState === WebSocket.OPEN) return; // Nova Sonic handles voice
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

function bar(value, max, color = '#4ade80') {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return `<div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>`;
}

// ── FLORA Avatar SVG ─────────────────────────────────────────────────
function renderAvatar() {
  const s = FLORA_STATES[floraState];
  const petals = [0, 45, 90, 135, 180, 225, 270, 315];
  const petalPaths = petals.map((angle, i) => {
    const primary = i % 2 === 0;
    const spread = primary ? s.petalSpread : s.petalSpread * 0.7;
    return `<path d="M 50 50 C 30 20, 30 0, 50 -15 C 70 0, 70 20, 50 50"
      fill="currentColor" fill-opacity="${primary ? 0.25 : 0.12}"
      stroke="currentColor" stroke-width="${primary ? 1.5 : 0.75}"
      style="transform-origin:50px 50px;transform:rotate(${angle}deg) scaleY(${spread}) scaleX(${spread * 0.8});transition:all 1.2s cubic-bezier(0.4,0,0.2,1)"/>`;
  }).join('');

  return `
    <div class="flora-avatar-wrap">
      <!-- Morphing blobs -->
      <div class="flora-blob-container" style="transform:scale(${s.scale});transition:transform 1s cubic-bezier(0.34,1.56,0.64,1)">
        <div class="flora-blob blob-1" style="background:${s.c1}"></div>
        <div class="flora-blob blob-2" style="background:${s.c2}"></div>
        <div class="flora-blob blob-3" style="background:${s.c3};box-shadow:${s.glow}">
          <!-- Lotus SVG -->
          <div class="flora-lotus" style="transform:rotate(${s.rotation}deg);transition:transform 1.2s cubic-bezier(0.34,1.56,0.64,1)">
            <svg viewBox="-20 -20 140 140" class="flora-svg">
              <g>${petalPaths}</g>
              <circle cx="50" cy="50" r="8" fill="currentColor" opacity="0.9"/>
              <circle cx="50" cy="50" r="14" fill="none" stroke="currentColor" stroke-width="1"
                stroke-dasharray="4 4" class="flora-orbit-inner"
                style="animation-duration:${floraState === 'thinking' ? '2s' : '8s'};
                       animation-direction:${floraState === 'thinking' ? 'reverse' : 'normal'}"/>
            </svg>
          </div>
        </div>
      </div>
      <!-- Orbital ring -->
      <div class="flora-ring" style="animation-duration:${s.ringSpeed}s">
        <div class="flora-ring-dot" style="background:${floraState === 'alert' ? '#f87171' : '#4ade80'};
             box-shadow:0 0 8px ${floraState === 'alert' ? '#f87171' : '#4ade80'}"></div>
      </div>
      <div class="flora-ring flora-ring-2" style="animation-duration:${s.ringSpeed * 1.5}s;animation-direction:reverse">
        <div class="flora-ring-dot dot-2" style="background:${floraState === 'listening' ? '#22d3ee' : '#60a5fa'};
             box-shadow:0 0 8px ${floraState === 'listening' ? '#22d3ee' : '#60a5fa'}"></div>
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

// ── Render Dashboard ─────────────────────────────────────────────────
function render() {
  const d = document.getElementById('dashboard');
  const totalCrops = state.modules.reduce((s, m) => s + m.crops.length, 0);
  const usedArea = state.modules.reduce((s, m) => s + m.crops.reduce((a, c) => a + c.area_m2, 0), 0);
  const totalArea = state.modules.reduce((s, m) => s + m.area_m2, 0);
  const missionPct = Math.round((state.mission.currentSol / state.mission.totalSols) * 100);
  const waterPct = Math.round((state.resources.water_liters / 5000) * 100);

  // Check for alerts
  if (state.alerts.length > 0 && floraState === 'idle') floraState = 'alert';

  d.innerHTML = `
    <div class="d-layout">
      <header class="d-header">
        <div class="d-logo">
          <span class="d-logo-icon">❋</span>
          <span class="d-logo-text">FLORA</span>
        </div>
        <div class="d-header-center">
          <div class="d-sol">SOL ${state.mission.currentSol}</div>
          <div class="d-phase-badge">${state.mission.phase}</div>
        </div>
        <div class="d-header-right">
          <button class="d-btn d-btn-sm" id="btn-a1">+1 Sol</button>
          <button class="d-btn d-btn-sm" id="btn-a10">+10</button>
          <button class="d-btn d-btn-sm" id="btn-a30">+30</button>
        </div>
      </header>

      <div class="d-main">
        <div class="d-left">
          <div class="d-metrics">
            <div class="d-metric">
              <div class="d-metric-label">Mission</div>
              <div class="d-metric-value">${missionPct}%</div>
              ${bar(state.mission.currentSol, state.mission.totalSols, '#60a5fa')}
              <div class="d-metric-detail">${state.mission.totalSols - state.mission.currentSol} sols left</div>
            </div>
            <div class="d-metric">
              <div class="d-metric-label">Nutrition</div>
              <div class="d-metric-value ${state.nutrition.coverage_percent >= 80 ? 'good' : state.nutrition.coverage_percent >= 50 ? 'warn' : 'crit'}">${state.nutrition.coverage_percent}%</div>
              ${bar(state.nutrition.coverage_percent, 100, state.nutrition.coverage_percent >= 80 ? '#4ade80' : state.nutrition.coverage_percent >= 50 ? '#fbbf24' : '#f87171')}
              <div class="d-metric-detail">${state.nutrition.current_daily_kcal} kcal · ${state.nutrition.current_daily_protein_g}g protein</div>
            </div>
            <div class="d-metric">
              <div class="d-metric-label">Water</div>
              <div class="d-metric-value ${waterPct > 40 ? 'good' : waterPct > 20 ? 'warn' : 'crit'}">${Math.round(state.resources.water_liters)}L</div>
              ${bar(state.resources.water_liters, 5000, waterPct > 40 ? '#4ade80' : waterPct > 20 ? '#fbbf24' : '#f87171')}
            </div>
            <div class="d-metric">
              <div class="d-metric-label">Grow Area</div>
              <div class="d-metric-value">${usedArea}/${totalArea}m²</div>
              ${bar(usedArea, totalArea, '#a78bfa')}
              <div class="d-metric-detail">${totalCrops} crop${totalCrops !== 1 ? 's' : ''} active</div>
            </div>
          </div>

          <div class="d-modules">
            ${state.modules.map(m => {
              const used = m.crops.reduce((s, c) => s + c.area_m2, 0);
              return `
              <div class="d-module">
                <div class="d-module-header">
                  <span class="d-module-name">${m.name}</span>
                  <span class="d-module-area">${used}/${m.area_m2}m²</span>
                </div>
                <div class="d-module-env">
                  <span>🌡 ${m.temp}°C</span><span>💧 ${m.humidity}%</span><span>☀ ${m.light}µmol</span><span>CO₂ ${m.co2}</span>
                </div>
                <div class="d-crops">
                  ${m.crops.length === 0 ? '<div class="d-crop-empty">No crops planted</div>' :
                    m.crops.map(c => {
                      const info = CROP_DB[c.type];
                      const pct = Math.round((c.daysGrown / info.cycle) * 100);
                      return `<div class="d-crop">
                        <div class="d-crop-top"><span class="d-crop-name">${info.name}</span><span class="d-crop-pct">${pct}%</span></div>
                        ${bar(c.daysGrown, info.cycle, pct >= 90 ? '#4ade80' : '#60a5fa')}
                        <div class="d-crop-detail">${c.area_m2}m² · ${info.cycle - c.daysGrown}d left</div>
                      </div>`;
                    }).join('')}
                </div>
              </div>`;
            }).join('')}
          </div>

          ${state.harvests.length > 0 ? `<div class="d-harvests"><div class="d-section-title">Recent Harvests</div>
            <div class="d-harvest-list">${state.harvests.slice(-5).reverse().map(h =>
              `<div class="d-harvest">Sol ${h.sol}: ${h.crop} — ${h.yield_kg}kg</div>`).join('')}
            </div></div>` : ''}

          ${state.alerts.length > 0 ? `<div class="d-alerts">${state.alerts.map(a =>
            `<div class="d-alert">⚠ Sol ${a.sol}: ${a.message}</div>`).join('')}</div>` : ''}
        </div>

        <!-- Right: FLORA Avatar + Chat -->
        <div class="d-right">
          <div id="flora-avatar" class="flora-avatar-section">${renderAvatar()}</div>
          <div class="d-messages" id="d-messages">
            <div class="d-msg d-msg-agent"><div class="d-msg-text">Hello crew. I'm <strong>FLORA</strong>. I manage crop planning, resource optimization, and emergency response for the mission. How can I assist?</div></div>
          </div>
          <div class="d-input-area">
            <button class="d-mic ${isListening ? 'active' : ''}" id="d-mic">
              <span class="mic-icon">${isListening ? '◉' : '🎤'}</span>
            </button>
            <input type="text" id="d-input" placeholder="Ask FLORA or tap mic..." autocomplete="off" />
            <button class="d-send" id="d-send">→</button>
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
  msgs.innerHTML += `<div class="d-msg d-msg-loading" id="d-loading"><div class="d-msg-text"><span class="d-dots">●●●</span> Processing...</div></div>`;
  msgs.scrollTop = msgs.scrollHeight;

  chatHistory.push({ role: 'user', content: text });
  setFloraState('thinking');

  try {
    const response = await sendToAgent(chatHistory, state);
    chatHistory.push({ role: 'assistant', content: response });
    document.getElementById('d-loading')?.remove();
    msgs.innerHTML += `<div class="d-msg d-msg-agent"><div class="d-msg-text">${md(response)}</div></div>`;

    speak(response);

    const actions = parseActions(response);
    if (actions.length > 0) {
      const id = 'act-' + Date.now();
      msgs.innerHTML += `<div class="d-msg d-msg-action" id="${id}"><div class="d-msg-text">
        <strong>${actions.length} action(s)</strong>
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
:root{--bg:#0a0e14;--surface:#111820;--surface2:#182030;--border:rgba(255,255,255,0.06);--border2:rgba(255,255,255,0.1);--text:#e8edf3;--text2:#8899aa;--accent:#4ade80;--warn:#fbbf24;--crit:#f87171;--radius:12px}
html,body,#dashboard{width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased}

/* Morphing blob animations */
@keyframes morph-1{0%,100%{border-radius:60% 40% 30% 70%/60% 30% 70% 40%}50%{border-radius:30% 60% 70% 40%/50% 60% 30% 60%}}
@keyframes morph-2{0%,100%{border-radius:40% 60% 70% 30%/40% 50% 60% 50%}50%{border-radius:70% 30% 40% 60%/60% 40% 50% 40%}}
@keyframes morph-3{0%,100%{border-radius:70% 30% 50% 50%/30% 30% 70% 70%}50%{border-radius:30% 70% 50% 50%/70% 70% 30% 30%}}
@keyframes orbit-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
@keyframes inner-orbit{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}

.d-layout{display:flex;flex-direction:column;height:100%}

/* Header */
.d-header{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
.d-logo{display:flex;align-items:center;gap:8px}
.d-logo-icon{font-size:1.3rem;color:var(--accent)}
.d-logo-text{font-family:'JetBrains Mono',monospace;font-size:1rem;font-weight:700;color:var(--accent);letter-spacing:0.08em}
.d-header-center{display:flex;align-items:center;gap:12px}
.d-sol{font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:700;letter-spacing:0.04em}
.d-phase-badge{font-size:0.65rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;padding:3px 10px;border-radius:20px;background:rgba(74,222,128,0.12);color:var(--accent);border:1px solid rgba(74,222,128,0.2)}
.d-header-right{display:flex;gap:6px}

/* Buttons */
.d-btn{padding:6px 14px;border:1px solid var(--border2);border-radius:8px;background:var(--surface2);color:var(--text);font-family:'Inter',sans-serif;font-size:0.72rem;font-weight:600;cursor:pointer;transition:all 0.15s}
.d-btn:hover{background:rgba(255,255,255,0.08)}
.d-btn-sm{padding:4px 10px;font-size:0.68rem}
.d-btn-apply{margin-left:12px;padding:4px 14px;border-radius:6px;background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.3);color:var(--accent);font-size:0.7rem;font-weight:600;cursor:pointer}
.d-btn-apply:hover{background:rgba(74,222,128,0.3)}

/* Main */
.d-main{display:flex;flex:1;min-height:0}

/* Left */
.d-left{flex:1;overflow-y:auto;padding:14px 18px;display:flex;flex-direction:column;gap:14px}

/* Metrics */
.d-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.d-metric{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px}
.d-metric-label{font-size:0.65rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text2);margin-bottom:3px}
.d-metric-value{font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:700;margin-bottom:5px}
.d-metric-value.good{color:var(--accent)}.d-metric-value.warn{color:var(--warn)}.d-metric-value.crit{color:var(--crit)}
.d-metric-detail{font-size:0.62rem;color:var(--text2);margin-top:3px}
.bar-track{height:3px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden}
.bar-fill{height:100%;border-radius:2px;transition:width 0.4s ease}

/* Modules */
.d-modules{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.d-module{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px}
.d-module-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.d-module-name{font-weight:600;font-size:0.82rem}
.d-module-area{font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:var(--text2)}
.d-module-env{display:flex;gap:8px;font-size:0.62rem;color:var(--text2);margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.d-crops{display:flex;flex-direction:column;gap:6px}
.d-crop-empty{font-size:0.7rem;color:var(--text2);font-style:italic;padding:6px 0;text-align:center}
.d-crop-top{display:flex;justify-content:space-between;margin-bottom:2px}
.d-crop-name{font-size:0.75rem;font-weight:600}
.d-crop-pct{font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:var(--accent)}
.d-crop-detail{font-size:0.6rem;color:var(--text2);margin-top:2px}

/* Harvests & Alerts */
.d-harvests{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px}
.d-section-title{font-size:0.65rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text2);margin-bottom:6px}
.d-harvest{font-size:0.68rem;color:var(--text2)}
.d-alerts{display:flex;flex-direction:column;gap:4px}
.d-alert{padding:8px 12px;border-radius:8px;font-size:0.7rem;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.15);color:var(--crit)}

/* ── Right: FLORA Avatar + Chat ── */
.d-right{width:360px;flex-shrink:0;display:flex;flex-direction:column;border-left:1px solid var(--border);background:var(--surface)}

/* Avatar Section */
.flora-avatar-section{padding:16px;display:flex;flex-direction:column;align-items:center;border-bottom:1px solid var(--border);flex-shrink:0;background:rgba(0,0,0,0.2)}
.flora-avatar-wrap{position:relative;width:140px;height:140px;display:flex;align-items:center;justify-content:center}
.flora-blob-container{position:relative;width:110px;height:110px;display:flex;align-items:center;justify-content:center}
.flora-blob{position:absolute;inset:0;mix-blend-mode:screen;transition:background 1s ease}
.blob-1{animation:morph-1 8s ease-in-out infinite;filter:blur(18px)}
.blob-2{animation:morph-2 10s ease-in-out infinite reverse;filter:blur(12px);inset:6px}
.blob-3{animation:morph-3 7s ease-in-out infinite;inset:14px;filter:blur(2px);border:1px solid rgba(255,255,255,0.15);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;transition:background 1s ease,box-shadow 1s ease}
.flora-lotus{width:70px;height:70px;color:rgba(255,255,255,0.85);filter:drop-shadow(0 0 10px rgba(255,255,255,0.3))}
.flora-svg{width:100%;height:100%;overflow:visible}
.flora-orbit-inner{transform-origin:50px 50px;animation:inner-orbit 8s linear infinite}

/* Orbital Rings */
.flora-ring{position:absolute;inset:-4px;border:1px solid rgba(255,255,255,0.08);border-radius:50%;animation:orbit-spin 12s linear infinite}
.flora-ring-2{inset:4px}
.flora-ring-dot{position:absolute;top:-3px;left:50%;width:6px;height:6px;margin-left:-3px;border-radius:50%;transition:background 0.6s,box-shadow 0.6s}
.dot-2{top:auto;bottom:auto;right:-3px;left:auto;top:50%;margin-top:-3px}

/* Status */
.flora-status{text-align:center;margin-top:10px}
.flora-status-label{font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--text);transition:color 0.5s}
.flora-status-sub{font-size:0.62rem;color:var(--text2);font-family:'JetBrains Mono',monospace;margin-top:2px}

/* Messages */
.d-messages{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.d-msg{max-width:95%}
.d-msg-user{align-self:flex-end}
.d-msg-user .d-msg-text{background:var(--surface2);border:1px solid var(--border2);border-radius:12px 12px 2px 12px}
.d-msg-agent .d-msg-text{background:rgba(74,222,128,0.04);border:1px solid rgba(74,222,128,0.08);border-radius:12px 12px 12px 2px}
.d-msg-text{padding:8px 12px;font-size:0.78rem;line-height:1.5}
.d-msg-text h2,.d-msg-text h3,.d-msg-text h4{margin:4px 0;font-size:0.82rem;color:var(--accent)}
.d-msg-text strong{color:var(--accent)}
.d-msg-text li{margin-left:12px;font-size:0.75rem}
.d-msg-text code{background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px;font-family:'JetBrains Mono',monospace;font-size:0.68rem}
.d-code{background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-family:'JetBrains Mono',monospace;font-size:0.65rem;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
.d-msg-action .d-msg-text{background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.15);border-radius:8px;display:flex;align-items:center;justify-content:space-between}
.d-msg-error .d-msg-text{background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.12);color:var(--crit);border-radius:8px}
.d-msg-system .d-msg-text{background:rgba(96,165,250,0.06);border:1px solid rgba(96,165,250,0.1);color:var(--text2);border-radius:8px;font-size:0.7rem;text-align:center;font-style:italic}
.d-msg-loading .d-msg-text{color:var(--text2)}
.d-dots{animation:pulse 1.2s infinite;letter-spacing:2px}
@keyframes pulse{0%,100%{opacity:0.3}50%{opacity:1}}

/* Input */
.d-input-area{display:flex;gap:8px;padding:10px;border-top:1px solid var(--border);flex-shrink:0}
.d-mic{width:40px;height:40px;border-radius:50%;border:1px solid var(--border2);background:var(--surface2);font-size:1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.2s;flex-shrink:0}
.d-mic:hover{background:rgba(255,255,255,0.08)}
.d-mic.active{background:rgba(34,211,238,0.15);border-color:rgba(34,211,238,0.4);animation:mic-pulse 1.5s infinite}
@keyframes mic-pulse{0%,100%{box-shadow:0 0 0 0 rgba(34,211,238,0.2)}50%{box-shadow:0 0 0 8px rgba(34,211,238,0)}}
#d-input{flex:1;padding:8px 12px;border:1px solid var(--border2);border-radius:10px;background:rgba(255,255,255,0.03);color:var(--text);font-family:'Inter',sans-serif;font-size:0.8rem;outline:none}
#d-input:focus{border-color:rgba(74,222,128,0.3);background:rgba(255,255,255,0.05)}
#d-input::placeholder{color:var(--text2)}
.d-send{width:40px;height:40px;border-radius:10px;border:1px solid rgba(74,222,128,0.25);background:rgba(74,222,128,0.08);color:var(--accent);font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;flex-shrink:0}
.d-send:hover{background:rgba(74,222,128,0.2)}

/* Scrollbar */
.d-left::-webkit-scrollbar,.d-messages::-webkit-scrollbar{width:4px}
.d-left::-webkit-scrollbar-track,.d-messages::-webkit-scrollbar-track{background:transparent}
.d-left::-webkit-scrollbar-thumb,.d-messages::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:2px}

/* iPad */
@media(max-width:1100px){.d-metrics{grid-template-columns:repeat(2,1fr)}.d-modules{grid-template-columns:1fr 1fr}.d-right{width:300px}}
@media(max-width:800px){.d-main{flex-direction:column}.d-right{width:100%;border-left:none;border-top:1px solid var(--border);max-height:45vh}.d-modules{grid-template-columns:1fr}.flora-avatar-section{padding:10px}.flora-avatar-wrap{width:100px;height:100px}.flora-blob-container{width:80px;height:80px}}
`;

// ── Init ─────────────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = STYLES;
document.head.appendChild(style);
render();
