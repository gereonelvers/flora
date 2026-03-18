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

renderer.setAnimationLoop(() => {
  const elapsed = clock.getElapsedTime();
  experience.update(elapsed);
  experience.render();
});

window.addEventListener('dblclick', () => {
  experience.resetCamera();
});

// Initialize ARIA UI
const ui = initUI();
