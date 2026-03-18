import { sendToAgent, parseActions } from './agent-client.js';
import { createInitialState, advanceSol, applyActions, CROP_DB } from './greenhouse.js';

let state = createInitialState();
let chatHistory = [];
let isListening = false;
let recognition = null;

// ── Speech Recognition Setup ────────────────────────────────────────
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const r = new SpeechRecognition();
  r.continuous = false;
  r.interimResults = true;
  r.lang = 'en-US';
  r.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    const input = document.getElementById('d-input');
    if (input) input.value = transcript;
    if (e.results[0].isFinal) {
      stopListening();
      if (transcript.trim()) handleSend(transcript.trim());
    }
  };
  r.onend = () => stopListening();
  r.onerror = () => stopListening();
  return r;
}

function startListening() {
  if (!recognition) recognition = initSpeechRecognition();
  if (!recognition) return;
  isListening = true;
  updateMicButton();
  recognition.start();
}

function stopListening() {
  isListening = false;
  updateMicButton();
  try { recognition?.stop(); } catch {}
}

function updateMicButton() {
  const btn = document.getElementById('d-mic');
  if (!btn) return;
  btn.classList.toggle('active', isListening);
  btn.querySelector('.mic-icon').textContent = isListening ? '◉' : '🎤';
}

function speak(text) {
  const clean = text.replace(/[#*`|_\[\]{}()>]/g, '').replace(/\n+/g, '. ').slice(0, 600);
  const u = new SpeechSynthesisUtterance(clean);
  u.rate = 1.05;
  u.pitch = 0.95;
  speechSynthesis.speak(u);
}

// ── Markdown-lite ────────────────────────────────────────────────────
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

// ── Progress bar helper ──────────────────────────────────────────────
function bar(value, max, color = '#4ade80') {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return `<div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>`;
}

// ── Render ───────────────────────────────────────────────────────────
function render() {
  const d = document.getElementById('dashboard');
  const totalCrops = state.modules.reduce((s, m) => s + m.crops.length, 0);
  const usedArea = state.modules.reduce((s, m) => s + m.crops.reduce((a, c) => a + c.area_m2, 0), 0);
  const totalArea = state.modules.reduce((s, m) => s + m.area_m2, 0);
  const missionPct = Math.round((state.mission.currentSol / state.mission.totalSols) * 100);
  const waterPct = Math.round((state.resources.water_liters / 5000) * 100);

  d.innerHTML = `
    <div class="d-layout">
      <!-- Header -->
      <header class="d-header">
        <div class="d-logo">
          <span class="d-logo-icon">❋</span>
          <span class="d-logo-text">FLORA</span>
          <span class="d-logo-sub">Frontier Life-support Operations & Resource Agent</span>
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

      <!-- Main Content -->
      <div class="d-main">
        <!-- Left: Stats + Modules -->
        <div class="d-left">
          <!-- Key Metrics Row -->
          <div class="d-metrics">
            <div class="d-metric">
              <div class="d-metric-label">Mission Progress</div>
              <div class="d-metric-value">${missionPct}%</div>
              ${bar(state.mission.currentSol, state.mission.totalSols, '#60a5fa')}
              <div class="d-metric-detail">${state.mission.totalSols - state.mission.currentSol} sols remaining</div>
            </div>
            <div class="d-metric">
              <div class="d-metric-label">Nutrition Coverage</div>
              <div class="d-metric-value ${state.nutrition.coverage_percent >= 80 ? 'good' : state.nutrition.coverage_percent >= 50 ? 'warn' : 'crit'}">${state.nutrition.coverage_percent}%</div>
              ${bar(state.nutrition.coverage_percent, 100, state.nutrition.coverage_percent >= 80 ? '#4ade80' : state.nutrition.coverage_percent >= 50 ? '#fbbf24' : '#f87171')}
              <div class="d-metric-detail">${state.nutrition.current_daily_kcal} / ${state.nutrition.daily_target_kcal} kcal · ${state.nutrition.current_daily_protein_g}g protein</div>
            </div>
            <div class="d-metric">
              <div class="d-metric-label">Water Reserve</div>
              <div class="d-metric-value ${waterPct > 40 ? 'good' : waterPct > 20 ? 'warn' : 'crit'}">${Math.round(state.resources.water_liters)}L</div>
              ${bar(state.resources.water_liters, 5000, waterPct > 40 ? '#4ade80' : waterPct > 20 ? '#fbbf24' : '#f87171')}
              <div class="d-metric-detail">Budget: ${state.resources.water_daily_budget}L/sol</div>
            </div>
            <div class="d-metric">
              <div class="d-metric-label">Grow Area</div>
              <div class="d-metric-value">${usedArea}/${totalArea}m²</div>
              ${bar(usedArea, totalArea, '#a78bfa')}
              <div class="d-metric-detail">${totalCrops} crop${totalCrops !== 1 ? 's' : ''} active</div>
            </div>
          </div>

          <!-- Greenhouse Modules -->
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
                  <span>🌡 ${m.temp}°C</span>
                  <span>💧 ${m.humidity}%</span>
                  <span>☀ ${m.light} µmol</span>
                  <span>CO₂ ${m.co2}ppm</span>
                </div>
                <div class="d-crops">
                  ${m.crops.length === 0 ? '<div class="d-crop-empty">No crops planted</div>' :
                    m.crops.map(c => {
                      const info = CROP_DB[c.type];
                      const pct = Math.round((c.daysGrown / info.cycle) * 100);
                      const daysLeft = info.cycle - c.daysGrown;
                      return `
                        <div class="d-crop">
                          <div class="d-crop-top">
                            <span class="d-crop-name">${info.name}</span>
                            <span class="d-crop-pct">${pct}%</span>
                          </div>
                          ${bar(c.daysGrown, info.cycle, pct >= 90 ? '#4ade80' : '#60a5fa')}
                          <div class="d-crop-detail">${c.area_m2}m² · ${daysLeft}d to harvest · ${info.role}</div>
                        </div>`;
                    }).join('')}
                </div>
              </div>`;
            }).join('')}
          </div>

          <!-- Recent Harvests -->
          ${state.harvests.length > 0 ? `
          <div class="d-harvests">
            <div class="d-section-title">Recent Harvests</div>
            <div class="d-harvest-list">
              ${state.harvests.slice(-6).reverse().map(h => `
                <div class="d-harvest">Sol ${h.sol}: ${h.crop} — ${h.yield_kg}kg from Module ${h.module}</div>
              `).join('')}
            </div>
          </div>` : ''}

          <!-- Alerts -->
          ${state.alerts.length > 0 ? `
          <div class="d-alerts">
            ${state.alerts.map(a => `<div class="d-alert">⚠ Sol ${a.sol}: ${a.message}</div>`).join('')}
          </div>` : ''}
        </div>

        <!-- Right: Chat / Voice Panel -->
        <div class="d-right">
          <div class="d-chat-header">
            <span class="d-chat-title">FLORA Assistant</span>
            <button class="d-btn d-btn-accent" id="btn-plan">Auto-Plan</button>
          </div>
          <div class="d-messages" id="d-messages">
            <div class="d-msg d-msg-agent">
              <div class="d-msg-text">Hello crew. I'm <strong>FLORA</strong>, your greenhouse management AI. I can help with crop planning, resource optimization, and emergency response. How can I assist?</div>
            </div>
          </div>
          <div class="d-input-area">
            <button class="d-mic" id="d-mic"><span class="mic-icon">🎤</span></button>
            <input type="text" id="d-input" placeholder="Ask FLORA or tap mic to speak..." autocomplete="off" />
            <button class="d-send" id="d-send">→</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Wire events
  document.getElementById('btn-a1').onclick = () => { state = advanceSol(state, 1); render(); };
  document.getElementById('btn-a10').onclick = () => { state = advanceSol(state, 10); render(); };
  document.getElementById('btn-a30').onclick = () => { state = advanceSol(state, 30); render(); };
  document.getElementById('btn-plan').onclick = () => handleSend('Analyze the current greenhouse state and create an optimal crop plan. Provide executable actions.');
  document.getElementById('d-mic').onclick = () => isListening ? stopListening() : startListening();
  document.getElementById('d-send').onclick = () => {
    const v = document.getElementById('d-input').value.trim();
    if (v) { document.getElementById('d-input').value = ''; handleSend(v); }
  };
  document.getElementById('d-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const v = e.target.value.trim();
      if (v) { e.target.value = ''; handleSend(v); }
    }
  };
}

