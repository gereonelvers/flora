/**
 * UI layer: chat panel + mission HUD overlay.
 * Injects HTML into the DOM and manages interactions.
 */

import { sendToAgent, parseActions } from './agent-client.js';
import { createInitialState, advanceSol, applyActions, saveState, loadState, resetState, CROP_DB } from './greenhouse.js';

let state = createInitialState(); // overwritten by async init in initUI
let chatHistory = [];

// ── Markdown-lite renderer ──────────────────────────────────────────
function md(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```json\s*([\s\S]*?)```/g, '<pre class="code-block">$1</pre>')
    .replace(/```([\s\S]*?)```/g, '<pre class="code-block">$1</pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^\| .+$/gm, (match) => `<div class="md-table-row">${match}</div>`)
    .replace(/^[-*] (.+)$/gm, '<div class="md-list-item">• $1</div>')
    .replace(/\n/g, '<br>');
}

// ── Build DOM ───────────────────────────────────────────────────────
export function initUI() {
  const app = document.querySelector('#app');

  // ── Mission HUD (top-right) ──
  const hud = document.createElement('div');
  hud.id = 'mission-hud';
  hud.innerHTML = `
    <div class="hud-header">
      <span class="hud-label">MISSION STATUS</span>
      <span class="hud-sol" id="hud-sol">SOL 1 / 450</span>
    </div>
    <div class="hud-grid">
      <div class="hud-card">
        <div class="hud-card-label">Phase</div>
        <div class="hud-card-value" id="hud-phase">Setup</div>
      </div>
      <div class="hud-card">
        <div class="hud-card-label">Nutrition</div>
        <div class="hud-card-value" id="hud-nutrition">0%</div>
      </div>
      <div class="hud-card">
        <div class="hud-card-label">Water</div>
        <div class="hud-card-value" id="hud-water">5000 L</div>
      </div>
      <div class="hud-card">
        <div class="hud-card-label">Crops Active</div>
        <div class="hud-card-value" id="hud-crops">0</div>
      </div>
    </div>
    <div class="hud-modules" id="hud-modules"></div>
    <div class="hud-time" id="hud-time">
      <span class="hud-time-label">TIME</span>
      <span class="hud-time-value" id="hud-clock">06:00</span>
      <span class="hud-speed" id="hud-speed">1x</span>
    </div>
    <div class="hud-actions">
      <button id="btn-speed-0" class="hud-btn hud-speed-btn">⏸</button>
      <button id="btn-speed-1" class="hud-btn hud-speed-btn">1×</button>
      <button id="btn-speed-1500" class="hud-btn hud-speed-btn active">1.5k×</button>
      <button id="btn-speed-5000" class="hud-btn hud-speed-btn">5k×</button>
      <button id="btn-speed-15000" class="hud-btn hud-speed-btn">15k×</button>
    </div>
    <div class="hud-actions">
      <button id="btn-advance-10" class="hud-btn">+10 Sols</button>
      <button id="btn-advance-30" class="hud-btn">+30 Sols</button>
    </div>
    <div class="hud-actions" style="margin-top:4px">
      <button id="btn-reset" class="hud-btn hud-btn-reset">Reset Simulation</button>
    </div>
  `;
  app.appendChild(hud);

  // Chat panel removed — FLORA chat lives on the dashboard only

  // ── Inject styles ──
  const style = document.createElement('style');
  style.textContent = UI_STYLES;
  document.head.appendChild(style);

  let uiSuppressPoll = false;

  // ── Wire events ──
  document.getElementById('btn-advance-10').addEventListener('click', () => { state = advanceSol(state, 10); saveState(state); updateHUD(); });
  document.getElementById('btn-advance-30').addEventListener('click', () => { state = advanceSol(state, 30); saveState(state); updateHUD(); });
  document.getElementById('btn-reset').addEventListener('click', () => {
    if (confirm('Reset simulation to Sol 1? All crops, harvests, and progress will be lost.')) {
      uiSuppressPoll = true;
      state = resetState();
      updateHUD();
      window.__flora3d?.resetSolFraction?.();
      setTimeout(() => { uiSuppressPoll = false; }, 5000);
    }
  });

  // Speed controls — true multipliers (1x = real time, 1 sol = 24.65h)
  const speedBtns = { 0: 'btn-speed-0', 1: 'btn-speed-1', 1500: 'btn-speed-1500', 5000: 'btn-speed-5000', 15000: 'btn-speed-15000' };
  const speedLabels = { 0: 'PAUSED', 1: '1× REAL', 1500: '1.5k×', 5000: '5k×', 15000: '15k×' };
  const setSpeed = (s) => {
    if (window.__flora3d) window.__flora3d.setSimSpeed(s);
    Object.values(speedBtns).forEach(id => document.getElementById(id)?.classList.remove('active'));
    document.getElementById(speedBtns[s])?.classList.add('active');
    const el = document.getElementById('hud-speed');
    if (el) el.textContent = speedLabels[s] || `${s}×`;
  };
  document.getElementById('btn-speed-0').addEventListener('click', () => setSpeed(0));
  document.getElementById('btn-speed-1').addEventListener('click', () => setSpeed(1));
  document.getElementById('btn-speed-1500').addEventListener('click', () => setSpeed(1500));
  document.getElementById('btn-speed-5000').addEventListener('click', () => setSpeed(5000));
  document.getElementById('btn-speed-15000').addEventListener('click', () => setSpeed(15000));

  // Real-time sol advance callback (called by main.js animation loop when a full sol completes)
  window.__floraUI = {
    advanceSol: async () => {
      // Always fetch latest state first to avoid overwriting FLORA's background changes
      try {
        const latest = await loadState();
        if (latest) {
          if (state.mission?.started && !latest.mission?.started) latest.mission.started = true;
          state = latest;
        }
      } catch {}
      state = advanceSol(state, 1);
      saveState(state);
      updateHUD();
    },
    getCurrentSol: () => state.mission.currentSol,
    getStarted: () => state.mission?.started ?? false,
    setStarted: (v) => { state.mission.started = v; saveState(state); },
    getState: () => state,
    saveState: (s) => { state = s; saveState(s); },
  };

  // Update time-of-day clock every 200ms
  setInterval(() => {
    const frac = window.__flora3d?.getSolFraction?.() ?? 0.35;
    const hours = Math.floor(frac * 24.65);
    const minutes = Math.floor((frac * 24.65 - hours) * 60);
    const el = document.getElementById('hud-clock');
    if (el) el.textContent = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }, 200);

  // Chat toggle
  // Load state from server
  (async () => {
    const saved = await loadState();
    if (saved) { state = saved; updateHUD(); }
  })();

  // Poll server for changes every 3s (cross-device sync)
  setInterval(async () => {
    if (uiSuppressPoll) return;
    const saved = await loadState();
    if (saved && JSON.stringify(saved) !== JSON.stringify(state)) {
      state = saved;
      updateHUD();
    }
  }, 3000);

  updateHUD();
  return {
    getState: () => state,
    setState: (s) => { state = s; saveState(s); updateHUD(); },
    saveState: (s) => { state = s; saveState(s); },
    suppressPoll: (ms) => { uiSuppressPoll = true; setTimeout(() => { uiSuppressPoll = false; }, ms); },
  };
}

