/**
 * Greenhouse simulation engine — biologically accurate Mars CEA model.
 * Tracks crops, resources, nutrition, energy, water recycling, crew consumption,
 * environmental stress, and random events over a 450-sol mission.
 */

// ── Crop Database (science-grounded profiles) ────────────────────────
const CROP_DB = {
  potato: {
    name: 'Potato', cycle: 95, yield_kg_m2: 6, kcal_100g: 77, protein_g: 2,
    water_L_m2_day: 1.8, light_optimal: [200, 400], temp_optimal: [16, 20],
    temp_lethal: [4, 30], humidity_optimal: [60, 80], co2_boost: true,
    role: 'Caloric backbone', vitaminC: 20, iron: 0.8, fiber: 2.2,
  },
  lettuce: {
    name: 'Lettuce', cycle: 37, yield_kg_m2: 4, kcal_100g: 15, protein_g: 1.4,
    water_L_m2_day: 2.2, light_optimal: [150, 250], temp_optimal: [15, 22],
    temp_lethal: [2, 28], humidity_optimal: [50, 70], co2_boost: true,
    role: 'Micronutrient source', vitaminC: 9, iron: 0.9, fiber: 1.3,
  },
  bean: {
    name: 'Bean', cycle: 60, yield_kg_m2: 2.5, kcal_100g: 31, protein_g: 7,
    water_L_m2_day: 1.4, light_optimal: [200, 350], temp_optimal: [18, 26],
    temp_lethal: [5, 35], humidity_optimal: [50, 70], co2_boost: false,
    role: 'Protein security', vitaminC: 12, iron: 1.8, fiber: 6.4,
  },
  radish: {
    name: 'Radish', cycle: 25, yield_kg_m2: 3, kcal_100g: 16, protein_g: 0.7,
    water_L_m2_day: 1.6, light_optimal: [150, 250], temp_optimal: [15, 22],
    temp_lethal: [2, 30], humidity_optimal: [50, 70], co2_boost: false,
    role: 'Fast buffer crop', vitaminC: 15, iron: 0.3, fiber: 1.6,
  },
  spinach: {
    name: 'Spinach', cycle: 40, yield_kg_m2: 3.5, kcal_100g: 23, protein_g: 2.9,
    water_L_m2_day: 1.5, light_optimal: [150, 250], temp_optimal: [15, 20],
    temp_lethal: [2, 27], humidity_optimal: [50, 65], co2_boost: true,
    role: 'Iron & folate', vitaminC: 28, iron: 2.7, fiber: 2.2,
  },
  herb: {
    name: 'Herbs', cycle: 30, yield_kg_m2: 1.5, kcal_100g: 22, protein_g: 2,
    water_L_m2_day: 0.8, light_optimal: [150, 300], temp_optimal: [18, 24],
    temp_lethal: [5, 32], humidity_optimal: [40, 60], co2_boost: false,
    role: 'Flavor & morale', vitaminC: 18, iron: 1.2, fiber: 1.0,
  },
};

// ── Mars Constants ───────────────────────────────────────────────────
const MARS = {
  solar_irradiance_factor: 0.43,  // vs Earth
  gravity: 0.38,                   // vs Earth
  atmo_pressure_mbar: 6.5,
  avg_temp_c: -63,
  sol_hours: 24.65,
};

// ── Crew Constants ───────────────────────────────────────────────────
const CREW = {
  size: 4,
  kcal_per_person_day: 2500,      // NASA standard
  protein_per_person_day: 55,      // g, NASA minimum
  water_drinking_per_person_day: 2.5,  // L
  water_hygiene_per_person_day: 3,     // L
  morale_base: 80,
};

