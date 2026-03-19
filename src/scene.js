import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';


import { createSeededRandom, fbm2D, ridge2D } from './noise.js';

const SCENE_SEED = 20260318;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const SUN_DIRECTION = new THREE.Vector3(-0.76, 0.61, -0.22).normalize();

function clamp01(value) {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function makeCanvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  draw(context, width, height);
  return new THREE.CanvasTexture(canvas);
}

function setTextureDefaults(texture, renderer, { repeat = [1, 1], srgb = true } = {}) {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat[0], repeat[1]);
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  if (srgb) {
    texture.colorSpace = THREE.SRGBColorSpace;
  }

  texture.needsUpdate = true;
  return texture;
}

function createTextures(renderer) {
  const seededRandom = createSeededRandom(SCENE_SEED);

  const terrainMap = setTextureDefaults(
    makeCanvasTexture(512, 512, (ctx, width, height) => {
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#7a4030');
      gradient.addColorStop(0.28, '#9a5838');
      gradient.addColorStop(0.62, '#b57042');
      gradient.addColorStop(1, '#d49060');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      for (let i = 0; i < 8000; i += 1) {
        const x = seededRandom() * width;
        const y = seededRandom() * height;
        const size = seededRandom() * 5 + 0.35;
        const alpha = seededRandom() * 0.16;

        ctx.fillStyle = `rgba(42, 14, 9, ${alpha.toFixed(3)})`;
        ctx.fillRect(x, y, size, size);
      }

      ctx.globalAlpha = 0.18;
      for (let i = 0; i < 220; i += 1) {
        const y = seededRandom() * height;
        const amplitude = 6 + seededRandom() * 16;
        const wavelength = 80 + seededRandom() * 170;

        ctx.beginPath();
        ctx.moveTo(0, y);

        for (let x = 0; x <= width; x += 12) {
          const waveY = y + Math.sin(x / wavelength + i) * amplitude;
          ctx.lineTo(x, waveY);
        }

        ctx.strokeStyle = 'rgba(255, 205, 158, 0.18)';
        ctx.lineWidth = 1 + seededRandom() * 1.5;
        ctx.stroke();
      }

      ctx.globalAlpha = 0.12;
      for (let i = 0; i < 180; i += 1) {
        const x = seededRandom() * width;
        const y = seededRandom() * height;
        const radius = 14 + seededRandom() * 40;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
        glow.addColorStop(0, 'rgba(255, 183, 120, 0.38)');
        glow.addColorStop(1, 'rgba(255, 183, 120, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
    }),
    renderer,
    { repeat: [18, 18] },
  );

  const metalMap = setTextureDefaults(
    makeCanvasTexture(1024, 1024, (ctx, width, height) => {
      ctx.fillStyle = '#9a908d';
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(62, 46, 41, 0.32)';

      for (let x = 0; x <= width; x += 96) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      for (let y = 0; y <= height; y += 96) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      for (let i = 0; i < 8000; i += 1) {
        const x = seededRandom() * width;
        const y = seededRandom() * height;
        const brightness = 160 + Math.floor(seededRandom() * 70);
        const alpha = 0.03 + seededRandom() * 0.06;
        ctx.fillStyle = `rgba(${brightness}, ${brightness - 8}, ${brightness - 12}, ${alpha.toFixed(3)})`;
        ctx.fillRect(x, y, 2 + seededRandom() * 3, 2 + seededRandom() * 3);
      }

      ctx.fillStyle = 'rgba(255, 220, 204, 0.24)';
      for (let y = 32; y < height; y += 96) {
        for (let x = 32; x < width; x += 96) {
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }),
    renderer,
    { repeat: [6, 6] },
  );

  const deckMap = setTextureDefaults(
    makeCanvasTexture(1024, 1024, (ctx, width, height) => {
      ctx.fillStyle = '#74635d';
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = 'rgba(255, 214, 176, 0.11)';
      for (let i = 0; i < 20; i += 1) {
        ctx.fillRect(0, (height / 20) * i, width, 2);
      }

      ctx.lineWidth = 20;
      ctx.strokeStyle = 'rgba(255, 168, 94, 0.58)';
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, width * 0.33, 0, Math.PI * 2);
      ctx.stroke();

      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(255, 245, 236, 0.54)';
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, width * 0.22, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255, 210, 165, 0.44)';
      ctx.lineWidth = 6;
      ctx.setLineDash([52, 28]);
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, width * 0.13, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(255, 212, 160, 0.42)';
      for (let i = 0; i < 4; i += 1) {
        const angle = (i / 4) * Math.PI * 2;
        ctx.save();
        ctx.translate(width / 2, height / 2);
        ctx.rotate(angle);
        ctx.fillRect(width * 0.14, -12, width * 0.09, 24);
        ctx.restore();
      }

      ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
      for (let i = 0; i < 1400; i += 1) {
        const x = seededRandom() * width;
        const y = seededRandom() * height;
        const size = seededRandom() * 8 + 1;
        ctx.fillRect(x, y, size, size * 0.4);
      }
    }),
    renderer,
    { repeat: [2, 2] },
  );

  const solarMap = setTextureDefaults(
    makeCanvasTexture(1024, 512, (ctx, width, height) => {
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#071019');
      gradient.addColorStop(0.35, '#132f43');
      gradient.addColorStop(1, '#0c1823');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = 'rgba(104, 178, 222, 0.42)';
      ctx.lineWidth = 2;
      for (let x = 0; x <= width; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      for (let y = 0; y <= height; y += 48) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(137, 227, 255, 0.14)';
      for (let i = 0; i < 2000; i += 1) {
        const x = seededRandom() * width;
        const y = seededRandom() * height;
        ctx.fillRect(x, y, 1.5, 1.5);
      }
    }),
    renderer,
    { repeat: [1, 1] },
  );

  const skyMap = makeCanvasTexture(1024, 512, (ctx, width, height) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#c4836a');
    gradient.addColorStop(0.2, '#c8855e');
    gradient.addColorStop(0.45, '#d49768');
    gradient.addColorStop(0.7, '#dea872');
    gradient.addColorStop(0.9, '#e8be88');
    gradient.addColorStop(1, '#f0d0a0');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    const haze = ctx.createLinearGradient(0, height * 0.58, 0, height);
    haze.addColorStop(0, 'rgba(255, 166, 118, 0)');
    haze.addColorStop(1, 'rgba(255, 203, 152, 0.38)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, height * 0.56, width, height * 0.44);

    for (let i = 0; i < 600; i += 1) {
      const x = seededRandom() * width;
      const y = height * 0.08 + seededRandom() * height * 0.42;
      const size = seededRandom() * 2 + 0.6;
      ctx.fillStyle = `rgba(255, 214, 192, ${(seededRandom() * 0.06).toFixed(3)})`;
      ctx.fillRect(x, y, size, size);
    }

    ctx.globalAlpha = 0.12;
    for (let i = 0; i < 16; i += 1) {
      const bandY = height * (0.14 + i * 0.042);
      ctx.beginPath();
      ctx.moveTo(0, bandY);
      for (let x = 0; x <= width; x += 24) {
        const wave = Math.sin(x / 120 + i * 0.7) * 12 + Math.cos(x / 240 + i) * 7;
        ctx.lineTo(x, bandY + wave);
      }
      ctx.strokeStyle = 'rgba(255, 198, 148, 0.26)';
      ctx.lineWidth = 8;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  });
  skyMap.colorSpace = THREE.SRGBColorSpace;
  skyMap.needsUpdate = true;

  const dustSprite = makeCanvasTexture(128, 128, (ctx, width, height) => {
    const gradient = ctx.createRadialGradient(
      width / 2,
      height / 2,
      width * 0.08,
      width / 2,
      height / 2,
      width * 0.48,
    );

    gradient.addColorStop(0, 'rgba(255, 235, 210, 1)');
    gradient.addColorStop(0.3, 'rgba(255, 220, 182, 0.7)');
    gradient.addColorStop(0.7, 'rgba(255, 174, 120, 0.18)');
    gradient.addColorStop(1, 'rgba(255, 174, 120, 0)');

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  });
  dustSprite.colorSpace = THREE.SRGBColorSpace;
  dustSprite.needsUpdate = true;

  const sunSprite = makeCanvasTexture(512, 512, (ctx, width, height) => {
    const gradient = ctx.createRadialGradient(
      width / 2,
      height / 2,
      width * 0.04,
      width / 2,
      height / 2,
      width * 0.46,
    );

    gradient.addColorStop(0, 'rgba(255, 248, 235, 1)');
    gradient.addColorStop(0.18, 'rgba(255, 224, 185, 0.85)');
    gradient.addColorStop(0.48, 'rgba(255, 166, 102, 0.24)');
    gradient.addColorStop(1, 'rgba(255, 150, 88, 0)');

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  });
  sunSprite.colorSpace = THREE.SRGBColorSpace;
  sunSprite.needsUpdate = true;

  return {
    terrainMap,
    metalMap,
    deckMap,
    solarMap,
    skyMap,
    dustSprite,
    sunSprite,
  };
}

function createLighting(scene) {
  const hemisphere = new THREE.HemisphereLight(0xffeedd, 0x8b5a3a, 1.8);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff4e8, 5.5);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(260);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 300;
  sun.shadow.camera.left = -100;
  sun.shadow.camera.right = 100;
  sun.shadow.camera.top = 100;
  sun.shadow.camera.bottom = -100;
  sun.shadow.bias = -0.00012;
  sun.target.position.set(6, 10, -8);
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.DirectionalLight(0xffb88a, 0.8);
  fill.position.set(170, 40, 120);
  scene.add(fill);

  const coolRim = new THREE.DirectionalLight(0xc8e8ff, 0.5);
  coolRim.position.set(-110, 26, 148);
  scene.add(coolRim);

  return { hemisphere, sun, fill, coolRim };
}

function createMoonMesh(radius, color) {
  const geometry = new THREE.IcosahedronGeometry(radius, 2);
  const position = geometry.attributes.position;

  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const stretch =
      1 +
      (fbm2D(x * 0.6, z * 0.6, 4, 2, 0.5, SCENE_SEED + index) - 0.5) * 0.35 +
      (ridge2D(x * 0.9, y * 0.9, 3, 2.1, 0.5, SCENE_SEED + 41) - 0.5) * 0.18;

    position.setXYZ(index, x * stretch, y * stretch, z * stretch);
  }

  geometry.computeVertexNormals();

  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color,
      roughness: 1,
      metalness: 0.02,
    }),
  );
}