// ── HUD Update ──────────────────────────────────────────────────────
function updateHUD() {
  document.getElementById('hud-sol').textContent = `SOL ${state.mission.currentSol} / ${state.mission.totalSols}`;
  document.getElementById('hud-phase').textContent = state.mission.phase;
  document.getElementById('hud-nutrition').textContent = `${state.nutrition.coverage_percent}%`;
  document.getElementById('hud-nutrition').style.color =
    state.nutrition.coverage_percent >= 80 ? '#4ade80' :
    state.nutrition.coverage_percent >= 50 ? '#fbbf24' : '#f87171';
  document.getElementById('hud-water').textContent = `${Math.round(state.resources.water_liters)} L`;
  document.getElementById('hud-water').style.color =
    state.resources.water_liters > 2000 ? '#4ade80' :
    state.resources.water_liters > 1000 ? '#fbbf24' : '#f87171';

  const totalCrops = state.modules.reduce((s, m) => s + m.crops.length, 0);
  document.getElementById('hud-crops').textContent = totalCrops;

  // Module details
  const modEl = document.getElementById('hud-modules');
  modEl.innerHTML = state.modules.map(m => {
    const usedArea = m.crops.reduce((s, c) => s + c.area_m2, 0);
    const cropList = m.crops.map(c => {
      const info = CROP_DB[c.type];
      const progress = Math.round((c.daysGrown / info.cycle) * 100);
      return `<span class="mod-crop">${info.name} ${progress}%</span>`;
    }).join(' ');
    return `
      <div class="mod-row">
        <div class="mod-name">${m.name}</div>
        <div class="mod-stats">${usedArea}/${m.area_m2}m² · ${m.temp}°C</div>
        <div class="mod-crops">${cropList || '<span class="mod-empty">Empty</span>'}</div>
      </div>`;
  }).join('');
}