// ── Chat Handler ─────────────────────────────────────────────────────
async function handleSend(text) {
  const msgs = document.getElementById('d-messages');

  // User message
  msgs.innerHTML += `<div class="d-msg d-msg-user"><div class="d-msg-text">${md(text)}</div></div>`;
  msgs.innerHTML += `<div class="d-msg d-msg-loading" id="d-loading"><div class="d-msg-text"><span class="d-dots">●●●</span> Thinking...</div></div>`;
  msgs.scrollTop = msgs.scrollHeight;

  chatHistory.push({ role: 'user', content: text });

  try {
    const response = await sendToAgent(chatHistory, state);
    chatHistory.push({ role: 'assistant', content: response });

    document.getElementById('d-loading')?.remove();

    msgs.innerHTML += `<div class="d-msg d-msg-agent"><div class="d-msg-text">${md(response)}</div></div>`;

    // Speak the response
    speak(response);

    // Check for actions
    const actions = parseActions(response);
    if (actions.length > 0) {
      const id = 'act-' + Date.now();
      msgs.innerHTML += `
        <div class="d-msg d-msg-action" id="${id}">
          <div class="d-msg-text">
            <strong>${actions.length} action(s) recommended</strong>
            <button class="d-btn d-btn-apply" id="${id}-btn">Apply to Greenhouse</button>
          </div>
        </div>`;
      document.getElementById(`${id}-btn`).onclick = () => {
        state = applyActions(state, actions);
        render();
        // Re-render preserves chat, so re-add messages
      };
    }

    msgs.scrollTop = msgs.scrollHeight;
  } catch (err) {
    document.getElementById('d-loading')?.remove();
    msgs.innerHTML += `<div class="d-msg d-msg-error"><div class="d-msg-text">Error: ${err.message}</div></div>`;
    chatHistory.pop();
  }
}