function createAtmosphere(scene, textures, animated) {
  const skySphere = new THREE.Mesh(
    new THREE.SphereGeometry(720, 32, 16),
    new THREE.MeshBasicMaterial({
      map: textures.skyMap,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  scene.add(skySphere);

  const hazeSphere = new THREE.Mesh(
    new THREE.SphereGeometry(380, 24, 12),
    new THREE.MeshBasicMaterial({
      color: 0xf28f5e,
      transparent: true,
      opacity: 0.04,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  hazeSphere.scale.set(1, 0.62, 1);
  hazeSphere.position.y = -36;
  scene.add(hazeSphere);

  const sunGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: textures.sunSprite,
      color: 0xffcf96,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.84,
    }),
  );
  sunGlow.position.copy(SUN_DIRECTION).multiplyScalar(330);
  sunGlow.position.y = Math.max(sunGlow.position.y, 120);
  sunGlow.scale.setScalar(90);
  scene.add(sunGlow);

  const horizonDisc = new THREE.Mesh(
    new THREE.RingGeometry(180, 330, 48),
    new THREE.MeshBasicMaterial({
      color: 0xffa867,
      transparent: true,
      opacity: 0.05,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  horizonDisc.rotation.x = -Math.PI / 2;
  horizonDisc.position.y = 7;
  scene.add(horizonDisc);

  const phobos = createMoonMesh(6, 0x8d7566);
  phobos.position.set(146, 112, -220);
  scene.add(phobos);

  const deimos = createMoonMesh(3.2, 0x938171);
  deimos.position.set(-220, 134, -130);
  scene.add(deimos);

  animated.push((elapsed) => {
    phobos.position.x = Math.cos(elapsed * 0.05) * 180;
    phobos.position.y = 120 + Math.sin(elapsed * 0.07) * 14;
    phobos.position.z = -200 + Math.sin(elapsed * 0.05) * 40;
    phobos.rotation.y += 0.0008;

    deimos.position.x = -200 + Math.sin(elapsed * 0.03) * 26;
    deimos.position.y = 136 + Math.cos(elapsed * 0.04) * 8;
    deimos.position.z = -130 + Math.cos(elapsed * 0.03) * 22;
    deimos.rotation.y -= 0.0005;

    sunGlow.material.opacity = 0.78 + Math.sin(elapsed * 0.22) * 0.04;
    hazeSphere.rotation.y = elapsed * 0.0015;
  });
}

function getTerrainHeight(x, z) {
  const radialDistance = Math.hypot(x, z);
  const broadNoise = (fbm2D(x * 0.0048, z * 0.0048, 6, 2.02, 0.54, SCENE_SEED) - 0.5) * 46;
  const ridgeNoise = (ridge2D(x * 0.013, z * 0.013, 5, 2.08, 0.56, SCENE_SEED + 31) - 0.5) * 30;
  const duneNoise =
    Math.sin(x * 0.054 + z * 0.02) * 2.8 +
    Math.cos(z * 0.045 - x * 0.017) * 2.1 +
    Math.sin((x + z) * 0.028) * 1.8;
  const basin = -Math.exp(-(x * x + z * z) / 4200) * 18;
  const landingBasin = -Math.exp(-((x - 60) ** 2 + (z + 34) ** 2) / 1800) * 10;
  const crater = -Math.exp(-((x + 104) ** 2 + (z - 32) ** 2) / 1150) * 16;
  const rimRise =
    THREE.MathUtils.smoothstep(radialDistance, 124, 228) *
    (18 + ridge2D(x * 0.018, z * 0.018, 4, 2.12, 0.55, SCENE_SEED + 48) * 42);
  const backWall =
    THREE.MathUtils.smoothstep(-z, 82, 226) *
    (12 + ridge2D(x * 0.02, z * 0.012, 4, 2.08, 0.55, SCENE_SEED + 93) * 46);
  const sideWalls =
    THREE.MathUtils.smoothstep(Math.abs(x), 136, 226) *
    (6 + ridge2D(x * 0.014, z * 0.018, 4, 2.1, 0.55, SCENE_SEED + 67) * 28);
  const stationShelf = -Math.exp(-(x * x + z * z) / 860) * 9;

  return broadNoise + ridgeNoise * 0.72 + duneNoise + basin + landingBasin + crater + rimRise + backWall + sideWalls + stationShelf + 6;
}

function distortRockGeometry(geometry, amplitude) {
  const position = geometry.attributes.position;

  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const noise = fbm2D(x * 1.1, z * 1.1, 4, 2.2, 0.55, SCENE_SEED + 71 + index);
    const scale = 1 + (noise - 0.5) * amplitude + (y > 0 ? 0.08 : -0.04);
    position.setXYZ(index, x * scale, y * scale * 1.12, z * scale);
  }

  geometry.computeVertexNormals();
  return geometry;
}

function createRockField(scene, getHeightAt) {
  const seededRandom = createSeededRandom(SCENE_SEED + 99);
  const nearGeometry = distortRockGeometry(new THREE.DodecahedronGeometry(1, 0), 0.6);
  const farGeometry = distortRockGeometry(new THREE.IcosahedronGeometry(1, 1), 0.4);

  const nearRocks = new THREE.InstancedMesh(
    nearGeometry,
    new THREE.MeshStandardMaterial({
      color: 0x6e3523,
      roughness: 1,
      metalness: 0.01,
    }),
    150,
  );
  nearRocks.castShadow = false;
  nearRocks.receiveShadow = true;

  const farRocks = new THREE.InstancedMesh(
    farGeometry,
    new THREE.MeshStandardMaterial({
      color: 0x7d4a31,
      roughness: 1,
      metalness: 0.01,
    }),
    56,
  );
  farRocks.castShadow = false;
  farRocks.receiveShadow = false;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const rotation = new THREE.Euler();
  const scale = new THREE.Vector3();

  for (let index = 0; index < 150; index += 1) {
    let radialDistance = 42 + seededRandom() * 160;
    let angle = seededRandom() * Math.PI * 2;
    if (radialDistance < 75 && Math.abs(angle) < 0.8) {
      radialDistance += 24;
    }
    position.set(
      Math.cos(angle) * radialDistance + (seededRandom() - 0.5) * 12,
      0,
      Math.sin(angle) * radialDistance + (seededRandom() - 0.5) * 12,
    );
    position.y = getHeightAt(position.x, position.z);

    rotation.set(seededRandom() * Math.PI, seededRandom() * Math.PI, seededRandom() * Math.PI);
    quaternion.setFromEuler(rotation);

    const size = 0.45 + seededRandom() * 3.6;
    scale.set(size * (0.7 + seededRandom() * 0.6), size, size * (0.8 + seededRandom() * 0.5));

    matrix.compose(position, quaternion, scale);
    nearRocks.setMatrixAt(index, matrix);
    nearRocks.setColorAt(index, new THREE.Color().setHSL(0.052, 0.42, 0.15 + seededRandom() * 0.1));
  }

  for (let index = 0; index < farRocks.count; index += 1) {
    const radialDistance = 170 + seededRandom() * 70;
    const angle = seededRandom() * Math.PI * 2;
    position.set(
      Math.cos(angle) * radialDistance + (seededRandom() - 0.5) * 16,
      0,
      Math.sin(angle) * radialDistance + (seededRandom() - 0.5) * 16,
    );
    position.y = getHeightAt(position.x, position.z);

    rotation.set(seededRandom() * Math.PI, seededRandom() * Math.PI, seededRandom() * Math.PI);
    quaternion.setFromEuler(rotation);

    const size = 5 + seededRandom() * 10;
    scale.set(size * (0.6 + seededRandom() * 0.5), size, size * (0.8 + seededRandom() * 0.5));

    matrix.compose(position, quaternion, scale);
    farRocks.setMatrixAt(index, matrix);
    farRocks.setColorAt(index, new THREE.Color().setHSL(0.065, 0.34, 0.2 + seededRandom() * 0.08));
  }

  nearRocks.instanceMatrix.needsUpdate = true;
  farRocks.instanceMatrix.needsUpdate = true;
  nearRocks.instanceColor.needsUpdate = true;
  farRocks.instanceColor.needsUpdate = true;

  scene.add(nearRocks, farRocks);
}

function createTerrain(scene, textures) {
  const geometry = new THREE.PlaneGeometry(460, 460, 160, 160);
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position;
  const colors = [];
  const lowColor = new THREE.Color(0x8b4a2a);
  const midColor = new THREE.Color(0xb06838);
  const highColor = new THREE.Color(0xc88050);
  const highlight = new THREE.Color(0xe8c89a);
  const shadowTint = new THREE.Color(0x6b3820);

  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const z = position.getZ(index);
    const y = getTerrainHeight(x, z);
    const radialDistance = Math.hypot(x, z);

    position.setY(index, y);

    const heightMix = clamp01((y + 10) / 70);
    const radialMix = clamp01((radialDistance - 40) / 200);
    const horizonMix = clamp01((-z - 40) / 220);
    const color = new THREE.Color();
    color.lerpColors(lowColor, midColor, heightMix);
    color.lerp(highColor, radialMix * 0.42);
    color.lerp(highlight, clamp01((heightMix - 0.56) * 0.82));
    color.lerp(shadowTint, clamp01(horizonMix * 0.3));
    colors.push(color.r, color.g, color.b);
  }

  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const terrain = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      map: textures.terrainMap,
      color: 0xf7ece3,
      vertexColors: true,
      roughness: 0.98,
      metalness: 0.02,
    }),
  );
  terrain.receiveShadow = true;
  scene.add(terrain);

  createRockField(scene, getTerrainHeight);
  createBackdropRidges(scene, getTerrainHeight);

  return {
    getHeightAt: getTerrainHeight,
  };
}

function createCliffWall(width, height, depth, seedOffset, material) {
  const geometry = new THREE.PlaneGeometry(width, height, 48, 10);
  const position = geometry.attributes.position;

  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const nx = x / width + 0.5;
    const ny = y / height + 0.5;
    const silhouette =
      ridge2D((nx + seedOffset * 0.001) * 6.2, seedOffset * 0.013, 4, 2.12, 0.56, SCENE_SEED + seedOffset) *
        34 +
      fbm2D((nx + seedOffset * 0.002) * 10.5, 0.2, 4, 2.2, 0.5, SCENE_SEED + seedOffset + 13) * 18;
    const faceNoise =
      (fbm2D(x * 0.024, y * 0.035, 4, 2.08, 0.55, SCENE_SEED + seedOffset + 33) - 0.5) * depth +
      (ridge2D(x * 0.038, y * 0.02, 3, 2.15, 0.55, SCENE_SEED + seedOffset + 52) - 0.5) * depth * 0.45;
    const overhang = THREE.MathUtils.smoothstep(ny, 0.35, 1) * silhouette;
    const terrace = Math.sin(nx * Math.PI * 8 + seedOffset) * 1.2;

    position.setZ(index, faceNoise + terrace);
    position.setY(index, y + overhang);
  }

  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function createBackdropRidges(scene, getHeightAt) {
  const ridgeMaterial = new THREE.MeshStandardMaterial({
    color: 0x552319,
    roughness: 1,
    metalness: 0.01,
    side: THREE.DoubleSide,
  });
  const darkRidgeMaterial = ridgeMaterial.clone();
  darkRidgeMaterial.color = new THREE.Color(0x341410);

  const ridges = [
    {
      mesh: createCliffWall(420, 120, 54, 401, ridgeMaterial),
      position: new THREE.Vector3(0, getHeightAt(0, -210) + 54, -210),
      rotationY: Math.PI,
    },
    {
      mesh: createCliffWall(320, 108, 42, 477, darkRidgeMaterial),
      position: new THREE.Vector3(-184, getHeightAt(-184, -86) + 48, -86),
      rotationY: Math.PI / 1.74,
    },
    {
      mesh: createCliffWall(320, 108, 42, 523, darkRidgeMaterial),
      position: new THREE.Vector3(184, getHeightAt(184, -82) + 48, -82),
      rotationY: -Math.PI / 1.74,
    },
    {
      mesh: createCliffWall(300, 84, 28, 612, darkRidgeMaterial),
      position: new THREE.Vector3(0, getHeightAt(0, -250) + 64, -250),
      rotationY: Math.PI,
    },
  ];

  ridges.forEach(({ mesh, position, rotationY }) => {
    mesh.position.copy(position);
    mesh.rotation.y = rotationY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  });
}

function setCastAndReceive(object) {
  object.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

function createArch(radius, peakHeight, tubeRadius, material) {
  const points = [];

  for (let index = 0; index <= 12; index += 1) {
    const t = index / 12;
    const x = THREE.MathUtils.lerp(-radius, radius, t);
    const y = Math.sin(t * Math.PI) * peakHeight;
    points.push(new THREE.Vector3(x, y, 0));
  }

  return new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, tubeRadius, 6, false),
    material,
  );
}