// ── Chat Logic ──────────────────────────────────────────────────────
async function handleUserMessage(text) {
  const messagesEl = document.getElementById('chat-messages');

  // Add user message
  const userDiv = document.createElement('div');
  userDiv.className = 'chat-msg chat-msg-user';
  userDiv.innerHTML = `<div class="chat-msg-content">${md(text)}</div>`;
  messagesEl.appendChild(userDiv);

  // Add loading indicator
  const loadDiv = document.createElement('div');
  loadDiv.className = 'chat-msg chat-msg-agent chat-loading';
  loadDiv.innerHTML = '<div class="chat-msg-content"><span class="typing-dots">●●●</span> FLORA is thinking...</div>';
  messagesEl.appendChild(loadDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  chatHistory.push({ role: 'user', content: text });

  try {
    const response = await sendToAgent(chatHistory, state);
    chatHistory.push({ role: 'assistant', content: response });

    // Remove loading
    loadDiv.remove();

    // Add agent response
    const agentDiv = document.createElement('div');
    agentDiv.className = 'chat-msg chat-msg-agent';
    agentDiv.innerHTML = `<div class="chat-msg-content">${md(response)}</div>`;
    messagesEl.appendChild(agentDiv);

    // Check for executable actions
    const actions = parseActions(response);
    if (actions.length > 0) {
      const actionDiv = document.createElement('div');
      actionDiv.className = 'chat-msg chat-msg-actions';
      actionDiv.innerHTML = `
        <div class="chat-msg-content">
          <strong>${actions.length} action(s) recommended</strong>
          <button class="action-apply-btn" id="apply-actions-btn">Apply Actions</button>
        </div>`;
      messagesEl.appendChild(actionDiv);

      document.getElementById('apply-actions-btn').addEventListener('click', () => {
        state = applyActions(state, actions);
        saveState(state);
        updateHUD();
        actionDiv.innerHTML = '<div class="chat-msg-content" style="color:#4ade80">✓ Actions applied to greenhouse</div>';
      });
    }
  } catch (err) {
    loadDiv.remove();
    const errDiv = document.createElement('div');
    errDiv.className = 'chat-msg chat-msg-error';
    errDiv.innerHTML = `<div class="chat-msg-content">Error: ${err.message}</div>`;
    messagesEl.appendChild(errDiv);
    chatHistory.pop(); // remove failed user msg from history
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Styles ──────────────────────────────────────────────────────────
const UI_STYLES = `
/* ── Mission HUD ── */
#mission-hud {
  position:fixed;top:20px;right:20px;width:280px;
  padding:14px 16px;
  border:1px solid rgba(255,255,255,0.10);
  background:rgba(0,0,0,0.35);
  backdrop-filter:blur(20px);
  font-family:'DM Mono','DM Sans',monospace;
  color:rgba(255,255,255,0.88);
  z-index:100;pointer-events:auto;
}
.hud-header { display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px; }
.hud-label { font-family:'DM Mono',monospace;font-size:0.58rem;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45); }
.hud-sol { font-family:'DM Mono',monospace;font-size:0.75rem;font-weight:500; }
.hud-grid { display:grid;grid-template-columns:1fr 1fr;gap:1px;background:rgba(255,255,255,0.06);margin-bottom:10px; }
.hud-card { background:rgba(0,0,0,0.3);padding:8px 10px; }
.hud-card-label { font-family:'DM Mono',monospace;font-size:0.52rem;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.4); }
.hud-card-value { font-family:'DM Mono',monospace;font-size:0.85rem;font-weight:500;color:rgba(255,255,255,0.88); }
.hud-modules { max-height:140px;overflow-y:auto;margin-bottom:8px; }
.mod-row { padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.06); }
.mod-name { font-family:'DM Mono',monospace;font-size:0.6rem;font-weight:500;text-transform:uppercase;letter-spacing:0.06em; }
.mod-stats { font-family:'DM Mono',monospace;font-size:0.52rem;color:rgba(255,255,255,0.4); }
.mod-crops { display:flex;flex-wrap:wrap;gap:4px;margin-top:3px; }
.mod-crop { font-family:'DM Mono',monospace;font-size:0.52rem;border:1px solid rgba(255,255,255,0.1);padding:1px 6px;color:rgba(255,255,255,0.6); }
.mod-empty { font-family:'DM Mono',monospace;font-size:0.52rem;color:rgba(255,255,255,0.25); }
.hud-time { display:flex;align-items:baseline;gap:8px;margin-bottom:8px;padding:6px 0;border-top:1px solid rgba(255,255,255,0.06); }
.hud-time-label { font-family:'DM Mono',monospace;font-size:0.52rem;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.35); }
.hud-time-value { font-family:'DM Mono',monospace;font-size:1rem;font-weight:500;letter-spacing:0.06em; }
.hud-speed { font-family:'DM Mono',monospace;font-size:0.62rem;color:rgba(255,255,255,0.4);margin-left:auto; }
.hud-speed-btn.active { background:rgba(255,255,255,0.15);color:rgba(255,255,255,0.95);border-color:rgba(255,255,255,0.25); }
.hud-actions { display:flex;gap:4px;flex-wrap:wrap; }
.hud-btn {
  flex:1;min-width:50px;padding:5px 6px;
  border:1px solid rgba(255,255,255,0.12);background:transparent;
  color:rgba(255,255,255,0.7);font-family:'DM Mono',monospace;font-size:0.58rem;
  cursor:pointer;transition:all 0.15s;letter-spacing:0.04em;
}
.hud-btn:hover { background:rgba(255,255,255,0.06); }
.hud-btn-accent { flex-basis:100%;margin-top:2px;border-color:rgba(255,255,255,0.18); }
.hud-btn-reset { flex-basis:100%;color:rgba(248,113,113,0.8);border-color:rgba(248,113,113,0.2); }
.hud-btn-reset:hover { border-color:rgba(248,113,113,0.5);background:rgba(248,113,113,0.08); }

/* ── Chat Panel ── */
#chat-panel {
  position:fixed;bottom:20px;right:20px;width:360px;max-height:440px;
  border:1px solid rgba(255,255,255,0.10);
  background:rgba(0,0,0,0.35);
  backdrop-filter:blur(20px);
  font-family:'DM Sans',sans-serif;
  color:rgba(255,255,255,0.88);
  z-index:100;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;
}
.chat-header { display:flex;align-items:baseline;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.08);cursor:pointer;user-select:none; }
.chat-title { font-family:'Instrument Serif',serif;font-size:1.1rem;color:rgba(255,255,255,0.88); }
.chat-subtitle { font-family:'DM Mono',monospace;font-size:0.52rem;color:rgba(255,255,255,0.35);flex:1; }
.chat-toggle-icon { font-size:0.6rem;color:rgba(255,255,255,0.3); }
.chat-body { display:flex;flex-direction:column;flex:1;min-height:0;max-height:380px;transition:max-height 0.3s ease; }
.chat-body.collapsed { max-height:0;overflow:hidden; }
.chat-messages { flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;max-height:320px; }
.chat-msg { max-width:92%; }
.chat-msg-user { align-self:flex-end; }
.chat-msg-user .chat-msg-content { background:rgba(255,255,255,0.88);color:#1a1a1a;padding:8px 12px; }
.chat-msg-agent .chat-msg-content { background:transparent;border:1px solid rgba(255,255,255,0.10);padding:8px 12px; }
.chat-msg-content { font-size:0.78rem;line-height:1.55; }
.chat-msg-content h2,.chat-msg-content h3,.chat-msg-content h4 { margin:4px 0;font-family:'Instrument Serif',serif;font-size:0.88rem;font-weight:400; }
.chat-msg-content pre.code-block { background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.08);padding:6px 8px;font-family:'DM Mono',monospace;font-size:0.65rem;overflow-x:auto;white-space:pre-wrap;word-break:break-word; }
.chat-msg-content code { background:rgba(255,255,255,0.08);padding:1px 4px;font-family:'DM Mono',monospace;font-size:0.68rem; }
.chat-msg-content strong { font-weight:600; }
.md-list-item { padding-left:8px; }
.md-table-row { font-family:'DM Mono',monospace;font-size:0.65rem;padding:1px 0;color:rgba(255,255,255,0.6); }
.chat-msg-actions .chat-msg-content { background:transparent;border:1px solid rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:space-between;gap:8px; }
.action-apply-btn { padding:4px 12px;border:1px solid rgba(255,255,255,0.5);background:rgba(255,255,255,0.88);color:#1a1a1a;font-family:'DM Mono',monospace;font-size:0.62rem;cursor:pointer;white-space:nowrap; }
.action-apply-btn:hover { opacity:0.8; }
.chat-msg-error .chat-msg-content { background:transparent;border:1px solid rgba(220,38,38,0.4);color:rgba(248,113,113,0.9); }
.typing-dots { animation:pulse 1.4s infinite;letter-spacing:3px; }
@keyframes pulse { 0%,100%{opacity:0.2} 50%{opacity:1} }
.chat-input-area { display:flex;gap:0;border-top:1px solid rgba(255,255,255,0.08); }
#chat-input { flex:1;padding:10px 14px;border:none;background:transparent;color:rgba(255,255,255,0.88);font-family:'DM Sans',sans-serif;font-size:0.78rem;outline:none; }
#chat-input:focus { background:rgba(255,255,255,0.03); }
#chat-input::placeholder { color:rgba(255,255,255,0.25); }
.chat-send-btn { width:42px;border:none;border-left:1px solid rgba(255,255,255,0.08);background:transparent;color:rgba(255,255,255,0.6);font-size:0.85rem;cursor:pointer;display:flex;align-items:center;justify-content:center; }
.chat-send-btn:hover { background:rgba(255,255,255,0.05); }

/* ── Scrollbar ── */
.chat-messages::-webkit-scrollbar,.hud-modules::-webkit-scrollbar { width:3px; }
.chat-messages::-webkit-scrollbar-track,.hud-modules::-webkit-scrollbar-track { background:transparent; }
.chat-messages::-webkit-scrollbar-thumb,.hud-modules::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1);border-radius:0; }

@media(max-width:900px) {
  #mission-hud { width:220px;top:12px;right:12px; }
  #chat-panel { width:calc(100vw - 24px);right:12px;bottom:12px; }
}
`;