// ── Styles ───────────────────────────────────────────────────────────
const STYLES = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root {
  --bg: #0a0e14;
  --surface: #111820;
  --surface2: #182030;
  --border: rgba(255,255,255,0.06);
  --border2: rgba(255,255,255,0.1);
  --text: #e8edf3;
  --text2: #8899aa;
  --accent: #4ade80;
  --accent2: #60a5fa;
  --warn: #fbbf24;
  --crit: #f87171;
  --radius: 12px;
}

html,body,#dashboard {
  width:100%;height:100%;overflow:hidden;
  background:var(--bg);color:var(--text);
  font-family:'Inter',system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
}

.d-layout {
  display:flex;flex-direction:column;height:100%;
}

/* ── Header ── */
.d-header {
  display:flex;align-items:center;justify-content:space-between;
  padding:12px 20px;
  border-bottom:1px solid var(--border);
  background:var(--surface);
  flex-shrink:0;
}
.d-logo {
  display:flex;align-items:center;gap:8px;
}
.d-logo-icon {
  font-size:1.4rem;color:var(--accent);
}
.d-logo-text {
  font-family:'JetBrains Mono',monospace;
  font-size:1.1rem;font-weight:700;color:var(--accent);
  letter-spacing:0.08em;
}
.d-logo-sub {
  font-size:0.65rem;color:var(--text2);
  max-width:180px;line-height:1.2;
}
.d-header-center {
  display:flex;align-items:center;gap:12px;
}
.d-sol {
  font-family:'JetBrains Mono',monospace;
  font-size:1.5rem;font-weight:700;
  letter-spacing:0.04em;
}
.d-phase-badge {
  font-size:0.7rem;font-weight:600;
  text-transform:uppercase;letter-spacing:0.1em;
  padding:3px 10px;border-radius:20px;
  background:rgba(74,222,128,0.12);color:var(--accent);
  border:1px solid rgba(74,222,128,0.2);
}
.d-header-right {
  display:flex;gap:6px;
}