function alignToDirection(object, direction) {
  object.quaternion.setFromUnitVectors(Y_AXIS, direction.clone().normalize());
}

function createCylinderBetween(start, end, radius, material, radialSegments = 16, openEnded = false) {
  const direction = end.clone().sub(start);
  const length = direction.length();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, radialSegments, 1, openEnded),
    material,
  );

  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  alignToDirection(mesh, direction);
  return mesh;
}

function createTubeConnector(start, end, radius, shellMaterial, innerMaterial, ribMaterial, archHeight = 0) {
  const mid = start.clone().lerp(end, 0.5);
  mid.y += archHeight;
  const curve = new THREE.CatmullRomCurve3([start, mid, end]);
  const group = new THREE.Group();

  const shell = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, radius, 10, false), shellMaterial);
  const inner = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 16, radius * 0.68, 10, false),
    innerMaterial,
  );
  group.add(shell, inner);

  for (let index = 1; index < 12; index += 1) {
    const t = index / 12;
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.08, radius * 1.08, 0.18, 18, 1, true),
      ribMaterial,
    );
    ring.position.copy(curve.getPoint(t));
    alignToDirection(ring, curve.getTangent(t));
    group.add(ring);
  }

  return group;
}

function createLightPost(color, glowStrength = 1.2) {
  const group = new THREE.Group();

  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.12, 1.6, 8),
    new THREE.MeshStandardMaterial({
      color: 0x8f847e,
      metalness: 0.8,
      roughness: 0.32,
    }),
  );
  post.position.y = 0.8;

  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 12, 12),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: glowStrength,
      roughness: 0.24,
      metalness: 0.02,
    }),
  );
  cap.position.y = 1.72;

  group.add(post, cap);
  return { group, cap };
}