// ── Event Templates ──────────────────────────────────────────────────
const EVENT_TEMPLATES = [
  {
    id: 'dust_storm', name: 'Dust Storm', probability: 0.008,
    duration: [5, 20], severity: [0.3, 0.7],
    effect: 'solar_reduction', minSol: 30,
    desc: (sev) => `Regional dust storm reducing solar output by ${Math.round(sev * 100)}%`,
  },
  {
    id: 'hvac_malfunction', name: 'HVAC Malfunction', probability: 0.005,
    duration: [2, 8], severity: [0.3, 0.6],
    effect: 'temp_drift', minSol: 20, targetModule: true,
    desc: (sev) => `HVAC system degraded — temperature regulation reduced by ${Math.round(sev * 100)}%`,
  },
  {
    id: 'water_recycler_fault', name: 'Water Recycler Fault', probability: 0.004,
    duration: [3, 10], severity: [0.1, 0.3],
    effect: 'recycling_drop', minSol: 40,
    desc: (sev) => `Water recycling efficiency dropped by ${Math.round(sev * 100)}%`,
  },
  {
    id: 'co2_scrubber_issue', name: 'CO₂ Scrubber Issue', probability: 0.003,
    duration: [2, 6], severity: [0.2, 0.5],
    effect: 'co2_spike', minSol: 50, targetModule: true,
    desc: (sev) => `CO₂ scrubber degraded — levels rising ${Math.round(sev * 100)}% above nominal`,
  },
  {
    id: 'led_panel_failure', name: 'LED Panel Failure', probability: 0.004,
    duration: [1, 5], severity: [0.2, 0.5],
    effect: 'light_reduction', minSol: 30, targetModule: true,
    desc: (sev) => `LED array partial failure — light output reduced by ${Math.round(sev * 100)}%`,
  },
];

function createInitialState() {
  return {
    mission: {
      name: 'Asterion Four',
      currentSol: 1,
      totalSols: 450,
      crew: CREW.size,
      phase: 'Setup',
      morale: CREW.morale_base,
    },
    modules: [
      { id: 1, name: 'Module Alpha', area_m2: 20, crops: [], temp: 19, humidity: 60, co2: 800, light: 250, temp_target: 19, hvac_status: 1.0 },
      { id: 2, name: 'Module Beta', area_m2: 20, crops: [], temp: 19, humidity: 60, co2: 800, light: 250, temp_target: 19, hvac_status: 1.0 },
      { id: 3, name: 'Module Gamma', area_m2: 20, crops: [], temp: 19, humidity: 60, co2: 800, light: 250, temp_target: 19, hvac_status: 1.0 },
    ],
    resources: {
      water_liters: 5000,
      water_recycling_efficiency: 0.92,    // 92% recovery
      energy_kwh_daily: 200,               // daily solar production baseline
      energy_stored_kwh: 800,              // battery reserve
      solar_efficiency: 1.0,               // reduced by dust storms
      co2_kg: 50,
    },
    nutrition: {
      daily_target_kcal: CREW.size * CREW.kcal_per_person_day,
      daily_target_protein_g: CREW.size * CREW.protein_per_person_day,
      current_daily_kcal: 0,
      current_daily_protein_g: 0,
      coverage_percent: 0,
      food_reserves_days: 30, // emergency rations
    },
    energy: {
      solar_production: 200,
      led_consumption: 0,
      hvac_consumption: 0,
      systems_consumption: 40,  // life support baseline
      crew_consumption: 20,     // crew systems
      balance: 0,
    },
    crew: {
      daily_water_need: CREW.size * (CREW.water_drinking_per_person_day + CREW.water_hygiene_per_person_day),
      daily_kcal_need: CREW.size * CREW.kcal_per_person_day,
      daily_protein_need: CREW.size * CREW.protein_per_person_day,
    },
    harvests: [],
    events: [],       // active events [{id, name, desc, sol_start, sol_end, severity, effect, module?}]
    eventLog: [],     // historical events
    alerts: [],
    agentActions: [], // proactive AI actions [{sol, action, reason}]
  };
}

// ── Crop stress factor (0-1, 1 = optimal) ────────────────────────────
function cropStressFactor(crop, mod) {
  const info = CROP_DB[crop.type];
  let stress = 1.0;

  // Temperature stress
  const [tMin, tMax] = info.temp_optimal;
  const [tLethalMin, tLethalMax] = info.temp_lethal;
  if (mod.temp < tLethalMin || mod.temp > tLethalMax) stress *= 0;
  else if (mod.temp < tMin) stress *= 0.3 + 0.7 * ((mod.temp - tLethalMin) / (tMin - tLethalMin));
  else if (mod.temp > tMax) stress *= 0.3 + 0.7 * ((tLethalMax - mod.temp) / (tLethalMax - tMax));

  // Light stress
  const [lMin, lMax] = info.light_optimal;
  if (mod.light < lMin * 0.3) stress *= 0.1;
  else if (mod.light < lMin) stress *= 0.4 + 0.6 * ((mod.light - lMin * 0.3) / (lMin - lMin * 0.3));
  else if (mod.light > lMax * 1.5) stress *= 0.7;

  // Humidity stress
  const [hMin, hMax] = info.humidity_optimal;
  if (mod.humidity < hMin - 20 || mod.humidity > hMax + 20) stress *= 0.5;
  else if (mod.humidity < hMin || mod.humidity > hMax) stress *= 0.8;

  // CO2 benefit
  if (info.co2_boost && mod.co2 > 800) stress *= Math.min(1.15, 1 + (mod.co2 - 800) / 5000);

  return Math.max(0, Math.min(1.2, stress));
}