/* ── Buttons ── */
.d-btn {
  padding:6px 14px;border:1px solid var(--border2);border-radius:8px;
  background:var(--surface2);color:var(--text);
  font-family:'Inter',sans-serif;font-size:0.75rem;font-weight:600;
  cursor:pointer;transition:all 0.15s;
}
.d-btn:hover { background:rgba(255,255,255,0.08);border-color:rgba(255,255,255,0.15); }
.d-btn-sm { padding:4px 10px;font-size:0.7rem; }
.d-btn-accent {
  background:rgba(74,222,128,0.1);border-color:rgba(74,222,128,0.25);color:var(--accent);
}
.d-btn-accent:hover { background:rgba(74,222,128,0.2); }
.d-btn-apply {
  margin-left:12px;padding:4px 14px;border-radius:6px;
  background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.3);
  color:var(--accent);font-size:0.72rem;font-weight:600;cursor:pointer;
}
.d-btn-apply:hover { background:rgba(74,222,128,0.3); }

/* ── Main Layout ── */
.d-main {
  display:flex;flex:1;min-height:0;
}

/* ── Left Panel ── */
.d-left {
  flex:1;overflow-y:auto;padding:16px 20px;
  display:flex;flex-direction:column;gap:16px;
}

/* ── Metrics Row ── */
.d-metrics {
  display:grid;grid-template-columns:repeat(4,1fr);gap:12px;
}
.d-metric {
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:14px 16px;
}
.d-metric-label {
  font-size:0.68rem;font-weight:600;text-transform:uppercase;
  letter-spacing:0.06em;color:var(--text2);margin-bottom:4px;
}
.d-metric-value {
  font-family:'JetBrains Mono',monospace;
  font-size:1.5rem;font-weight:700;margin-bottom:6px;
}
.d-metric-value.good { color:var(--accent); }
.d-metric-value.warn { color:var(--warn); }
.d-metric-value.crit { color:var(--crit); }
.d-metric-detail {
  font-size:0.65rem;color:var(--text2);margin-top:4px;
}

/* ── Progress Bars ── */
.bar-track {
  height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;
}
.bar-fill {
  height:100%;border-radius:2px;transition:width 0.4s ease;
}

/* ── Modules ── */
.d-modules {
  display:grid;grid-template-columns:repeat(3,1fr);gap:12px;
}
.d-module {
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:14px;
}
.d-module-header {
  display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;
}
.d-module-name {
  font-weight:600;font-size:0.85rem;
}
.d-module-area {
  font-family:'JetBrains Mono',monospace;
  font-size:0.72rem;color:var(--text2);
}
.d-module-env {
  display:flex;gap:10px;font-size:0.65rem;color:var(--text2);
  margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);
}
.d-crops {
  display:flex;flex-direction:column;gap:8px;
}
.d-crop-empty {
  font-size:0.72rem;color:var(--text2);font-style:italic;padding:8px 0;text-align:center;
}
.d-crop {
  padding:6px 0;
}
.d-crop-top {
  display:flex;justify-content:space-between;margin-bottom:3px;
}
.d-crop-name { font-size:0.78rem;font-weight:600; }
.d-crop-pct {
  font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--accent);
}
.d-crop-detail { font-size:0.62rem;color:var(--text2);margin-top:3px; }

/* ── Harvests ── */
.d-harvests {
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:14px;
}
.d-section-title {
  font-size:0.7rem;font-weight:600;text-transform:uppercase;
  letter-spacing:0.06em;color:var(--text2);margin-bottom:8px;
}
.d-harvest-list { display:flex;flex-direction:column;gap:4px; }
.d-harvest { font-size:0.72rem;color:var(--text2); }

/* ── Alerts ── */
.d-alerts { display:flex;flex-direction:column;gap:4px; }
.d-alert {
  padding:8px 12px;border-radius:8px;font-size:0.72rem;
  background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.15);
  color:var(--crit);
}