function createGreenhouseModule(materials, animated) {
  const module = new THREE.Group();

  const base = new THREE.Mesh(new THREE.CylinderGeometry(11.8, 12.8, 2.5, 40), materials.hull);
  base.position.y = 1.25;

  const deck = new THREE.Mesh(new THREE.CylinderGeometry(11.2, 11.2, 0.3, 40), materials.deck);
  deck.position.y = 2.55;

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(10.2, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    materials.glass,
  );
  dome.position.y = 2.55;

  const innerGlow = new THREE.Mesh(
    new THREE.SphereGeometry(9.45, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: 0x06271b,
      emissive: 0x2ebf7c,
      emissiveIntensity: 0.3,
      roughness: 0.8,
      metalness: 0.02,
      transparent: true,
      opacity: 0.2,
    }),
  );
  innerGlow.position.y = 2.55;

  const innerFloor = new THREE.Mesh(
    new THREE.CircleGeometry(9, 32),
    new THREE.MeshStandardMaterial({
      color: 0x24322c,
      roughness: 0.92,
      metalness: 0.01,
    }),
  );
  innerFloor.rotation.x = -Math.PI / 2;
  innerFloor.position.y = 2.7;

  for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2;
    const planter = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.6, 5.4),
      new THREE.MeshStandardMaterial({
        color: 0x4a3a34,
        roughness: 0.9,
        metalness: 0.03,
      }),
    );
    planter.position.set(Math.cos(angle) * 4.4, 3.05, Math.sin(angle) * 4.4);
    planter.rotation.y = angle;
    module.add(planter);

    for (let plantIndex = 0; plantIndex < 5; plantIndex += 1) {
      const stalk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.08, 0.9 + plantIndex * 0.08, 6),
        new THREE.MeshStandardMaterial({
          color: 0x4cc784,
          emissive: 0x0f351d,
          emissiveIntensity: 0.25,
          roughness: 0.9,
          metalness: 0,
        }),
      );
      const offset = -1.8 + plantIndex * 0.9;
      const sideJitter = (plantIndex % 2 === 0 ? -1 : 1) * 0.18;
      stalk.position.set(
        Math.cos(angle) * 4.4 + Math.cos(angle + Math.PI / 2) * offset * 0.2,
        3.6 + plantIndex * 0.05,
        Math.sin(angle) * 4.4 + Math.sin(angle + Math.PI / 2) * offset * 0.2 + sideJitter,
      );
      stalk.rotation.z = (plantIndex - 2) * 0.05;
      module.add(stalk);
    }
  }

  // Greenhouse arches removed for cleaner look

  for (let index = 0; index < 3; index += 1) {
    const growLight = new THREE.Mesh(
      new THREE.BoxGeometry(6.2, 0.16, 0.28),
      new THREE.MeshStandardMaterial({
        color: 0xbefee0,
        emissive: 0x81ffce,
        emissiveIntensity: 1.8,
        roughness: 0.12,
        metalness: 0.02,
      }),
    );
    growLight.position.y = 9.3 - index * 0.4;
    growLight.rotation.y = (index / 3) * Math.PI;
    module.add(growLight);

    animated.push((elapsed) => {
      growLight.material.emissiveIntensity = 1.5 + Math.sin(elapsed * 1.7 + index) * 0.18;
    });
  }

  const beaconLight = new THREE.PointLight(0x89ffc8, 1.1, 14, 2.2);
  beaconLight.position.set(0, 8, 0);

  module.add(base, deck, dome, innerGlow, innerFloor, beaconLight);
  setCastAndReceive(module);
  dome.castShadow = false;
  innerGlow.castShadow = false;
  return module;
}