// ── Proactive AI Agent Logic ─────────────────────────────────────────
function runProactiveAgent(s) {
  const actions = [];

  for (const mod of s.modules) {
    // Auto-correct temperature if HVAC is working
    if (mod.hvac_status > 0.5) {
      const avgOptimal = mod.crops.length > 0
        ? mod.crops.reduce((sum, c) => sum + (CROP_DB[c.type].temp_optimal[0] + CROP_DB[c.type].temp_optimal[1]) / 2, 0) / mod.crops.length
        : 19;
      if (Math.abs(mod.temp - avgOptimal) > 2) {
        const oldTemp = mod.temp;
        mod.temp += (avgOptimal - mod.temp) * 0.3 * mod.hvac_status;
        mod.temp = Math.round(mod.temp * 10) / 10;
        actions.push({ sol: s.mission.currentSol, action: `Adjusted ${mod.name} temp ${oldTemp}°C → ${mod.temp}°C`, reason: 'Optimizing for planted crops' });
      }
    }

    // Heat stress detection — dim LEDs to slow bolting
    for (const crop of mod.crops) {
      const info = CROP_DB[crop.type];
      if (mod.temp > info.temp_optimal[1] + 3 && mod.light > info.light_optimal[0]) {
        mod.light = Math.max(info.light_optimal[0], mod.light * 0.85);
        mod.light = Math.round(mod.light);
        actions.push({ sol: s.mission.currentSol, action: `Dimmed LEDs in ${mod.name}`, reason: `Heat stress on ${info.name} — reducing light to delay bolting` });
        break;
      }
    }
  }

  // Energy crisis — throttle non-essential systems
  if (s.energy.balance < -20 && s.resources.energy_stored_kwh < 200) {
    for (const mod of s.modules) {
      if (mod.light > 150) {
        mod.light = Math.round(mod.light * 0.7);
        actions.push({ sol: s.mission.currentSol, action: `Reduced LED intensity in ${mod.name}`, reason: 'Energy crisis — conserving battery reserves' });
      }
    }
  }

  // Nutrition forecast — warn if calories will be insufficient in 30 days
  if (s.nutrition.coverage_percent < 60 && s.mission.currentSol > 30) {
    const emptyModules = s.modules.filter(m => m.crops.reduce((s, c) => s + c.area_m2, 0) < m.area_m2 * 0.5);
    if (emptyModules.length > 0) {
      actions.push({ sol: s.mission.currentSol, action: 'Nutrition deficit forecast', reason: `Coverage at ${s.nutrition.coverage_percent}%. Recommend planting potatoes in ${emptyModules.map(m => m.name).join(', ')}` });
    }
  }

  // Water alert
  const daysOfWater = s.resources.water_liters / (s.crew.daily_water_need + 20); // rough estimate
  if (daysOfWater < 30) {
    actions.push({ sol: s.mission.currentSol, action: 'Water reserve warning', reason: `Only ~${Math.round(daysOfWater)} days of water remaining at current usage` });
  }

  // Morale
  const totalCrops = s.modules.reduce((sum, m) => sum + m.crops.length, 0);
  const hasHerbs = s.modules.some(m => m.crops.some(c => c.type === 'herb'));
  s.mission.morale = Math.min(100, Math.max(20,
    CREW.morale_base
    + (s.nutrition.coverage_percent >= 80 ? 10 : s.nutrition.coverage_percent >= 50 ? 0 : -15)
    + (hasHerbs ? 5 : 0)
    + (totalCrops > 5 ? 5 : 0)
    + (s.events.length > 0 ? -10 : 0)
    + (s.resources.energy_stored_kwh < 100 ? -10 : 0)
  ));

  if (actions.length > 0) {
    s.agentActions = s.agentActions.concat(actions).slice(-20); // keep last 20
  }
}