/* ── Right: Chat Panel ── */
.d-right {
  width:380px;flex-shrink:0;
  display:flex;flex-direction:column;
  border-left:1px solid var(--border);
  background:var(--surface);
}
.d-chat-header {
  display:flex;justify-content:space-between;align-items:center;
  padding:12px 16px;border-bottom:1px solid var(--border);
  flex-shrink:0;
}
.d-chat-title {
  font-weight:600;font-size:0.85rem;
}
.d-messages {
  flex:1;overflow-y:auto;padding:12px;
  display:flex;flex-direction:column;gap:8px;
}
.d-msg { max-width:95%; }
.d-msg-user { align-self:flex-end; }
.d-msg-user .d-msg-text {
  background:var(--surface2);border:1px solid var(--border2);
  border-radius:12px 12px 2px 12px;
}
.d-msg-agent .d-msg-text {
  background:rgba(74,222,128,0.04);border:1px solid rgba(74,222,128,0.08);
  border-radius:12px 12px 12px 2px;
}
.d-msg-text {
  padding:10px 14px;font-size:0.8rem;line-height:1.55;
}
.d-msg-text h2,.d-msg-text h3,.d-msg-text h4 {
  margin:6px 0 4px;font-size:0.85rem;color:var(--accent);
}
.d-msg-text strong { color:var(--accent); }
.d-msg-text li { margin-left:12px;font-size:0.78rem; }
.d-msg-text code {
  background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:3px;
  font-family:'JetBrains Mono',monospace;font-size:0.72rem;
}
.d-code {
  background:rgba(0,0,0,0.3);border:1px solid var(--border);
  border-radius:6px;padding:8px 10px;
  font-family:'JetBrains Mono',monospace;font-size:0.68rem;
  overflow-x:auto;white-space:pre-wrap;word-break:break-word;
}
.d-msg-action .d-msg-text {
  background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.15);
  border-radius:8px;display:flex;align-items:center;justify-content:space-between;
}
.d-msg-error .d-msg-text {
  background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.12);
  color:var(--crit);border-radius:8px;
}
.d-msg-loading .d-msg-text { color:var(--text2); }
.d-dots { animation:pulse 1.2s infinite;letter-spacing:2px; }
@keyframes pulse { 0%,100%{opacity:0.3} 50%{opacity:1} }

/* ── Input Area ── */
.d-input-area {
  display:flex;gap:8px;padding:12px;
  border-top:1px solid var(--border);
  flex-shrink:0;
}
.d-mic {
  width:42px;height:42px;border-radius:50%;
  border:1px solid var(--border2);background:var(--surface2);
  font-size:1.1rem;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:all 0.2s;flex-shrink:0;
}
.d-mic:hover { background:rgba(255,255,255,0.08); }
.d-mic.active {
  background:rgba(248,113,113,0.15);border-color:rgba(248,113,113,0.4);
  animation:mic-pulse 1.5s infinite;
}
@keyframes mic-pulse {
  0%,100% { box-shadow:0 0 0 0 rgba(248,113,113,0.2); }
  50% { box-shadow:0 0 0 8px rgba(248,113,113,0); }
}
.mic-icon { font-size:1rem; }
#d-input {
  flex:1;padding:10px 14px;
  border:1px solid var(--border2);border-radius:10px;
  background:rgba(255,255,255,0.03);color:var(--text);
  font-family:'Inter',sans-serif;font-size:0.82rem;
  outline:none;
}
#d-input:focus { border-color:rgba(74,222,128,0.3);background:rgba(255,255,255,0.05); }
#d-input::placeholder { color:var(--text2); }
.d-send {
  width:42px;height:42px;border-radius:10px;
  border:1px solid rgba(74,222,128,0.25);background:rgba(74,222,128,0.08);
  color:var(--accent);font-size:1.2rem;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:all 0.15s;flex-shrink:0;
}
.d-send:hover { background:rgba(74,222,128,0.2); }

/* ── Scrollbar ── */
.d-left::-webkit-scrollbar,.d-messages::-webkit-scrollbar { width:4px; }
.d-left::-webkit-scrollbar-track,.d-messages::-webkit-scrollbar-track { background:transparent; }
.d-left::-webkit-scrollbar-thumb,.d-messages::-webkit-scrollbar-thumb {
  background:rgba(255,255,255,0.08);border-radius:2px;
}

/* ── iPad responsive ── */
@media (max-width:1100px) {
  .d-metrics { grid-template-columns:repeat(2,1fr); }
  .d-modules { grid-template-columns:1fr 1fr; }
  .d-right { width:320px; }
  .d-logo-sub { display:none; }
}
@media (max-width:800px) {
  .d-main { flex-direction:column; }
  .d-right { width:100%;border-left:none;border-top:1px solid var(--border);max-height:40vh; }
  .d-modules { grid-template-columns:1fr; }
}
`;

// ── Init ─────────────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = STYLES;
document.head.appendChild(style);
render();
