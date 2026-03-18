/**
 * UI layer: chat panel + mission HUD overlay.
 * Injects HTML into the DOM and manages interactions.
 */

import { sendToAgent, parseActions } from './agent-client.js';
import { createInitialState, advanceSol, applyActions, CROP_DB } from './greenhouse.js';

let state = createInitialState();
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
    <div class="hud-actions">
      <button id="btn-advance-1" class="hud-btn">+1 Sol</button>
      <button id="btn-advance-10" class="hud-btn">+10 Sols</button>
      <button id="btn-advance-30" class="hud-btn">+30 Sols</button>
      <button id="btn-auto-plant" class="hud-btn hud-btn-accent">Ask FLORA to Plan</button>
    </div>
  `;
  app.appendChild(hud);

  // ── Chat Panel (bottom-right) ──
  const chat = document.createElement('div');
  chat.id = 'chat-panel';
  chat.innerHTML = `
    <div class="chat-header" id="chat-toggle">
      <span class="chat-title">FLORA</span>
      <span class="chat-subtitle">Frontier Life-support Operations &amp; Resource Agent</span>
      <span class="chat-toggle-icon" id="chat-toggle-icon">▼</span>
    </div>
    <div class="chat-body" id="chat-body">
      <div class="chat-messages" id="chat-messages">
        <div class="chat-msg chat-msg-agent">
          <div class="chat-msg-content">
            Hello, I'm <strong>FLORA</strong> — your Frontier Life-support Operations &amp; Resource Agent.
            I manage crop planning, resource optimization, and emergency response
            for the 450-day mission. What would you like to do first?
          </div>
        </div>
      </div>
      <div class="chat-input-area">
        <input type="text" id="chat-input" placeholder="Ask FLORA anything..." autocomplete="off" />
        <button id="chat-send" class="chat-send-btn">▶</button>
      </div>
    </div>
  `;
  app.appendChild(chat);

  // ── Inject styles ──
  const style = document.createElement('style');
  style.textContent = UI_STYLES;
  document.head.appendChild(style);

  // ── Wire events ──
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');

  const doSend = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    handleUserMessage(text);
  };

  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });

  document.getElementById('btn-advance-1').addEventListener('click', () => { state = advanceSol(state, 1); updateHUD(); });
  document.getElementById('btn-advance-10').addEventListener('click', () => { state = advanceSol(state, 10); updateHUD(); });
  document.getElementById('btn-advance-30').addEventListener('click', () => { state = advanceSol(state, 30); updateHUD(); });
  document.getElementById('btn-auto-plant').addEventListener('click', () => {
    handleUserMessage('Analyze the current greenhouse state and recommend an optimal crop plan. Provide actions I can execute.');
  });

  // Chat toggle
  document.getElementById('chat-toggle').addEventListener('click', () => {
    const body = document.getElementById('chat-body');
    const icon = document.getElementById('chat-toggle-icon');
    body.classList.toggle('collapsed');
    icon.textContent = body.classList.contains('collapsed') ? '▲' : '▼';
  });

  updateHUD();
  return { getState: () => state, setState: (s) => { state = s; updateHUD(); } };
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
  position: fixed;
  top: 22px;
  right: 22px;
  width: 320px;
  padding: 14px 16px;
  border: 1px solid rgba(255,219,188,0.18);
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(255,213,173,0.08), rgba(34,15,22,0.3)), rgba(18,12,16,0.5);
  backdrop-filter: blur(20px);
  font-family: 'Space Grotesk', monospace;
  color: #fff8f1;
  z-index: 100;
  pointer-events: auto;
}
.hud-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.hud-label {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #ffd8b0;
}
.hud-sol {
  font-size: 0.8rem;
  font-weight: 700;
  color: #fff;
  font-family: 'Sora', monospace;
}
.hud-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-bottom: 10px;
}
.hud-card {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,219,188,0.1);
  border-radius: 8px;
  padding: 6px 8px;
}
.hud-card-label {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(255,237,224,0.5);
}
.hud-card-value {
  font-size: 1rem;
  font-weight: 700;
  color: #4ade80;
}
.hud-modules {
  max-height: 140px;
  overflow-y: auto;
  margin-bottom: 8px;
}
.mod-row {
  padding: 4px 0;
  border-bottom: 1px solid rgba(255,219,188,0.06);
}
.mod-name {
  font-size: 0.7rem;
  font-weight: 700;
  color: #ffd8b0;
}
.mod-stats {
  font-size: 0.6rem;
  color: rgba(255,237,224,0.5);
}
.mod-crops {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.mod-crop {
  font-size: 0.58rem;
  background: rgba(74,222,128,0.15);
  color: #4ade80;
  padding: 1px 6px;
  border-radius: 4px;
}
.mod-empty {
  font-size: 0.58rem;
  color: rgba(255,237,224,0.3);
  font-style: italic;
}
.hud-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.hud-btn {
  flex: 1;
  min-width: 60px;
  padding: 5px 6px;
  border: 1px solid rgba(255,219,188,0.2);
  border-radius: 6px;
  background: rgba(255,255,255,0.05);
  color: #fff8f1;
  font-family: 'Space Grotesk', monospace;
  font-size: 0.65rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.hud-btn:hover {
  background: rgba(255,219,188,0.15);
  border-color: rgba(255,219,188,0.4);
}
.hud-btn-accent {
  background: rgba(255,176,100,0.15);
  border-color: rgba(255,176,100,0.3);
  color: #ffd8b0;
  flex-basis: 100%;
  margin-top: 2px;
}
.hud-btn-accent:hover {
  background: rgba(255,176,100,0.25);
}

/* ── Chat Panel ── */
#chat-panel {
  position: fixed;
  bottom: 22px;
  right: 22px;
  width: 380px;
  max-height: 480px;
  border: 1px solid rgba(255,219,188,0.18);
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(255,213,173,0.06), rgba(34,15,22,0.35)), rgba(12,8,12,0.7);
  backdrop-filter: blur(24px);
  font-family: 'Space Grotesk', monospace;
  color: #fff8f1;
  z-index: 100;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  pointer-events: auto;
}
.chat-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255,219,188,0.1);
  cursor: pointer;
  user-select: none;
}
.chat-title {
  font-family: 'Sora', monospace;
  font-size: 1rem;
  font-weight: 700;
  color: #ffd8b0;
}
.chat-subtitle {
  font-size: 0.65rem;
  color: rgba(255,237,224,0.5);
  flex: 1;
}
.chat-toggle-icon {
  font-size: 0.7rem;
  color: rgba(255,237,224,0.4);
}
.chat-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  max-height: 400px;
  transition: max-height 0.3s ease;
}
.chat-body.collapsed {
  max-height: 0;
  overflow: hidden;
}
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 340px;
}
.chat-msg {
  max-width: 95%;
}
.chat-msg-user {
  align-self: flex-end;
}
.chat-msg-user .chat-msg-content {
  background: rgba(255,176,100,0.15);
  border: 1px solid rgba(255,176,100,0.2);
  border-radius: 12px 12px 2px 12px;
}
.chat-msg-agent .chat-msg-content {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,219,188,0.08);
  border-radius: 12px 12px 12px 2px;
}
.chat-msg-content {
  padding: 8px 12px;
  font-size: 0.78rem;
  line-height: 1.5;
}
.chat-msg-content h2, .chat-msg-content h3, .chat-msg-content h4 {
  margin: 6px 0 4px;
  font-size: 0.85rem;
  color: #ffd8b0;
}
.chat-msg-content pre.code-block {
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,219,188,0.1);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 0.68rem;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-msg-content code {
  background: rgba(255,219,188,0.1);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.72rem;
}
.chat-msg-content strong {
  color: #ffd8b0;
}
.md-list-item {
  padding-left: 8px;
}
.md-table-row {
  font-size: 0.7rem;
  font-family: monospace;
  padding: 1px 0;
  color: rgba(255,237,224,0.8);
}
.chat-msg-actions .chat-msg-content {
  background: rgba(74,222,128,0.08);
  border: 1px solid rgba(74,222,128,0.2);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.action-apply-btn {
  padding: 4px 12px;
  border: 1px solid rgba(74,222,128,0.4);
  border-radius: 6px;
  background: rgba(74,222,128,0.15);
  color: #4ade80;
  font-family: 'Space Grotesk', monospace;
  font-size: 0.7rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.action-apply-btn:hover {
  background: rgba(74,222,128,0.3);
}
.chat-msg-error .chat-msg-content {
  background: rgba(248,113,113,0.1);
  border: 1px solid rgba(248,113,113,0.2);
  color: #f87171;
  border-radius: 8px;
}
.typing-dots {
  animation: pulse 1.2s infinite;
  letter-spacing: 2px;
}
@keyframes pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
.chat-input-area {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid rgba(255,219,188,0.08);
}
#chat-input {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid rgba(255,219,188,0.15);
  border-radius: 8px;
  background: rgba(255,255,255,0.04);
  color: #fff8f1;
  font-family: 'Space Grotesk', monospace;
  font-size: 0.78rem;
  outline: none;
}
#chat-input:focus {
  border-color: rgba(255,219,188,0.35);
  background: rgba(255,255,255,0.06);
}
#chat-input::placeholder {
  color: rgba(255,237,224,0.3);
}
.chat-send-btn {
  width: 36px;
  height: 36px;
  border: 1px solid rgba(255,176,100,0.3);
  border-radius: 8px;
  background: rgba(255,176,100,0.12);
  color: #ffd8b0;
  font-size: 0.9rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.chat-send-btn:hover {
  background: rgba(255,176,100,0.25);
}

/* ── Scrollbar ── */
.chat-messages::-webkit-scrollbar,
.hud-modules::-webkit-scrollbar {
  width: 4px;
}
.chat-messages::-webkit-scrollbar-track,
.hud-modules::-webkit-scrollbar-track {
  background: transparent;
}
.chat-messages::-webkit-scrollbar-thumb,
.hud-modules::-webkit-scrollbar-thumb {
  background: rgba(255,219,188,0.15);
  border-radius: 2px;
}

/* ── Responsive ── */
@media (max-width: 900px) {
  #mission-hud {
    width: 260px;
    top: 12px;
    right: 12px;
  }
  #chat-panel {
    width: calc(100vw - 24px);
    right: 12px;
    bottom: 12px;
  }
}
`;