function createCrewQuarter(materials, animated, accentColor) {
  const quarter = new THREE.Group();
  const glowMaterial = new THREE.MeshStandardMaterial({
    color: 0xf4f5f6,
    emissive: accentColor,
    emissiveIntensity: 1.2,
    roughness: 0.14,
    metalness: 0.05,
  });
  const stripMaterial = new THREE.MeshStandardMaterial({
    color: 0xfcfdff,
    emissive: accentColor,
    emissiveIntensity: 1.6,
    roughness: 0.12,
    metalness: 0.04,
  });

  const shell = new THREE.Mesh(
    new THREE.CylinderGeometry(3.5, 3.9, 18, 28),
    materials.hull,
  );
  shell.rotation.z = Math.PI / 2;
  shell.position.y = 10.1;

  const nose = new THREE.Mesh(new THREE.SphereGeometry(3.55, 22, 18), materials.hull);
  nose.position.set(-9.05, 10.1, 0);

  const aft = new THREE.Mesh(new THREE.SphereGeometry(3.85, 22, 18), materials.darkHull);
  aft.position.set(9.1, 10.1, 0);

  const dock = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 2.8, 16), materials.darkHull);
  dock.rotation.z = Math.PI / 2;
  dock.position.set(-10.5, 10.1, 0);

  const servicePod = new THREE.Mesh(new THREE.BoxGeometry(3.8, 3.2, 3.4), materials.darkHull);
  servicePod.position.set(8.9, 10.6, 0);

  const dorsalSpine = new THREE.Mesh(new THREE.BoxGeometry(11, 0.4, 0.55), materials.frame);
  dorsalSpine.position.set(0.8, 13.15, 0);

  const bellyKeel = new THREE.Mesh(new THREE.BoxGeometry(13.4, 0.36, 0.86), materials.darkHull);
  bellyKeel.position.set(0, 7.02, 0);

  quarter.add(shell, nose, aft, dock, servicePod, dorsalSpine, bellyKeel);

  for (let index = 0; index < 4; index += 1) {
    const rib = new THREE.Mesh(
      new THREE.CylinderGeometry(3.86, 3.86, 0.14, 24, 1, true),
      materials.frame,
    );
    rib.rotation.z = Math.PI / 2;
    rib.position.set(-5 + index * 3.2, 10.1, 0);
    quarter.add(rib);
  }

  for (let side = -1; side <= 1; side += 2) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.3, 0.18), stripMaterial);
    strip.position.set(-1.2, 10.85, side * 2.78);
    quarter.add(strip);

    const viewport = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.95, 0.18), materials.glass);
    viewport.position.set(-1.6, 11.5, side * 2.9);
    quarter.add(viewport);
  }

  const domeLight = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 12), glowMaterial);
  domeLight.position.set(2.8, 12.7, 0);
  quarter.add(domeLight);

  const underGlow = new THREE.Mesh(
    new THREE.BoxGeometry(4.8, 0.12, 1.2),
    new THREE.MeshStandardMaterial({
      color: 0xeafcff,
      emissive: accentColor,
      emissiveIntensity: 0.9,
      roughness: 0.1,
      metalness: 0.02,
      transparent: true,
      opacity: 0.92,
    }),
  );
  underGlow.position.set(-2, 7.28, 0);
  quarter.add(underGlow);

  const pylonPositions = [
    [-5.2, 6.1, -1.65, -3, 8.05, -1.1],
    [-5.2, 6.1, 1.65, -3, 8.05, 1.1],
    [4.2, 6.1, -1.7, 2.4, 8.2, -1.15],
    [4.2, 6.1, 1.7, 2.4, 8.2, 1.15],
  ];

  pylonPositions.forEach(([sx, sy, sz, ex, ey, ez]) => {
    quarter.add(
      createCylinderBetween(
        new THREE.Vector3(sx, sy, sz),
        new THREE.Vector3(ex, ey, ez),
        0.13,
        materials.darkHull,
      ),
    );
  });

  const point = new THREE.PointLight(accentColor, 0.5, 14, 2.1);
  point.position.set(-2, 10.5, 0);
  quarter.add(point);

  setCastAndReceive(quarter);
  quarter.traverse((child) => {
    if (child.material === materials.glass) {
      child.castShadow = false;
    }
  });

  animated.push((elapsed) => {
    stripMaterial.emissiveIntensity = 1.35 + Math.sin(elapsed * 1.8 + accentColor * 0.0001) * 0.12;
    glowMaterial.emissiveIntensity = 1 + Math.sin(elapsed * 2.4 + accentColor * 0.00015) * 0.15;
  });

  return quarter;
}

function createShuttle(materials, animated) {
  const shuttle = new THREE.Group();

  const fuselage = new THREE.Mesh(
    new THREE.CylinderGeometry(1.9, 2.4, 15, 20),
    materials.darkHull,
  );
  fuselage.rotation.z = Math.PI / 2;
  fuselage.position.y = 2.4;

  const cockpit = new THREE.Mesh(
    new THREE.SphereGeometry(1.8, 24, 16),
    materials.glass,
  );
  cockpit.position.set(6.5, 2.7, 0);

  const tail = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.8, 1.2), materials.hull);
  tail.position.set(-7.3, 3.6, 0);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(12.8, 0.28, 3.2), materials.darkHull);
  wing.position.set(0, 2.1, 0);

  const dorsal = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.6, 0.4), materials.hull);
  dorsal.position.set(-4.8, 4.1, 0);
  dorsal.rotation.z = 0.26;

  const engineGlow = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.7, 1.2, 16),
    new THREE.MeshStandardMaterial({
      color: 0xf6fff3,
      emissive: 0x71d6ff,
      emissiveIntensity: 1.9,
      roughness: 0.14,
      metalness: 0.02,
    }),
  );
  engineGlow.rotation.z = Math.PI / 2;
  engineGlow.position.set(-8.4, 2.3, 0);

  shuttle.add(fuselage, cockpit, tail, wing, dorsal, engineGlow);
  setCastAndReceive(shuttle);
  cockpit.castShadow = false;

  animated.push((elapsed) => {
    engineGlow.material.emissiveIntensity = 1.7 + Math.sin(elapsed * 5.2) * 0.18;
  });

  return shuttle;
}

function createSolarArray(materials) {
  const array = new THREE.Group();

  const footing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.9, 1.1, 8),
    materials.darkHull,
  );
  footing.position.y = 0.55;

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 3.8, 8), materials.hull);
  mast.position.y = 2.6;

  const panelPivot = new THREE.Group();
  panelPivot.position.y = 4.7;

  const frame = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.24, 4.4), materials.frame);
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 4),
    materials.solar,
  );
  panel.rotation.x = -Math.PI / 2;
  panel.position.y = 0.08;
  panel.receiveShadow = true;

  panelPivot.add(frame, panel);
  panelPivot.rotation.x = -0.7;

  array.add(footing, mast, panelPivot);
  setCastAndReceive(array);
  panel.castShadow = false;

  return { array, panelPivot };
}

function createTower(materials, animated) {
  const tower = new THREE.Group();

  for (let index = 0; index < 4; index += 1) {
    const angle = (index / 4) * Math.PI * 2 + Math.PI / 4;
    const start = new THREE.Vector3(Math.cos(angle) * 1.6, 0.4, Math.sin(angle) * 1.6);
    const end = new THREE.Vector3(Math.cos(angle) * 0.45, 25, Math.sin(angle) * 0.45);
    tower.add(createCylinderBetween(start, end, 0.12, materials.hull));
  }

  for (let y = 4; y <= 24; y += 4) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.14, 4, 1, true), materials.frame);
    ring.position.y = y;
    ring.rotation.y = Math.PI / 4;
    tower.add(ring);
  }

  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 26, 8), materials.darkHull);
  core.position.y = 13;

  const dishPivot = new THREE.Group();
  dishPivot.position.y = 23.2;

  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(4.3, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: 0xe3d8d1,
      roughness: 0.3,
      metalness: 0.55,
      side: THREE.DoubleSide,
    }),
  );
  dish.rotation.x = -Math.PI / 2;
  dish.position.z = 4;

  const emitter = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.14, 2.4, 10),
    materials.frame,
  );
  emitter.rotation.x = Math.PI / 2;
  emitter.position.z = 1.2;

  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(8, 26, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x78d6ff,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  beam.position.set(0, 0.4, 14.5);
  beam.rotation.x = Math.PI / 2;

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, 12, 12),
    new THREE.MeshStandardMaterial({
      color: 0xffd1bd,
      emissive: 0xff6a35,
      emissiveIntensity: 2.6,
      roughness: 0.2,
      metalness: 0.04,
    }),
  );
  beacon.position.y = 27;

  dishPivot.add(dish, emitter, beam);
  tower.add(core, dishPivot, beacon);
  setCastAndReceive(tower);
  beam.castShadow = false;

  animated.push((elapsed) => {
    dishPivot.rotation.y = elapsed * 0.22;
    beam.material.opacity = 0.06 + Math.sin(elapsed * 1.4) * 0.02;
    beacon.material.emissiveIntensity = 2.1 + Math.sin(elapsed * 4.4) * 0.8;
  });

  return tower;
}

function createUtilityTanks(materials) {
  const group = new THREE.Group();

  for (let index = 0; index < 3; index += 1) {
    const tank = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 8.4, 22), materials.hull);
    shell.rotation.z = Math.PI / 2;
    const capA = new THREE.Mesh(new THREE.SphereGeometry(1.7, 18, 12), materials.hull);
    capA.position.x = -4.2;
    const capB = capA.clone();
    capB.position.x = 4.2;
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.4, 2.2), materials.darkHull);
    saddle.position.y = -1.9;
    const legLeft = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 2.1, 6), materials.darkHull);
    const legRight = legLeft.clone();
    legLeft.position.set(-2.8, -0.9, 0.7);
    legRight.position.set(2.8, -0.9, -0.7);
    tank.add(shell, capA, capB, saddle, legLeft, legRight);
    tank.position.set(index * 7.8, 2.9, 0);
    group.add(tank);
  }

  const pipeCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.8, 5.2, 0),
    new THREE.Vector3(8, 6.5, -1.8),
    new THREE.Vector3(16, 5.8, 0),
  ]);
  const pipe = new THREE.Mesh(new THREE.TubeGeometry(pipeCurve, 32, 0.18, 8, false), materials.frame);
  group.add(pipe);
  setCastAndReceive(group);

  return group;
}