// ── Main simulation step ─────────────────────────────────────────────
function advanceSol(state, days = 1) {
  const s = JSON.parse(JSON.stringify(state));

  for (let d = 0; d < days; d++) {
    s.mission.currentSol++;

    // Mission phase
    if (s.mission.currentSol <= 30) s.mission.phase = 'Setup';
    else if (s.mission.currentSol <= 400) s.mission.phase = 'Production';
    else s.mission.phase = 'Wind-down';

    // ── Random Events ──
    for (const template of EVENT_TEMPLATES) {
      if (s.mission.currentSol < template.minSol) continue;
      if (s.events.find(e => e.id === template.id)) continue; // already active
      if (Math.random() < template.probability) {
        const duration = template.duration[0] + Math.floor(Math.random() * (template.duration[1] - template.duration[0]));
        const severity = template.severity[0] + Math.random() * (template.severity[1] - template.severity[0]);
        const event = {
          id: template.id, name: template.name,
          desc: template.desc(severity),
          sol_start: s.mission.currentSol, sol_end: s.mission.currentSol + duration,
          severity, effect: template.effect,
        };
        if (template.targetModule) {
          event.module = s.modules[Math.floor(Math.random() * s.modules.length)].id;
        }
        s.events.push(event);
        s.eventLog.push({ ...event, logged: true });
        s.alerts.push({ type: template.id, sol: s.mission.currentSol, message: `${template.name}: ${template.desc(severity)}`, severity: severity > 0.5 ? 'critical' : 'warning' });
      }
    }

    // Expire old events
    s.events = s.events.filter(e => s.mission.currentSol <= e.sol_end);

    // ── Apply Active Event Effects ──
    let solarFactor = s.resources.solar_efficiency;
    for (const event of s.events) {
      switch (event.effect) {
        case 'solar_reduction':
          solarFactor *= (1 - event.severity);
          break;
        case 'temp_drift': {
          const mod = s.modules.find(m => m.id === event.module);
          if (mod) {
            mod.hvac_status = Math.max(0.2, 1 - event.severity);
            mod.temp += (MARS.avg_temp_c * 0.01) * event.severity; // drift toward cold
            mod.temp = Math.round(mod.temp * 10) / 10;
          }
          break;
        }
        case 'recycling_drop':
          s.resources.water_recycling_efficiency = Math.max(0.5, 0.92 - event.severity);
          break;
        case 'co2_spike': {
          const mod = s.modules.find(m => m.id === event.module);
          if (mod) mod.co2 = Math.min(2000, mod.co2 + Math.round(event.severity * 300));
          break;
        }
        case 'light_reduction': {
          const mod = s.modules.find(m => m.id === event.module);
          if (mod) mod.light = Math.max(50, Math.round(mod.light * (1 - event.severity)));
          break;
        }
      }
    }

    // Restore recycling when no active fault
    if (!s.events.find(e => e.effect === 'recycling_drop')) {
      s.resources.water_recycling_efficiency = 0.92;
    }

    // Restore HVAC when no active malfunction
    for (const mod of s.modules) {
      if (!s.events.find(e => e.effect === 'temp_drift' && e.module === mod.id)) {
        mod.hvac_status = 1.0;
      }
    }

    // ── Energy Budget ──
    s.energy.solar_production = Math.round(s.resources.energy_kwh_daily * solarFactor);
    s.energy.led_consumption = 0;
    s.energy.hvac_consumption = 0;
    for (const mod of s.modules) {
      const cropArea = mod.crops.reduce((sum, c) => sum + c.area_m2, 0);
      s.energy.led_consumption += Math.round(cropArea * mod.light * 0.012); // kWh per m² per µmol
      s.energy.hvac_consumption += Math.round(Math.abs(mod.temp - MARS.avg_temp_c) * 0.15 * (1 / mod.hvac_status));
    }
    const totalConsumption = s.energy.led_consumption + s.energy.hvac_consumption + s.energy.systems_consumption + s.energy.crew_consumption;
    s.energy.balance = s.energy.solar_production - totalConsumption;
    s.resources.energy_stored_kwh = Math.max(0, Math.min(1000, s.resources.energy_stored_kwh + s.energy.balance));

    // ── Water Budget ──
    let totalWaterUse = s.crew.daily_water_need; // crew drinking + hygiene
    for (const mod of s.modules) {
      for (const crop of mod.crops) {
        totalWaterUse += CROP_DB[crop.type].water_L_m2_day * crop.area_m2;
      }
    }
    const waterRecycled = totalWaterUse * s.resources.water_recycling_efficiency;
    const netWaterLoss = totalWaterUse - waterRecycled;
    s.resources.water_liters = Math.max(0, s.resources.water_liters - netWaterLoss);

    // ── Grow Crops ──
    let dailyKcal = 0;
    let dailyProtein = 0;

    for (const mod of s.modules) {
      const newCrops = [];
      for (const crop of mod.crops) {
        crop.daysGrown++;
        const info = CROP_DB[crop.type];
        const stress = cropStressFactor(crop, mod);
        crop.health = Math.round(stress * 100); // store for display

        // Lethal conditions
        if (stress === 0) {
          s.alerts.push({ type: 'crop_death', sol: s.mission.currentSol, message: `${info.name} in ${mod.name} died — lethal conditions`, severity: 'critical' });
          continue; // crop dies, not added to newCrops
        }

        if (crop.daysGrown >= info.cycle) {
          const yieldKg = info.yield_kg_m2 * crop.area_m2 * stress; // stress affects yield
          s.harvests.push({
            sol: s.mission.currentSol, crop: info.name, module: mod.id,
            yield_kg: Math.round(yieldKg * 10) / 10, stress: crop.health,
          });
          dailyKcal += (yieldKg * 10 * info.kcal_100g) / info.cycle;
          dailyProtein += (yieldKg * 10 * info.protein_g) / info.cycle;
          // Auto-replant
          newCrops.push({ type: crop.type, area_m2: crop.area_m2, daysGrown: 0, plantedSol: s.mission.currentSol, health: 100 });
        } else {
          const expectedYieldKg = info.yield_kg_m2 * crop.area_m2 * stress;
          dailyKcal += (expectedYieldKg * 10 * info.kcal_100g) / info.cycle;
          dailyProtein += (expectedYieldKg * 10 * info.protein_g) / info.cycle;
          newCrops.push(crop);
        }
      }
      mod.crops = newCrops;
    }

    s.nutrition.current_daily_kcal = Math.round(dailyKcal);
    s.nutrition.current_daily_protein_g = Math.round(dailyProtein);
    s.nutrition.coverage_percent = Math.round(
      Math.min(
        (dailyKcal / s.nutrition.daily_target_kcal) * 100,
        (dailyProtein / s.nutrition.daily_target_protein_g) * 100
      )
    );

    // Consume emergency rations if coverage < 50%
    if (s.nutrition.coverage_percent < 50 && s.nutrition.food_reserves_days > 0) {
      s.nutrition.food_reserves_days = Math.max(0, s.nutrition.food_reserves_days - (1 - s.nutrition.coverage_percent / 100));
    }

    // ── Run Proactive Agent ──
    runProactiveAgent(s);

    // ── Alerts cleanup (keep last 20) ──
    if (s.alerts.length > 20) s.alerts = s.alerts.slice(-20);
    if (s.eventLog.length > 30) s.eventLog = s.eventLog.slice(-30);
  }

  return s;
}

