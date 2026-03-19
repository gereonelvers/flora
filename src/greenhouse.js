/**
 * Greenhouse simulation state manager.
 * Tracks crops, resources, nutrition, and mission timeline.
 */

const CROP_DB = {
  potato: {
    name: 'Potato', cycle: 95, yield_kg_m2: 6, kcal_100g: 77,
    protein_g: 2, water: 'moderate-high', temp: [16, 20], role: 'Caloric backbone',
  },
  lettuce: {
    name: 'Lettuce', cycle: 37, yield_kg_m2: 4, kcal_100g: 15,
    protein_g: 1.4, water: 'high', temp: [15, 22], role: 'Micronutrient source',
  },
  bean: {
    name: 'Bean', cycle: 60, yield_kg_m2: 2.5, kcal_100g: 31,
    protein_g: 7, water: 'moderate', temp: [18, 26], role: 'Protein security',
  },
  radish: {
    name: 'Radish', cycle: 25, yield_kg_m2: 3, kcal_100g: 16,
    protein_g: 0.7, water: 'moderate', temp: [15, 22], role: 'Fast buffer crop',
  },
  spinach: {
    name: 'Spinach', cycle: 40, yield_kg_m2: 3.5, kcal_100g: 23,
    protein_g: 2.9, water: 'moderate', temp: [15, 20], role: 'Iron & folate',
  },
  herb: {
    name: 'Herbs', cycle: 30, yield_kg_m2: 1.5, kcal_100g: 22,
    protein_g: 2, water: 'low', temp: [18, 24], role: 'Flavor & morale',
  },
};

function createInitialState() {
  return {
    mission: {
      name: 'Asterion Four',
      currentSol: 1,
      totalSols: 450,
      crew: 4,
      phase: 'Setup',
    },
    modules: [
      { id: 1, name: 'Module Alpha', area_m2: 20, crops: [], temp: 19, humidity: 60, co2: 800, light: 250 },
      { id: 2, name: 'Module Beta', area_m2: 20, crops: [], temp: 19, humidity: 60, co2: 800, light: 250 },
      { id: 3, name: 'Module Gamma', area_m2: 20, crops: [], temp: 19, humidity: 60, co2: 800, light: 250 },
    ],
    resources: {
      water_liters: 5000,
      water_daily_budget: 80,
      energy_kwh: 200,
      co2_kg: 50,
    },
    nutrition: {
      daily_target_kcal: 10000,   // 2500 * 4 crew
      daily_target_protein_g: 200, // 50g * 4
      current_daily_kcal: 0,
      current_daily_protein_g: 0,
      coverage_percent: 0,
    },
    harvests: [],
    events: [],
    alerts: [],
  };
}

function advanceSol(state, days = 1) {
  const s = JSON.parse(JSON.stringify(state));

  for (let d = 0; d < days; d++) {
    s.mission.currentSol++;

    // Update mission phase
    if (s.mission.currentSol <= 30) s.mission.phase = 'Setup';
    else if (s.mission.currentSol <= 400) s.mission.phase = 'Production';
    else s.mission.phase = 'Wind-down';

    // Grow crops, check harvests
    let dailyKcal = 0;
    let dailyProtein = 0;

    for (const mod of s.modules) {
      const newCrops = [];
      for (const crop of mod.crops) {
        crop.daysGrown++;
        const info = CROP_DB[crop.type];

        if (crop.daysGrown >= info.cycle) {
          // Harvest!
          const yieldKg = info.yield_kg_m2 * crop.area_m2;
          s.harvests.push({
            sol: s.mission.currentSol,
            crop: info.name,
            module: mod.id,
            yield_kg: Math.round(yieldKg * 10) / 10,
          });

          // Contribute to daily nutrition estimate (spread over cycle)
          dailyKcal += (yieldKg * 10 * info.kcal_100g) / info.cycle;
          dailyProtein += (yieldKg * 10 * info.protein_g) / info.cycle;

          // Auto-replant
          newCrops.push({ type: crop.type, area_m2: crop.area_m2, daysGrown: 0, plantedSol: s.mission.currentSol });
        } else {
          // Estimate daily contribution from active crops
          const expectedYieldKg = info.yield_kg_m2 * crop.area_m2;
          dailyKcal += (expectedYieldKg * 10 * info.kcal_100g) / info.cycle;
          dailyProtein += (expectedYieldKg * 10 * info.protein_g) / info.cycle;
          newCrops.push(crop);
        }
      }
      mod.crops = newCrops;

      // Water consumption
      const waterUse = mod.crops.reduce((sum, c) => {
        const w = CROP_DB[c.type].water;
        const rate = w === 'high' ? 2 : w === 'moderate-high' ? 1.5 : w === 'moderate' ? 1 : 0.5;
        return sum + rate * c.area_m2;
      }, 0);
      s.resources.water_liters = Math.max(0, s.resources.water_liters - waterUse);
    }

    s.nutrition.current_daily_kcal = Math.round(dailyKcal);
    s.nutrition.current_daily_protein_g = Math.round(dailyProtein);
    s.nutrition.coverage_percent = Math.round(
      Math.min(
        (dailyKcal / s.nutrition.daily_target_kcal) * 100,
        (dailyProtein / s.nutrition.daily_target_protein_g) * 100
      )
    );

    // Water alert
    if (s.resources.water_liters < 1000 && !s.alerts.find(a => a.type === 'water_low')) {
      s.alerts.push({ type: 'water_low', sol: s.mission.currentSol, message: 'Water reserves below 1000L' });
    }
  }

  return s;
}