function createRover(materials, animated) {
  const rover = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.8, 3.8), materials.darkHull);
  body.position.y = 2.35;

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.6, 2.8), materials.hull);
  cabin.position.set(0.8, 3.2, 0);

  const viewport = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.1, 2.6), materials.glass);
  viewport.position.copy(cabin.position).add(new THREE.Vector3(0.2, 0.1, 0));

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.8, 6), materials.frame);
  mast.position.set(-1.6, 4, 0);

  const sensor = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 10, 10),
    new THREE.MeshStandardMaterial({
      color: 0xfff4de,
      emissive: 0xffb365,
      emissiveIntensity: 2.1,
      roughness: 0.18,
      metalness: 0.02,
    }),
  );
  sensor.position.set(-1.6, 4.95, 0);

  rover.add(body, cabin, viewport, mast, sensor);

  for (let side = -1; side <= 1; side += 2) {
    for (let index = 0; index < 3; index += 1) {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.85, 0.85, 0.75, 20),
        new THREE.MeshStandardMaterial({
          color: 0x212121,
          roughness: 0.88,
          metalness: 0.04,
        }),
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(-1.9 + index * 1.9, 1.1, side * 2.2);
      rover.add(wheel);
    }
  }

  setCastAndReceive(rover);
  viewport.castShadow = false;

  animated.push((elapsed) => {
    sensor.material.emissiveIntensity = 1.8 + Math.sin(elapsed * 4.8) * 0.4;
  });

  return rover;
}