function plantCrop(state, moduleId, cropType, area_m2) {
  const s = JSON.parse(JSON.stringify(state));
  const mod = s.modules.find(m => m.id === moduleId);
  if (!mod) return s;
  const usedArea = mod.crops.reduce((sum, c) => sum + c.area_m2, 0);
  const actualArea = Math.min(area_m2, mod.area_m2 - usedArea);
  if (actualArea > 0 && CROP_DB[cropType]) {
    mod.crops.push({ type: cropType, area_m2: actualArea, daysGrown: 0, plantedSol: s.mission.currentSol, health: 100 });
  }
  return s;
}

function applyActions(state, actions) {
  let s = JSON.parse(JSON.stringify(state));
  for (const action of actions) {
    switch (action.type) {
      case 'plant': s = plantCrop(s, action.module, action.crop, action.area_m2); break;
      case 'adjust_temperature': { const m = s.modules.find(m => m.id === action.module); if (m) { m.temp = action.value; m.temp_target = action.value; } break; }
      case 'adjust_humidity': { const m = s.modules.find(m => m.id === action.module); if (m) m.humidity = action.value; break; }
      case 'adjust_light': { const m = s.modules.find(m => m.id === action.module); if (m) m.light = action.value; break; }
      case 'adjust_co2': { const m = s.modules.find(m => m.id === action.module); if (m) m.co2 = action.value; break; }
      case 'harvest': { const m = s.modules.find(m => m.id === action.module); if (m) m.crops = m.crops.filter(c => c.type !== action.crop); break; }
    }
  }
  return s;
}

// ── Persistence ──────────────────────────────────────────────────────
const STATE_KEY = 'flora-greenhouse-state';
const STATE_API = 'https://lwx98cb4sg.execute-api.us-east-1.amazonaws.com/state';

function saveState(state) {
  const json = JSON.stringify(state);
  try { localStorage.setItem(STATE_KEY, json); } catch {}
  fetch(STATE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json }).catch(() => {});
}

async function loadState() {
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

export { CROP_DB, MARS, CREW, createInitialState, advanceSol, plantCrop, applyActions, cropStressFactor, saveState, loadState, resetState };
