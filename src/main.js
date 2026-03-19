import './style.css';
import * as THREE from 'three';
import { createMarsBaseExperience } from './scene.js';
import { initUI } from './ui.js';

const root = document.querySelector('#app');

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.6;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.style.touchAction = 'none';

root.appendChild(renderer.domElement);

const experience = createMarsBaseExperience(renderer);

function resize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  experience.resize(window.innerWidth, window.innerHeight);
}

window.addEventListener('resize', resize);

const clock = new THREE.Clock();
const REAL_SOL_SEC = 88775;

// ── All sim state lives here, synced to/from server via ui.js ────────
let solFraction = 0;
let simSpeed = 1500;
let simStarted = false;
let lastTime = performance.now() / 1000;
let suppressPoll = false; // prevent polls from overwriting after reset/start

// Read state from server (via ui.js) — called on init and periodically
function readFromServer() {
  if (suppressPoll) return;
  const s = window.__floraUI?.getState?.();
  if (!s?.mission) return;

  // Speed: always take from server (dashboard may have changed it)
  if (s.mission.simSpeed != null) simSpeed = s.mission.simSpeed;

  // Started: sync both directions
  if (s.mission.started && !simStarted) {
    simStarted = true;
    solFraction = s.mission.solFraction || 0;
    // Interpolate to catch up
    if (s.mission.solFractionUpdatedAt) {
      const elapsed = (Date.now() - s.mission.solFractionUpdatedAt) / 1000;
      solFraction = (solFraction + (elapsed / REAL_SOL_SEC) * simSpeed) % 1;
    }
    hideStartOverlay();
  } else if (!s.mission.started && simStarted) {
    simStarted = false;
    solFraction = 0;
    simSpeed = 1500;
    showStartOverlay();
  }
}

// Write time to server — fetches latest state first to avoid overwriting
// simSpeed changes from the dashboard (cross-device sync).
const STATE_API = 'https://lwx98cb4sg.execute-api.us-east-1.amazonaws.com/state';
let writeInProgress = false;

async function writeToServer() {
  if (writeInProgress) return;
  writeInProgress = true;
  try {
    // Read simSpeed from server (dashboard on another device may have changed it)
    const res = await fetch(STATE_API);
    if (res.ok) {
      const serverState = await res.json();
      if (serverState?.mission?.simSpeed != null) simSpeed = serverState.mission.simSpeed;
    }

    // Write LOCAL state (which has the correct currentSol) with updated time fields
    const s = window.__floraUI?.getState?.();
    if (!s?.mission) return;
    s.mission.simSpeed = simSpeed;
    s.mission.solFraction = solFraction;
    s.mission.solFractionUpdatedAt = Date.now();
    window.__floraUI?.saveState?.(s);
  } catch {} finally {
    writeInProgress = false;
  }
}

// ── Expose controls ──────────────────────────────────────────────────
window.__flora3d = {
  getSimSpeed: () => simSpeed,
  setSimSpeed: (s) => {
    simSpeed = s;
    // Write speed + current time to server
    const st = window.__floraUI?.getState?.();
    if (st?.mission) {
      st.mission.simSpeed = s;
      st.mission.solFraction = solFraction;
      st.mission.solFractionUpdatedAt = Date.now();
      window.__floraUI?.saveState?.(st);
    }
  },
  getSolFraction: () => solFraction,
  resetSolFraction: () => {
    suppressPoll = true;
    solFraction = 0;
    simSpeed = 1500;
    simStarted = false;
    showStartOverlay();
    setTimeout(() => { suppressPoll = false; }, 5000);
  },
  isStarted: () => simStarted,
  start: () => {
    suppressPoll = true;
    simStarted = true;
    solFraction = 0;
    simSpeed = 1500;
    hideStartOverlay();
    if (window.__floraUI?.setStarted) window.__floraUI.setStarted(true);
    writeToServer();
    setTimeout(() => { suppressPoll = false; }, 3000);
  },
};

// ── Start overlay ────────────────────────────────────────────────────
const startOverlay = document.createElement('div');
startOverlay.id = 'start-overlay';
startOverlay.innerHTML = `
  <div class="start-3d-content">
    <div class="start-3d-logo">FLORA</div>
    <div class="start-3d-sub">Frontier Life-support Operations & Resource Agent</div>
    <button class="start-3d-btn" id="start-3d-btn">Initialize Mission</button>
    <div class="start-3d-meta">Valles Marineris · 450-day mission · 4 crew</div>
  </div>
`;
root.appendChild(startOverlay);

const startStyle = document.createElement('style');
startStyle.textContent = `
#start-overlay {
  position:fixed;inset:0;z-index:200;
  display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,0.55);backdrop-filter:blur(8px);
  transition:opacity 0.4s;
}
#start-overlay.hidden { opacity:0;pointer-events:none; }
.start-3d-content { text-align:center; }
.start-3d-logo {
  font-family:'Instrument Serif',Georgia,serif;font-size:3.5rem;
  color:rgba(255,255,255,0.92);letter-spacing:-0.03em;margin-bottom:4px;
}
.start-3d-sub {
  font-family:'DM Mono',monospace;font-size:0.58rem;
  text-transform:uppercase;letter-spacing:0.14em;
  color:rgba(255,255,255,0.4);margin-bottom:28px;
}
.start-3d-btn {
  padding:14px 40px;border:1px solid rgba(255,255,255,0.7);
  background:rgba(255,255,255,0.9);color:#1a1a1a;
  font-family:'DM Mono',monospace;font-size:0.72rem;font-weight:500;
  letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;
  transition:opacity 0.15s;
}
.start-3d-btn:hover { opacity:0.85; }
.start-3d-meta {
  font-family:'DM Mono',monospace;font-size:0.48rem;
  color:rgba(255,255,255,0.25);margin-top:16px;letter-spacing:0.06em;
}
`;
document.head.appendChild(startStyle);

function hideStartOverlay() { startOverlay.classList.add('hidden'); }
function showStartOverlay() { startOverlay.classList.remove('hidden'); }

document.getElementById('start-3d-btn').onclick = () => {
  window.__flora3d.start();
};

// ── Poll server state every 500ms ────────────────────────────────────
setInterval(readFromServer, 500);

// ── Animation loop ───────────────────────────────────────────────────
renderer.setAnimationLoop(() => {
  const elapsed = clock.getElapsedTime();
  const now = performance.now() / 1000;
  const dt = Math.min(now - lastTime, 0.1);
  lastTime = now;

  // Advance time
  if (simStarted && simSpeed > 0) {
    solFraction += (dt / REAL_SOL_SEC) * simSpeed;
    if (solFraction >= 1) {
      solFraction -= 1;
      if (window.__floraUI?.advanceSol) {
        window.__floraUI.advanceSol();
      }
    }
  }

  // Write to server every ~2s (always while started, even if paused)
  if (simStarted && Math.floor(now * 0.5) !== Math.floor((now - dt) * 0.5)) {
    writeToServer();
  }

  // Render
  experience.setTimeOfDay(simStarted ? solFraction : 0.4);
  const currentSol = window.__floraUI?.getCurrentSol?.() ?? 1;
  if (simStarted) {
    experience.setMissionProgress(currentSol, solFraction);
  } else {
    experience.setMissionProgress(0, 0);
  }

  experience.update(elapsed);
  experience.render();
});

window.addEventListener('dblclick', () => {
  experience.resetCamera();
});

// Initialize UI (loads state from server)
const ui = initUI();
