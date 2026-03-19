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

// ── Real-time sol progression ──────────────────────────────────────
const REAL_SOL_SEC = 88775;
let solFraction = 0;
let simSpeed = parseInt(localStorage.getItem('flora-sim-speed') || '1500');
let simStarted = false;
let lastTime = performance.now() / 1000;

// Expose controls for ui.js and dashboard
window.__flora3d = {
  getSimSpeed: () => simSpeed,
  setSimSpeed: (s) => { simSpeed = s; localStorage.setItem('flora-sim-speed', String(s)); },
  getSolFraction: () => solFraction,
  resetSolFraction: () => { solFraction = 0; simStarted = false; showStartOverlay(); },
  isStarted: () => simStarted,
  start: () => { simStarted = true; hideStartOverlay(); },
};

// ── Start overlay ──────────────────────────────────────────────────
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

function hideStartOverlay() {
  startOverlay.classList.add('hidden');
}
function showStartOverlay() {
  startOverlay.classList.remove('hidden');
}

document.getElementById('start-3d-btn').onclick = () => {
  simStarted = true;
  hideStartOverlay();
  // Also set started in the UI state so it persists to server
  if (window.__floraUI?.setStarted) window.__floraUI.setStarted(true);
};

// Poll for started flag + speed changes from other tabs (via localStorage)
setInterval(() => {
  const serverStarted = window.__floraUI?.getStarted?.() ?? false;
  if (serverStarted && !simStarted) {
    simStarted = true;
    hideStartOverlay();
  } else if (!serverStarted && simStarted) {
    simStarted = false;
    solFraction = 0;
    showStartOverlay();
  }

  // Speed sync from dashboard
  const storedSpeed = localStorage.getItem('flora-sim-speed');
  if (storedSpeed !== null) {
    const s = parseInt(storedSpeed);
    if (!isNaN(s) && s !== simSpeed) {
      simSpeed = s;
    }
  }

  // Share solFraction with dashboard
  localStorage.setItem('flora-sol-fraction', String(solFraction));
}, 500);

// ── Animation loop ─────────────────────────────────────────────────
renderer.setAnimationLoop(() => {
  const elapsed = clock.getElapsedTime();
  const now = performance.now() / 1000;
  const dt = Math.min(now - lastTime, 0.1);
  lastTime = now;

  if (simStarted && simSpeed > 0) {
    solFraction += (dt / REAL_SOL_SEC) * simSpeed;
    if (solFraction >= 1) {
      solFraction -= 1;
      if (window.__floraUI?.advanceSol) {
        window.__floraUI.advanceSol();
      }
    }
  }

  // Always render the scene (camera orbit works even before start)
  experience.setTimeOfDay(simStarted ? solFraction : 0.4); // static daytime before start

  const currentSol = window.__floraUI?.getCurrentSol?.() ?? 1;
  if (simStarted) {
    experience.setMissionProgress(currentSol, solFraction);
  } else {
    // Before start: show empty terrain (everything hidden at t<0)
    experience.setMissionProgress(0, 0);
  }

  experience.update(elapsed);
  experience.render();
});

window.addEventListener('dblclick', () => {
  experience.resetCamera();
});

// Initialize UI
const ui = initUI();