function plantCrop(state, moduleId, cropType, area_m2) {
  const s = JSON.parse(JSON.stringify(state));
  const mod = s.modules.find(m => m.id === moduleId);
  if (!mod) return s;

  const usedArea = mod.crops.reduce((sum, c) => sum + c.area_m2, 0);
  const availableArea = mod.area_m2 - usedArea;
  const actualArea = Math.min(area_m2, availableArea);

  if (actualArea > 0 && CROP_DB[cropType]) {
    mod.crops.push({
      type: cropType,
      area_m2: actualArea,
      daysGrown: 0,
      plantedSol: s.mission.currentSol,
    });
  }

  return s;
}

function applyActions(state, actions) {
  let s = JSON.parse(JSON.stringify(state));

  for (const action of actions) {
    switch (action.type) {
      case 'plant':
        s = plantCrop(s, action.module, action.crop, action.area_m2);
        break;
      case 'adjust_temperature': {
        const mod = s.modules.find(m => m.id === action.module);
        if (mod) mod.temp = action.value;
        break;
      }
      case 'adjust_humidity': {
        const mod = s.modules.find(m => m.id === action.module);
        if (mod) mod.humidity = action.value;
        break;
      }
      case 'adjust_light': {
        const mod = s.modules.find(m => m.id === action.module);
        if (mod) mod.light = action.value;
        break;
      }
      case 'adjust_co2': {
        const mod = s.modules.find(m => m.id === action.module);
        if (mod) mod.co2 = action.value;
        break;
      }
      case 'harvest': {
        const mod = s.modules.find(m => m.id === action.module);
        if (mod) {
          mod.crops = mod.crops.filter(c => c.type !== action.crop);
        }
        break;
      }
    }
  }

  return s;
}

const STATE_KEY = 'flora-greenhouse-state';
const STATE_API = 'https://lwx98cb4sg.execute-api.us-east-1.amazonaws.com/state';

function saveState(state) {
  const json = JSON.stringify(state);
  try { localStorage.setItem(STATE_KEY, json); } catch {}
  // Async save to server (fire and forget)
  fetch(STATE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json }).catch(() => {});
}

async function loadState() {
  // Try server first (cross-device), fall back to localStorage
  try {
    const res = await fetch(STATE_API);
    if (res.ok) {
      const data = await res.json();
      if (data?.mission) {
        localStorage.setItem(STATE_KEY, JSON.stringify(data));
        return data;
      }
    }
  } catch {}
  // Fallback to localStorage
  try {
    const saved = localStorage.getItem(STATE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return null;
}

function resetState() {
  try { localStorage.removeItem(STATE_KEY); } catch {}
  fetch(STATE_API, { method: 'DELETE' }).catch(() => {});
  return createInitialState();
}

export { CROP_DB, createInitialState, advanceSol, plantCrop, applyActions, saveState, loadState, resetState };
