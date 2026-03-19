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
// 1 sol = SOL_DURATION_SEC real seconds (default 60s for demo)
const SOL_DURATION_SEC = 60;
let solFraction = 0.35; // start at morning (0=midnight, 0.5=noon)
let simSpeed = 1; // 1x, 2x, 5x, 0 = paused
let lastTime = performance.now() / 1000;

// Expose controls for ui.js
window.__flora3d = {
  getSimSpeed: () => simSpeed,
  setSimSpeed: (s) => { simSpeed = s; },
  getSolFraction: () => solFraction,
};

renderer.setAnimationLoop(() => {
  const elapsed = clock.getElapsedTime();
  const now = performance.now() / 1000;
  const dt = Math.min(now - lastTime, 0.1); // cap delta to avoid jumps
  lastTime = now;

  // Advance sol fraction
  if (simSpeed > 0) {
    solFraction += (dt / SOL_DURATION_SEC) * simSpeed;
    if (solFraction >= 1) {
      solFraction -= 1;
      // Trigger sol advance in the UI layer
      if (window.__floraUI?.advanceSol) {
        window.__floraUI.advanceSol();
      }
    }
  }

  // Drive day/night cycle
  experience.setTimeOfDay(solFraction);

  experience.update(elapsed);
  experience.render();
});

window.addEventListener('dblclick', () => {
  experience.resetCamera();
});

// Initialize UI
const ui = initUI();