function createStation(scene, textures, getHeightAt, animated) {
  const station = new THREE.Group();
  const baseGround = getHeightAt(0, 0);
  station.position.y = baseGround;
  scene.add(station);

  const materials = {
    hull: new THREE.MeshStandardMaterial({
      map: textures.metalMap,
      color: 0xc7bdb4,
      metalness: 0.72,
      roughness: 0.44,
    }),
    darkHull: new THREE.MeshStandardMaterial({
      map: textures.metalMap,
      color: 0x3d3330,
      metalness: 0.68,
      roughness: 0.5,
    }),
    frame: new THREE.MeshStandardMaterial({
      color: 0xe3bf9a,
      emissive: 0x6f3a22,
      emissiveIntensity: 0.22,
      metalness: 0.38,
      roughness: 0.46,
    }),
    deck: new THREE.MeshStandardMaterial({
      map: textures.deckMap,
      color: 0xffffff,
      metalness: 0.3,
      roughness: 0.74,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xcfe9f5,
      transparent: true,
      opacity: 0.64,
      transmission: 0.86,
      thickness: 1.1,
      roughness: 0.11,
      metalness: 0.05,
      ior: 1.18,
      reflectivity: 0.28,
    }),
    glow: new THREE.MeshStandardMaterial({
      color: 0xf4feff,
      emissive: 0x85dbff,
      emissiveIntensity: 1.02,
      roughness: 0.2,
      metalness: 0.08,
      transparent: true,
      opacity: 0.9,
    }),
    solar: new THREE.MeshStandardMaterial({
      map: textures.solarMap,
      color: 0xa9bfd0,
      emissive: 0x193d60,
      emissiveIntensity: 0.26,
      roughness: 0.28,
      metalness: 0.82,
      side: THREE.DoubleSide,
    }),
  };

  const centralDeck = new THREE.Mesh(new THREE.CylinderGeometry(38.5, 42.5, 5.2, 48), materials.deck);
  centralDeck.position.y = 2.6;

  const deckSkirt = new THREE.Mesh(new THREE.CylinderGeometry(43.6, 46.5, 1.2, 48), materials.darkHull);
  deckSkirt.position.y = 0.6;

  const deckLip = new THREE.Mesh(new THREE.TorusGeometry(39.8, 0.65, 10, 180), materials.darkHull);
  deckLip.position.y = 5.05;

  const lowerCollar = new THREE.Mesh(new THREE.CylinderGeometry(16.8, 18.2, 1.1, 36), materials.hull);
  lowerCollar.position.y = 5.5;

  const coreBase = new THREE.Mesh(new THREE.CylinderGeometry(14, 16.8, 5.6, 64), materials.darkHull);
  coreBase.position.y = 7.45;

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(14.4, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    materials.glass,
  );
  dome.position.y = 10.25;

  const innerLantern = new THREE.Group();
  const lanternCore = new THREE.Mesh(
    new THREE.CylinderGeometry(2.6, 4, 10.8, 18),
    new THREE.MeshStandardMaterial({
      color: 0x03131d,
      emissive: 0x86efff,
      emissiveIntensity: 0.48,
      roughness: 0.28,
      metalness: 0.02,
      transparent: true,
      opacity: 0.4,
    }),
  );
  lanternCore.position.y = 10.9;
  innerLantern.add(lanternCore);

  for (let index = 0; index < 3; index += 1) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(3.8 + index * 1.45, 0.08, 8, 42),
      materials.glow,
    );
    ring.position.y = 8.9 + index * 1.85;
    ring.rotation.x = Math.PI / 2;
    innerLantern.add(ring);
  }

  const domeGlow = new THREE.Mesh(
    new THREE.SphereGeometry(13.7, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: 0x051c26,
      emissive: 0x9ae5ff,
      emissiveIntensity: 0.22,
      roughness: 0.6,
      metalness: 0.02,
      transparent: true,
      opacity: 0.14,
    }),
  );
  domeGlow.position.y = 10.25;

  const observationHalo = new THREE.Mesh(new THREE.TorusGeometry(18.8, 0.46, 14, 120), materials.frame);
  observationHalo.position.y = 14.45;

  const observationGlow = new THREE.Mesh(new THREE.TorusGeometry(18.8, 0.16, 10, 120), materials.glow);
  observationGlow.position.y = 14.45;

  const centralSpire = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.58, 10.8, 12), materials.frame);
  centralSpire.position.y = 18.6;

  const spireBeacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 12, 12),
    new THREE.MeshStandardMaterial({
      color: 0xffe0c3,
      emissive: 0xff8647,
      emissiveIntensity: 2.2,
      roughness: 0.2,
      metalness: 0.04,
    }),
  );
  spireBeacon.position.y = 24.3;

  station.add(
    centralDeck,
    deckSkirt,
    lowerCollar,
    deckLip,
    coreBase,
    dome,
    domeGlow,
    innerLantern,
    observationHalo,
    observationGlow,
    centralSpire,
    spireBeacon,
  );

  for (let index = 0; index < 10; index += 1) {
    const angle = (index / 10) * Math.PI * 2;
    const support = createCylinderBetween(
      new THREE.Vector3(Math.cos(angle) * 34.2, 0.6, Math.sin(angle) * 34.2),
      new THREE.Vector3(Math.cos(angle) * 28.6, 8.2, Math.sin(angle) * 28.6),
      0.3,
      materials.hull,
    );
    station.add(support);
  }

  // Structural arches removed for cleaner look

  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2 + Math.PI / 8;
    station.add(
      createCylinderBetween(
        new THREE.Vector3(Math.cos(angle) * 18.1, 6.1, Math.sin(angle) * 18.1),
        new THREE.Vector3(Math.cos(angle) * 18.7, 14.1, Math.sin(angle) * 18.7),
        0.18,
        materials.frame,
      ),
    );
  }

  const crewLayouts = [
    { position: new THREE.Vector3(27.5, 0, 0), rotation: 0, accent: 0x8fdfff },
    { position: new THREE.Vector3(-27.5, 0, 0), rotation: Math.PI, accent: 0xffd08f },
    { position: new THREE.Vector3(0, 0, 27.5), rotation: Math.PI / 2, accent: 0x9af4c2 },
    { position: new THREE.Vector3(0, 0, -27.5), rotation: -Math.PI / 2, accent: 0xffaa8b },
  ];

  crewLayouts.forEach(({ position, rotation, accent }) => {
    const quarter = createCrewQuarter(materials, animated, accent);
    quarter.position.copy(position);
    quarter.rotation.y = rotation;
    station.add(quarter);

    const direction = position.clone().normalize();
    const connector = createTubeConnector(
      new THREE.Vector3(direction.x * 11.5, 9.5, direction.z * 11.5),
      new THREE.Vector3(direction.x * 19.5, 9.7, direction.z * 19.5),
      0.92,
      materials.darkHull,
      materials.glow,
      materials.frame,
      0.2,
    );
    station.add(connector);
  });

  for (let index = 0; index < 16; index += 1) {
    const angle = (index / 16) * Math.PI * 2;
    const { group, cap } = createLightPost(0xffd6ab, 1.15);
    group.position.set(Math.cos(angle) * 35.4, 5.05, Math.sin(angle) * 35.4);
    station.add(group);

    if (index % 4 === 0) {
      const point = new THREE.PointLight(0xffb88b, 0.7, 16, 2.2);
      point.position.copy(group.position).add(new THREE.Vector3(0, 1.5, 0));
      station.add(point);
    }

    animated.push((elapsed) => {
      cap.material.emissiveIntensity = 0.9 + Math.sin(elapsed * 1.4 + index * 0.6) * 0.14;
    });
  }

  const greenhousePositions = [
    new THREE.Vector3(60, 0, 12),
    new THREE.Vector3(-54, 0, 34),
    new THREE.Vector3(-48, 0, -44),
  ];

  greenhousePositions.forEach((position, index) => {
    const greenhouse = createGreenhouseModule(materials, animated);
    greenhouse.position.copy(position);
    greenhouse.position.y = getHeightAt(position.x, position.z) - baseGround;
    station.add(greenhouse);

    const connectorStart = new THREE.Vector3(
      position.x * 0.58,
      6.8,
      position.z * 0.58,
    );
    const connectorEnd = new THREE.Vector3(
      position.x * 0.82,
      greenhouse.position.y + 4,
      position.z * 0.82,
    );
    const connector = createTubeConnector(
      connectorStart,
      connectorEnd,
      1.65,
      materials.darkHull,
      materials.glow,
      materials.frame,
      0.5,
    );
    station.add(connector);

    greenhouse.rotation.y = Math.atan2(position.x, position.z) + Math.PI * 0.5;

    if (index === 0) {
      const airlock = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 5.6, 18), materials.hull);
      airlock.rotation.z = Math.PI / 2;
      airlock.position.set(position.x + 13.2, greenhouse.position.y + 3.2, 0);
      station.add(airlock);
    }
  });

  const landingPadPosition = new THREE.Vector3(84, 0, -56);
  const landingPadGround = getHeightAt(landingPadPosition.x, landingPadPosition.z) - baseGround;

  const landingPad = new THREE.Group();
  landingPad.position.copy(landingPadPosition);
  landingPad.position.y = landingPadGround;

  const landingBase = new THREE.Mesh(new THREE.CylinderGeometry(18.5, 21.5, 1.6, 36), materials.darkHull);
  landingBase.position.y = 0.8;

  const landingSurface = new THREE.Mesh(new THREE.CylinderGeometry(17.8, 17.8, 0.28, 36), materials.deck);
  landingSurface.position.y = 1.76;

  landingPad.add(landingBase, landingSurface);

  const landingRing = new THREE.Mesh(new THREE.TorusGeometry(12.5, 0.18, 8, 48), materials.frame);
  landingRing.rotation.x = Math.PI / 2;
  landingRing.position.y = 1.95;
  landingPad.add(landingRing);

  for (let index = 0; index < 4; index += 1) {
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(4.4, 0.08, 0.35),
      new THREE.MeshStandardMaterial({
        color: 0xffebdc,
        emissive: 0xffb46f,
        emissiveIntensity: 0.55,
        roughness: 0.3,
        metalness: 0.04,
      }),
    );
    marker.position.y = 1.95;
    marker.rotation.y = (index / 4) * Math.PI * 0.5;
    marker.position.x = Math.cos(marker.rotation.y) * 6.8;
    marker.position.z = Math.sin(marker.rotation.y) * 6.8;
    landingPad.add(marker);
  }

  for (let index = 0; index < 14; index += 1) {
    const angle = (index / 14) * Math.PI * 2;
    const { group, cap } = createLightPost(index % 2 === 0 ? 0xffa45d : 0xffefd6, 1.35);
    group.position.set(Math.cos(angle) * 16.2, 1.8, Math.sin(angle) * 16.2);
    landingPad.add(group);

    animated.push((elapsed) => {
      cap.material.emissiveIntensity = 1.1 + Math.sin(elapsed * 2 + index) * 0.22;
    });
  }

  const shuttle = createShuttle(materials, animated);
  shuttle.position.set(1.5, 1.9, -2.4);
  shuttle.rotation.y = 0.3;
  landingPad.add(shuttle);
  station.add(landingPad);

  const walkway = createTubeConnector(
    new THREE.Vector3(24, 6, -16),
    new THREE.Vector3(68, landingPadGround + 2.1, -42),
    0.9,
    materials.hull,
    materials.glow,
    materials.frame,
    1.5,
  );
  station.add(walkway);

  const tower = createTower(materials, animated);
  tower.position.set(-38, getHeightAt(-38, 23) - baseGround, 23);
  station.add(tower);

  const utility = createUtilityTanks(materials);
  utility.position.set(-66, getHeightAt(-66, 10) - baseGround, 10);
  utility.rotation.y = 0.18;
  station.add(utility);

  const pipeFromUtility = createTubeConnector(
    new THREE.Vector3(-47, 5.2, 10),
    new THREE.Vector3(-18, 5.2, 9),
    0.38,
    materials.darkHull,
    materials.glow,
    materials.frame,
    0.8,
  );
  station.add(pipeFromUtility);

  const rover = createRover(materials, animated);
  rover.position.set(26, getHeightAt(26, 35) - baseGround, 35);
  rover.rotation.y = -0.55;
  station.add(rover);

  const solarClusters = [
    [110, 32, 3, 2],
    [132, 70, 2, 2],
    [-108, -30, 3, 2],
    [-130, -74, 2, 2],
  ];

  solarClusters.forEach(([clusterX, clusterZ, rows, columns], clusterIndex) => {
    const anchor = new THREE.Group();
    anchor.position.set(clusterX, getHeightAt(clusterX, clusterZ) - baseGround, clusterZ);
    anchor.rotation.y = Math.atan2(-SUN_DIRECTION.x, -SUN_DIRECTION.z) + clusterIndex * 0.08;
    station.add(anchor);

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const { array, panelPivot } = createSolarArray(materials);
        array.position.set(row * 10 - ((rows - 1) * 10) / 2, 0, column * 8 - ((columns - 1) * 8) / 2);
        panelPivot.rotation.x = -0.62 - row * 0.04;
        panelPivot.rotation.y = column % 2 === 0 ? 0.02 : -0.02;
        anchor.add(array);
      }
    }
  });

  const cableA = createTubeConnector(
    new THREE.Vector3(44, 5.2, 20),
    new THREE.Vector3(102, getHeightAt(102, 30) - baseGround + 1.6, 30),
    0.22,
    materials.darkHull,
    materials.glow,
    materials.frame,
    3.2,
  );
  station.add(cableA);

  const cableB = createTubeConnector(
    new THREE.Vector3(-42, 4.9, -12),
    new THREE.Vector3(-106, getHeightAt(-106, -30) - baseGround + 1.6, -30),
    0.22,
    materials.darkHull,
    materials.glow,
    materials.frame,
    3,
  );
  station.add(cableB);

  setCastAndReceive(station);
  dome.castShadow = false;
  domeGlow.castShadow = false;
  observationGlow.castShadow = false;

  animated.push((elapsed) => {
    observationGlow.material.emissiveIntensity = 0.9 + Math.sin(elapsed * 0.8) * 0.08;
    materials.glow.emissiveIntensity = 0.94 + Math.sin(elapsed * 0.5) * 0.04;
    spireBeacon.material.emissiveIntensity = 1.9 + Math.sin(elapsed * 4.8) * 0.55;
    innerLantern.rotation.y = elapsed * 0.05;
  });
}

