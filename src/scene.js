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
    { repeat: [6, 6] },
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
      color: 0xe8d4c0,
      vertexColors: true,
      roughness: 1.0,
      metalness: 0.0,
      flatShading: false,
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
    hull: new THREE.MeshStandardMaterial({ map: textures.metalMap, color: 0xd8d0c8, metalness: 0.35, roughness: 0.58 }),
    darkHull: new THREE.MeshStandardMaterial({ map: textures.metalMap, color: 0x4a4340, metalness: 0.4, roughness: 0.55 }),
    frame: new THREE.MeshStandardMaterial({ color: 0xb8a898, metalness: 0.3, roughness: 0.5 }),
    deck: new THREE.MeshStandardMaterial({ map: textures.deckMap, color: 0xffffff, metalness: 0.2, roughness: 0.75 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xddf0e8, transparent: true, opacity: 0.55, transmission: 0.8, roughness: 0.15, metalness: 0.02, ior: 1.12 }),
    glow: new THREE.MeshStandardMaterial({ color: 0xeeffee, emissive: 0x44aa66, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.05, transparent: true, opacity: 0.7 }),
    solar: new THREE.MeshStandardMaterial({ map: textures.solarMap, color: 0x8898b0, emissive: 0x0a1830, emissiveIntensity: 0.15, roughness: 0.3, metalness: 0.7, side: THREE.DoubleSide }),
    thermal: new THREE.MeshStandardMaterial({ color: 0xf0e8d0, metalness: 0.1, roughness: 0.8 }), // MLI blanket
  };

  // ═══════════════════════════════════════════════════════════════
  // Realistic Mars habitat: vertical lander + deployable greenhouses
  // Inspired by NASA DRA 5.0 / SpaceX Starship Mars concepts
  // ═══════════════════════════════════════════════════════════════

  // ── Main habitat lander (vertical cylinder with heat shield + legs) ──
  const habGroup = new THREE.Group();

  // Fuselage — tall cylinder, white thermal protection
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.5, 22, 32), materials.thermal);
  fuselage.position.y = 13;
  habGroup.add(fuselage);

  // Panel line rings for realism
  for (let i = 0; i < 6; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.25 + (i > 3 ? 0.3 : 0), 0.06, 6, 48), materials.darkHull);
    ring.position.y = 4 + i * 3.6;
    habGroup.add(ring);
  }

  // Heat shield (bottom) — dark ablative material
  const heatShield = new THREE.Mesh(
    new THREE.CylinderGeometry(5.5, 5.8, 1.2, 32),
    new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.95, metalness: 0.05 }),
  );
  heatShield.position.y = 1.6;
  habGroup.add(heatShield);

  // Nose cone (top)
  const noseCone = new THREE.Mesh(
    new THREE.ConeGeometry(5.2, 4, 32),
    materials.hull,
  );
  noseCone.position.y = 26;
  habGroup.add(noseCone);

  // 4 landing legs — angled struts
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const leg = createCylinderBetween(
      new THREE.Vector3(Math.cos(angle) * 4, 2, Math.sin(angle) * 4),
      new THREE.Vector3(Math.cos(angle) * 9.5, 0, Math.sin(angle) * 9.5),
      0.2, materials.frame,
    );
    habGroup.add(leg);
    // Foot pad
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, 0.3, 12), materials.darkHull);
    pad.position.set(Math.cos(angle) * 9.5, 0.15, Math.sin(angle) * 9.5);
    habGroup.add(pad);
  }

  // 4 small portholes
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 8;
    const porthole = new THREE.Mesh(
      new THREE.CircleGeometry(0.6, 16),
      new THREE.MeshStandardMaterial({ color: 0xaaddff, emissive: 0x88bbdd, emissiveIntensity: 0.4, roughness: 0.1 }),
    );
    porthole.position.set(Math.cos(angle) * 5.26, 16, Math.sin(angle) * 5.26);
    porthole.lookAt(Math.cos(angle) * 20, 16, Math.sin(angle) * 20);
    habGroup.add(porthole);
  }

  // Airlock — cylindrical bump on one side
  const airlock = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 3.2, 16), materials.hull);
  airlock.rotation.z = Math.PI / 2;
  airlock.position.set(6.4, 5, 0);
  habGroup.add(airlock);
  const airlockDoor = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, 1.4), materials.darkHull);
  airlockDoor.position.set(8.05, 5, 0);
  habGroup.add(airlockDoor);

  // Antenna mast on top
  const antennaMast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 6, 8), materials.frame);
  antennaMast.position.y = 31;
  habGroup.add(antennaMast);
  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(1.8, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3),
    new THREE.MeshStandardMaterial({ color: 0xe0d8d0, roughness: 0.4, metalness: 0.5, side: THREE.DoubleSide }),
  );
  dish.rotation.x = Math.PI;
  dish.position.y = 33.5;
  habGroup.add(dish);

  // Beacon light
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xff6633, emissive: 0xff4411, emissiveIntensity: 2.5, roughness: 0.2 }),
  );
  beacon.position.y = 34.2;
  habGroup.add(beacon);
  animated.push((elapsed) => {
    beacon.material.emissiveIntensity = 1.5 + Math.sin(elapsed * 4) * 1.0;
  });

  // Engine glow (visible during landing, fades after)
  const engineGlow = new THREE.Mesh(
    new THREE.ConeGeometry(3.5, 14, 16, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0xffaa44, emissive: 0xff6600, emissiveIntensity: 3, transparent: true,
      opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  engineGlow.position.y = -6;
  engineGlow.rotation.x = Math.PI;
  habGroup.add(engineGlow);

  // Start hab high up (setMissionProgress will position it)
  habGroup.position.y = 300;
  station.add(habGroup);

  // ── Greenhouse modules (quonset-hut style inflatable) ──
  // Each module is a group containing the greenhouse + its connector pipe
  // so hiding the group hides everything
  const ghPositions = [
    { x: 24, z: 8 },
    { x: -18, z: 22 },
    { x: -14, z: -22 },
  ];
  const ghModules = []; // each entry: { wrapper, finalPos }
  ghPositions.forEach(({ x, z }) => {
    const wrapper = new THREE.Group(); // contains greenhouse + connector
    const ghY = getHeightAt(x, z) - baseGround;
    const gh = new THREE.Group();

    // Face the greenhouse toward the hab
    const toHab = Math.atan2(-z, -x);

    // Base platform
    const baseH = 0.6;
    const base = new THREE.Mesh(new THREE.BoxGeometry(14, baseH, 7), materials.darkHull);
    base.position.y = baseH / 2;
    gh.add(base);

    // Quonset dome (half-cylinder sitting on top of base)
    const domeR = 3.3;
    const domeLen = 13;
    const domeY = baseH; // flat edge at top of base
    const quonset = new THREE.Mesh(
      new THREE.CylinderGeometry(domeR, domeR, domeLen, 24, 1, false, 0, Math.PI),
      materials.glass,
    );
    quonset.rotation.set(0, 0, Math.PI / 2);
    quonset.position.y = domeY;
    gh.add(quonset);

    // Inner green glow
    const innerGlow = new THREE.Mesh(
      new THREE.CylinderGeometry(domeR - 0.3, domeR - 0.3, domeLen - 1, 24, 1, false, 0, Math.PI),
      new THREE.MeshStandardMaterial({
        color: 0x113322, emissive: 0x22aa55, emissiveIntensity: 0.35,
        transparent: true, opacity: 0.2, side: THREE.BackSide,
      }),
    );
    innerGlow.rotation.set(0, 0, Math.PI / 2);
    innerGlow.position.y = domeY;
    gh.add(innerGlow);

    // End caps (flat half-circles closing the half-cylinder)
    for (const side of [-1, 1]) {
      const cap = new THREE.Mesh(
        new THREE.CircleGeometry(domeR, 24, 0, Math.PI),
        materials.hull,
      );
      cap.position.set(side * (domeLen / 2), domeY, 0);
      cap.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      gh.add(cap);
    }

    // Interior planter rows (sitting on the base platform)
    for (let row = -2; row <= 2; row++) {
      const planter = new THREE.Mesh(
        new THREE.BoxGeometry(10, 0.4, 0.8),
        new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 }),
      );
      planter.position.set(0, baseH + 0.2, row * 1.2);
      gh.add(planter);
      for (let s = -4; s <= 4; s++) {
        const h = 0.4 + Math.random() * 0.5;
        const stalk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.04, 0.06, h, 4),
          new THREE.MeshStandardMaterial({ color: 0x44aa55, emissive: 0x114422, emissiveIntensity: 0.2 }),
        );
        stalk.position.set(s * 1.1 + Math.random() * 0.3, baseH + 0.4 + h / 2, row * 1.2);
        gh.add(stalk);
      }
    }

    gh.position.set(x, ghY, z);
    gh.rotation.y = toHab + Math.PI; // face away from hab (long axis tangent)
    wrapper.add(gh);

    // Connector tube from hab wall to greenhouse entrance
    const dir = new THREE.Vector3(x, 0, z).normalize();
    const dist = Math.sqrt(x * x + z * z);
    // Start: just outside the hab hull (radius ~5.8), at airlock height
    const connStart = new THREE.Vector3(dir.x * 5.8, 5, dir.z * 5.8);
    // End: at the greenhouse wall (offset inward by half the base width ~3.5 along dir)
    const connEnd = new THREE.Vector3(x - dir.x * 3.5, ghY + 1.5, z - dir.z * 3.5);
    const connector = createTubeConnector(connStart, connEnd, 0.7, materials.hull, materials.glow, materials.frame, 0.3);
    wrapper.add(connector);

    wrapper.visible = false; // hidden until deployed by setMissionProgress
    station.add(wrapper);
    ghModules.push({ wrapper, finalX: x, finalZ: z, ghY });
  });

  // ── Solar arrays (ground-mounted, realistic) ──
  const solarGroup = new THREE.Group();
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const sx = 40 + row * 12;
      const sz = -30 + col * 9;
      const sy = getHeightAt(sx, sz) - baseGround;
      const { array, panelPivot } = createSolarArray(materials);
      array.position.set(sx, sy, sz);
      panelPivot.rotation.x = -0.55;
      solarGroup.add(array);
    }
  }
  solarGroup.visible = false; // hidden until deployed
  station.add(solarGroup);

  // ── Rover (simple, near airlock) ──
  const rover = createRover(materials, animated);
  rover.position.set(14, getHeightAt(14, 3) - baseGround, 3);
  rover.rotation.y = 0.4;
  rover.visible = false; // hidden until after landing
  station.add(rover);

  // ── Supply pods + dust clouds for airdrop animation ──
  const podMat = new THREE.MeshStandardMaterial({ color: 0x555050, roughness: 0.7, metalness: 0.3 });
  const dustMat = new THREE.MeshBasicMaterial({
    color: 0xd4a070, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.NormalBlending, side: THREE.DoubleSide,
  });

  function createSupplyDrop(targetGroup, x, z) {
    const y = getHeightAt(x, z) - baseGround;
    const pod = new THREE.Mesh(new THREE.CapsuleGeometry(2.5, 5, 8, 12), podMat.clone());
    pod.position.set(x, y + 200, z);
    pod.visible = false;
    station.add(pod);

    const dust = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 12), dustMat.clone());
    dust.position.set(x, y + 2, z);
    dust.visible = false;
    station.add(dust);

    return { pod, dust, x, z, y, targetGroup };
  }

  // Create supply drops for solar + each greenhouse
  const solarDrop = createSupplyDrop(solarGroup, 52, -16);
  // Bigger dust cloud for solar since it covers a wider area
  solarDrop.dust.geometry.dispose();
  solarDrop.dust.geometry = new THREE.SphereGeometry(16, 16, 12);
  const ghDrops = ghModules.map(({ wrapper, finalX, finalZ, ghY }) =>
    createSupplyDrop(wrapper, finalX, finalZ)
  );

  setCastAndReceive(station);

  return { station, habGroup, ghModules, engineGlow, solarGroup, rover, solarDrop, ghDrops };
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
  const { habGroup, ghModules, engineGlow, solarGroup, rover, solarDrop, ghDrops } = createStation(scene, textures, terrain.getHeightAt, animated);
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
      // Sun path — biased so daytime is ~70% of the cycle, night is short
      // Remap t so the sun stays above horizon longer:
      // night: 0.0–0.08, dawn: 0.08–0.15, day: 0.15–0.85, dusk: 0.85–0.92, night: 0.92–1.0
      const sunAngle = t * Math.PI * 2 - Math.PI * 0.5;
      // Bias elevation upward: raise the baseline so sun is "up" for more of the cycle
      const rawElevation = Math.sin(sunAngle);
      const elevation = rawElevation * 0.7 + 0.3; // shifts range from [-1,1] to [-0.4, 1.0]
      const horizontal = Math.cos(sunAngle);
      tmpDir.set(horizontal * 0.76, Math.max(0.02, elevation), horizontal * -0.22).normalize();
      lights.sun.position.copy(tmpDir).multiplyScalar(260);

      // Sun intensity: use biased elevation
      const sunUp = Math.max(0, elevation);
      lights.sun.intensity = sunUp * 5.5;
      lights.fill.intensity = sunUp * 0.8;
      lights.coolRim.intensity = 0.2 + sunUp * 0.3;

      // Hemisphere light
      const nightMix = Math.max(0, Math.min(1, 1 - sunUp * 1.5)); // sharper transition
      lights.hemisphere.intensity = 0.5 + sunUp * 1.3;
      tmpColor.setHex(0xffeedd).lerp(new THREE.Color(0x221108), nightMix);
      lights.hemisphere.color.copy(tmpColor);
      tmpColor.setHex(0x8b5a3a).lerp(new THREE.Color(0x0a0504), nightMix);
      lights.hemisphere.groundColor.copy(tmpColor);

      // Background & fog: compressed night, long day
      let bgColor;
      if (t < 0.08) {
        // deep night
        bgColor = NIGHT_BG.clone();
      } else if (t < 0.15) {
        // dawn
        bgColor = NIGHT_BG.clone().lerp(DAY_BG, (t - 0.08) / 0.07);
      } else if (t < 0.85) {
        // daytime
        bgColor = DAY_BG.clone();
      } else if (t < 0.92) {
        // dusk
        bgColor = DAY_BG.clone().lerp(DUSK_BG, (t - 0.85) / 0.07);
      } else {
        // night
        bgColor = DUSK_BG.clone().lerp(NIGHT_BG, (t - 0.92) / 0.08);
      }
      scene.background.copy(bgColor);
      scene.fog.color.copy(bgColor);
      scene.fog.near = 120 - nightMix * 30;
      scene.fog.far = 340 - nightMix * 80;

      // Exposure
      renderer.toneMappingExposure = 0.7 + sunUp * 0.9;
    },
    /**
     * Animate the landing sequence and module deployment based on mission sol.
     * @param {number} sol — current mission sol (1-450)
     * @param {number} frac — fraction within current sol (0-1)
     */
    setMissionProgress(sol, frac) {
      const t = sol - 1 + frac; // continuous time from 0

      // ── Hab rocket landing: first 5% of sol 1 (~3 seconds at 1500x) ──
      const LAND_END = 0.03;
      if (t < LAND_END) {
        const p = t / LAND_END;
        const e = 1 - Math.pow(1 - p, 5); // very strong deceleration
        habGroup.position.y = 250 * (1 - e);
        engineGlow.material.opacity = 1.0 * (1 - e);
        engineGlow.material.emissiveIntensity = 5 * (1 - e);
        habGroup.rotation.z = Math.sin(t * 80) * 0.005 * (1 - e);
        habGroup.rotation.x = Math.cos(t * 60) * 0.004 * (1 - e);
      } else {
        habGroup.position.y = 0;
        habGroup.rotation.z = 0;
        habGroup.rotation.x = 0;
        engineGlow.material.opacity = 0;
      }

      rover.visible = t >= 0.3;

      // ── Supply drop: pod falls → dust on impact → structure revealed ──
      function animateSupplyDrop(drop, startT) {
        const DUR = 0.08; // total duration in sols
        const rel = t - startT;

        if (rel < 0) {
          drop.pod.visible = false;
          drop.dust.visible = false;
          drop.targetGroup.visible = false;
          return;
        }

        const p = Math.min(1, rel / DUR);

        if (p < 0.35) {
          // Pod drops fast from sky
          const fallP = p / 0.35;
          const fallE = 1 - Math.pow(1 - fallP, 4);
          drop.pod.visible = true;
          drop.pod.position.x = drop.x;
          drop.pod.position.z = drop.z;
          drop.pod.position.y = drop.y + 180 * (1 - fallE);
          drop.pod.scale.setScalar(1);
          drop.dust.visible = false;
          drop.targetGroup.visible = false;
        } else if (p < 0.6) {
          // Impact: pod vanishes, dust cloud bursts at drop point
          const dustP = (p - 0.35) / 0.25;
          drop.pod.visible = false;

          drop.dust.visible = true;
          drop.dust.position.set(drop.x, drop.y + 3, drop.z);
          const dustScale = 1 + dustP * 4;
          drop.dust.scale.set(dustScale, dustScale * 0.4, dustScale);
          drop.dust.material.opacity = 0.7 * (1 - dustP * dustP);

          drop.targetGroup.visible = false;
        } else {
          // Dust fades, structure appears at its actual position
          const revealP = (p - 0.6) / 0.4;
          drop.pod.visible = false;

          drop.dust.visible = revealP < 0.7;
          if (drop.dust.visible) {
            drop.dust.material.opacity = 0.15 * (1 - revealP);
            drop.dust.scale.setScalar(5 + revealP * 3);
          }

          drop.targetGroup.visible = true;
          drop.targetGroup.position.set(0, 0, 0);
        }
      }

      // Solar: supply drop mid sol 1
      animateSupplyDrop(solarDrop, 0.12);

      // Greenhouses: staggered drops within sol 1
      const GH_SCHEDULE = [0.3, 0.5, 0.7];
      ghDrops.forEach((drop, i) => {
        animateSupplyDrop(drop, GH_SCHEDULE[i]);
      });
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
