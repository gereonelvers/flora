function fract(value) {
  return value - Math.floor(value);
}

function hash2D(x, y, seed) {
  const dot = x * 127.1 + y * 311.7 + seed * 91.917;
  return fract(Math.sin(dot) * 43758.5453123);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function createSeededRandom(seed) {
  let state = seed % 2147483647;

  if (state <= 0) {
    state += 2147483646;
  }

  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

export function valueNoise2D(x, y, seed = 1) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const sx = smoothstep(x - x0);
  const sy = smoothstep(y - y0);

  const n00 = hash2D(x0, y0, seed);
  const n10 = hash2D(x1, y0, seed);
  const n01 = hash2D(x0, y1, seed);
  const n11 = hash2D(x1, y1, seed);

  const ix0 = lerp(n00, n10, sx);
  const ix1 = lerp(n01, n11, sx);

  return lerp(ix0, ix1, sy);
}

export function fbm2D(
  x,
  y,
  octaves = 5,
  lacunarity = 2,
  gain = 0.5,
  seed = 1,
) {
  let amplitude = 0.5;
  let frequency = 1;
  let value = 0;
  let totalAmplitude = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    value += amplitude * valueNoise2D(x * frequency, y * frequency, seed + octave * 17);
    totalAmplitude += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return totalAmplitude === 0 ? 0 : value / totalAmplitude;
}

export function ridge2D(
  x,
  y,
  octaves = 4,
  lacunarity = 2.1,
  gain = 0.55,
  seed = 1,
) {
  let amplitude = 0.5;
  let frequency = 1;
  let value = 0;
  let totalAmplitude = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    const sample = valueNoise2D(x * frequency, y * frequency, seed + octave * 29);
    value += amplitude * (1 - Math.abs(sample * 2 - 1));
    totalAmplitude += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return totalAmplitude === 0 ? 0 : value / totalAmplitude;
}