function createDustLayer({ count, area, minHeight, maxHeight, speed, size, textures, color, opacity }) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const drift = new Float32Array(count);
  const seededRandom = createSeededRandom(SCENE_SEED + count);

  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = (seededRandom() - 0.5) * area;
    positions[index * 3 + 1] = minHeight + seededRandom() * (maxHeight - minHeight);
    positions[index * 3 + 2] = (seededRandom() - 0.5) * area;
    scales[index] = size * (0.4 + seededRandom() * 1.4);
    drift[index] = 0.3 + seededRandom() * 1.6;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('scale', new THREE.BufferAttribute(scales, 1));

  const material = new THREE.PointsMaterial({
    map: textures.dustSprite,
    color,
    size,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    update: (elapsed) => {
      const position = geometry.attributes.position;
      for (let index = 0; index < count; index += 1) {
        const baseIndex = index * 3;
        const x = position.array[baseIndex] + speed * drift[index];
        const z = position.array[baseIndex + 2] + Math.sin(elapsed * 0.3 + index) * 0.012;
        position.array[baseIndex] = x > area * 0.5 ? -area * 0.5 : x;
        position.array[baseIndex + 2] = z;
      }
      position.needsUpdate = true;
      points.rotation.y = elapsed * 0.01;
    },
  };
}

function createDustLayers(scene, textures, animated) {
  const highLayer = createDustLayer({
    count: 400,
    area: 540,
    minHeight: 10,
    maxHeight: 42,
    speed: 0.05,
    size: 2.1,
    textures,
    color: 0xffbf88,
    opacity: 0.13,
  });
  scene.add(highLayer.points);

  const lowLayer = createDustLayer({
    count: 300,
    area: 360,
    minHeight: 1,
    maxHeight: 10,
    speed: 0.08,
    size: 1.24,
    textures,
    color: 0xffd7b6,
    opacity: 0.09,
  });
  scene.add(lowLayer.points);

  animated.push((elapsed) => {
    highLayer.update(elapsed);
    lowLayer.update(elapsed);
  });
}

export function createMarsBaseExperience(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc4836a);
  scene.fog = new THREE.Fog(0xc4836a, 120, 340);

  const camera = new THREE.PerspectiveCamera(
    40,
    window.innerWidth / window.innerHeight,
    0.1,
    1600,
  );
  camera.position.set(82, 30, 76);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.12;
  controls.minDistance = 34;
  controls.maxDistance = 180;
  controls.minPolarAngle = Math.PI * 0.16;
  controls.maxPolarAngle = Math.PI * 0.44;
  controls.target.set(6, 11.5, -4);
  controls.addEventListener('start', () => {
    controls.autoRotate = false;
  });

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const animated = [];
  const textures = createTextures(renderer);

  const lights = createLighting(scene);
  createAtmosphere(scene, textures, animated);
  const terrain = createTerrain(scene, textures);
  createStation(scene, textures, terrain.getHeightAt, animated);
  createDustLayers(scene, textures, animated);

  const resetPosition = new THREE.Vector3(82, 30, 76);
  const resetTarget = new THREE.Vector3(6, 11.5, -4);

  // Day/night color palettes
  const DAY_BG    = new THREE.Color(0xc4836a);
  const DUSK_BG   = new THREE.Color(0x8a3a2e);
  const NIGHT_BG  = new THREE.Color(0x1a0e0a);
  const DAWN_BG   = new THREE.Color(0x9e5040);
  const DAY_FOG   = new THREE.Color(0xc4836a);
  const NIGHT_FOG = new THREE.Color(0x1a0e0a);
  const tmpColor  = new THREE.Color();
  const tmpDir    = new THREE.Vector3();

  return {
    resize(width, height) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      composer.setSize(width, height);
      composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    },
    resetCamera() {
      camera.position.copy(resetPosition);
      controls.target.copy(resetTarget);
      controls.autoRotate = true;
      controls.update();
    },
    /**
     * Set the time of day for the day/night cycle.
     * @param {number} t — fraction of sol (0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk)
     */
    setTimeOfDay(t) {
      // Sun angle: rotate around Y axis, with elevation based on time
      const sunAngle = t * Math.PI * 2 - Math.PI * 0.5; // noon at t=0.5, midnight at t=0
      const elevation = Math.sin(sunAngle);
      const horizontal = Math.cos(sunAngle);
      tmpDir.set(horizontal * 0.76, Math.max(0.02, elevation), horizontal * -0.22).normalize();
      lights.sun.position.copy(tmpDir).multiplyScalar(260);

      // Sun intensity: peaks at noon, zero below horizon
      const sunUp = Math.max(0, elevation);
      lights.sun.intensity = sunUp * 5.5;
      lights.fill.intensity = sunUp * 0.8;
      lights.coolRim.intensity = 0.2 + sunUp * 0.3;

      // Hemisphere: warm sky during day, dark at night
      const nightMix = 1 - sunUp;
      lights.hemisphere.intensity = 0.4 + sunUp * 1.4;
      tmpColor.setHex(0xffeedd).lerp(new THREE.Color(0x221108), nightMix);
      lights.hemisphere.color.copy(tmpColor);
      tmpColor.setHex(0x8b5a3a).lerp(new THREE.Color(0x0a0504), nightMix);
      lights.hemisphere.groundColor.copy(tmpColor);

      // Background & fog color: blend between day/dusk/night/dawn
      let bgColor;
      if (t < 0.2) {
        // night → dawn
        bgColor = NIGHT_BG.clone().lerp(DAWN_BG, t / 0.2);
      } else if (t < 0.35) {
        // dawn → day
        bgColor = DAWN_BG.clone().lerp(DAY_BG, (t - 0.2) / 0.15);
      } else if (t < 0.65) {
        // day
        bgColor = DAY_BG.clone();
      } else if (t < 0.8) {
        // day → dusk
        bgColor = DAY_BG.clone().lerp(DUSK_BG, (t - 0.65) / 0.15);
      } else {
        // dusk → night
        bgColor = DUSK_BG.clone().lerp(NIGHT_BG, (t - 0.8) / 0.2);
      }
      scene.background.copy(bgColor);
      scene.fog.color.copy(bgColor);
      scene.fog.near = 120 - nightMix * 40; // tighter fog at night
      scene.fog.far = 340 - nightMix * 100;

      // Tone mapping exposure: dimmer at night
      renderer.toneMappingExposure = 0.6 + sunUp * 1.0;
    },
    update(elapsed) {
      for (const animation of animated) {
        animation(elapsed);
      }
      controls.update();
    },
    render() {
      composer.render();
    },
  };
}
