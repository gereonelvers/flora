/**
 * Greenhouse simulation engine — biologically accurate Mars CEA model.
 * Tracks crops, resources, nutrition, energy, water recycling, crew consumption,
 * environmental stress, and random events over a 450-sol mission.
 */

// ── Crop Database (science-grounded profiles) ────────────────────────
// Growth phases: seedling (0-20%), vegetative (20-60%), fruiting/bulking (60-90%), mature (90-100%)
// Water demand scales with growth phase. Nutrition only from harvested food reserves.
// Yields are NASA CEA hydroponic levels (2-4x higher than field agriculture)
// Source: NASA Biomass Production System research, Kennedy Space Center CEA studies
const CROP_DB = {
  potato: {
    name: 'Potato', cycle: 95, yield_kg_m2: 18, kcal_100g: 77, protein_g: 2,
    water_L_m2_day: 2.4, light_optimal: [200, 400], temp_optimal: [16, 20],
    temp_lethal: [4, 30], humidity_optimal: [60, 80], co2_boost: true,
    role: 'Caloric backbone', vitaminC: 20, iron: 0.8, fiber: 2.2,
    replantDays: 3,
  },
  lettuce: {
    name: 'Lettuce', cycle: 28, yield_kg_m2: 12, kcal_100g: 15, protein_g: 1.4,
    water_L_m2_day: 2.8, light_optimal: [150, 250], temp_optimal: [15, 22],
    temp_lethal: [2, 28], humidity_optimal: [50, 70], co2_boost: true,
    role: 'Micronutrient source', vitaminC: 9, iron: 0.9, fiber: 1.3,
    replantDays: 1,
  },
  bean: {
    name: 'Bean', cycle: 55, yield_kg_m2: 8, kcal_100g: 31, protein_g: 7,
    water_L_m2_day: 1.8, light_optimal: [200, 350], temp_optimal: [18, 26],
    temp_lethal: [5, 35], humidity_optimal: [50, 70], co2_boost: false,
    role: 'Protein security', vitaminC: 12, iron: 1.8, fiber: 6.4,
    replantDays: 2,
  },
  radish: {
    name: 'Radish', cycle: 22, yield_kg_m2: 9, kcal_100g: 16, protein_g: 0.7,
    water_L_m2_day: 2.0, light_optimal: [150, 250], temp_optimal: [15, 22],
    temp_lethal: [2, 30], humidity_optimal: [50, 70], co2_boost: false,
    role: 'Fast buffer crop', vitaminC: 15, iron: 0.3, fiber: 1.6,
    replantDays: 1,
  },
  spinach: {
    name: 'Spinach', cycle: 35, yield_kg_m2: 10, kcal_100g: 23, protein_g: 2.9,
    water_L_m2_day: 2.0, light_optimal: [150, 250], temp_optimal: [15, 20],
    temp_lethal: [2, 27], humidity_optimal: [50, 65], co2_boost: true,
    role: 'Iron & folate', vitaminC: 28, iron: 2.7, fiber: 2.2,
    replantDays: 1,
  },
  herb: {
    name: 'Herbs', cycle: 25, yield_kg_m2: 5, kcal_100g: 22, protein_g: 2,
    water_L_m2_day: 1.0, light_optimal: [150, 300], temp_optimal: [18, 24],
    temp_lethal: [5, 32], humidity_optimal: [40, 60], co2_boost: false,
    role: 'Flavor & morale', vitaminC: 18, iron: 1.2, fiber: 1.0,
    replantDays: 1,
  },
};

// ── Mars Constants ───────────────────────────────────────────────────
const MARS = {
  solar_irradiance_factor: 0.43,  // vs Earth
  gravity: 0.38,                   // vs Earth
  atmo_pressure_mbar: 6.5,
  avg_temp_c: -63,
  sol_hours: 24.65,
  daylight_fraction: 0.55,        // ~13.5 hours of usable daylight per sol (avg)
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

// ── Growth phase: returns 0-1 multiplier for how productive this growth stage is ──
// Seedlings produce nothing. Vegetative phase ramps up. Peak at fruiting. Mature = ready.
function growthPhaseFactor(daysGrown, cycle) {
  const pct = daysGrown / cycle;
  if (pct < 0.15) return 0;                          // seedling — no yield
  if (pct < 0.4) return (pct - 0.15) / 0.25 * 0.3;  // vegetative — ramps to 30%
  if (pct < 0.75) return 0.3 + ((pct - 0.4) / 0.35) * 0.7; // fruiting/bulking — ramps to 100%
  return 1.0;                                         // mature — full yield
}

// Water demand scales with growth phase (seedlings need less water)
function waterDemandFactor(daysGrown, cycle) {
  const pct = daysGrown / cycle;
  if (pct < 0.15) return 0.3;   // seedling
  if (pct < 0.4) return 0.6;    // vegetative
  return 1.0;                    // fruiting + mature
}

function createInitialState() {
  return {
    mission: {
      name: 'Asterion Four',
      currentSol: 1,
      totalSols: 450,
      crew: CREW.size,
      phase: 'Setup',
      morale: CREW.morale_base,
      started: false,
      simSpeed: 1500,
      solFraction: 0,
      solFractionUpdatedAt: Date.now(), // timestamp for cross-device interpolation
    },
    modules: [
      { id: 1, name: 'Module Alpha', area_m2: 30, crops: [], temp: 19, humidity: 60, co2: 800, light: 250, temp_target: 19, hvac_status: 1.0, onlineSol: 2 },
      { id: 2, name: 'Module Beta', area_m2: 30, crops: [], temp: 19, humidity: 60, co2: 800, light: 250, temp_target: 19, hvac_status: 1.0, onlineSol: 2 },
      { id: 3, name: 'Module Gamma', area_m2: 30, crops: [], temp: 19, humidity: 60, co2: 800, light: 250, temp_target: 19, hvac_status: 1.0, onlineSol: 2 },
    ],
    resources: {
      water_liters: 5000,
      water_recycling_efficiency: 0.92,
      energy_kwh_daily: 200,           // peak solar production (at noon, clear sky)
      energy_stored_kwh: 800,
      solar_efficiency: 1.0,
      co2_kg: 50,
    },
    nutrition: {
      daily_target_kcal: CREW.size * CREW.kcal_per_person_day,
      daily_target_protein_g: CREW.size * CREW.protein_per_person_day,
      current_daily_kcal: 0,
      current_daily_protein_g: 0,
      coverage_percent: 0,
      food_reserves_days: 60,
      food_stored_kcal: 0,            // harvested food in storage (kcal)
      food_stored_protein: 0,         // harvested food in storage (g protein)
    },
    energy: {
      solar_production: 0,
      led_consumption: 0,
      hvac_consumption: 0,
      systems_consumption: 40,
      crew_consumption: 20,
      balance: 0,
    },
    crew: {
      daily_water_need: CREW.size * (CREW.water_drinking_per_person_day + CREW.water_hygiene_per_person_day),
      daily_kcal_need: CREW.size * CREW.kcal_per_person_day,
      daily_protein_need: CREW.size * CREW.protein_per_person_day,
      members: [
        { name: 'Cmdr. Jeff Rowe', role: 'Chief Agronomist & Mission Lead', kcal_need: 2800, health: 100, daysWithoutFood: 0, alive: true, photo: '/crew/rowe.png' },
        { name: 'Cmdr. Jeff Bezos', role: 'Mission Commander', kcal_need: 2400, health: 100, daysWithoutFood: 0, alive: true, photo: '/crew/bezos.png' },
        { name: 'Dr. Jeff Goldblum', role: 'Flight Surgeon', kcal_need: 2600, health: 100, daysWithoutFood: 0, alive: true, photo: '/crew/goldblum.png' },
        { name: 'Dr. Jeff Bridges', role: 'Botanist', kcal_need: 2200, health: 100, daysWithoutFood: 0, alive: true, photo: '/crew/bridges.png' },
      ],
    },
    genetics: {
      mutations: [],
      totalRadiationEvents: 0,
    },
    harvests: [],
    events: [],
    eventLog: [],
    alerts: [],
    agentActions: [],
  };
}

// ── Crop stress factor (0-1.2, 1 = optimal) ──────────────────────────
// Now includes accumulated stress tracking and compound effects
function cropStressFactor(crop, mod, genetics) {
  const info = CROP_DB[crop.type];
  let stress = 1.0;

  // Temperature stress (continuous, not instant-kill for brief exposure)
  const [tMin, tMax] = info.temp_optimal;
  const [tLethalMin, tLethalMax] = info.temp_lethal;
  if (mod.temp < tLethalMin || mod.temp > tLethalMax) {
    stress *= 0; // lethal
  } else if (mod.temp < tMin) {
    stress *= 0.3 + 0.7 * ((mod.temp - tLethalMin) / (tMin - tLethalMin));
  } else if (mod.temp > tMax) {
    stress *= 0.3 + 0.7 * ((tLethalMax - mod.temp) / (tLethalMax - tMax));
  }

  // Light stress
  const [lMin, lMax] = info.light_optimal;
  if (mod.light < lMin * 0.3) stress *= 0.1;
  else if (mod.light < lMin) stress *= 0.4 + 0.6 * ((mod.light - lMin * 0.3) / (lMin - lMin * 0.3));
  else if (mod.light > lMax * 1.5) stress *= 0.7;

  // Humidity stress — compounds with temperature (hot + dry is worse)
  const [hMin, hMax] = info.humidity_optimal;
  let humidityPenalty = 1.0;
  if (mod.humidity < hMin - 20 || mod.humidity > hMax + 20) humidityPenalty = 0.5;
  else if (mod.humidity < hMin || mod.humidity > hMax) humidityPenalty = 0.8;
  // Compound: if temp is also stressed, humidity penalty hits harder
  if (humidityPenalty < 1 && stress < 0.8) {
    humidityPenalty *= 0.85; // compound effect
  }
  stress *= humidityPenalty;

  // CO2 benefit
  if (info.co2_boost && mod.co2 > 800) stress *= Math.min(1.15, 1 + (mod.co2 - 800) / 5000);

  // Accumulated stress damage (stored on the crop object)
  // Each sol of stress below 0.7 causes permanent damage that doesn't recover
  if (crop.accumulatedDamage) {
    stress *= Math.max(0.5, 1 - crop.accumulatedDamage);
  }

  // DNA mutation damage
  if (genetics?.mutations) {
    const cropMuts = genetics.mutations.filter(m => m.crop === crop.type && m.scored);
    let geneticPenalty = 1.0;
    for (const m of cropMuts) {
      if (m.interpretation === 'disruptive') geneticPenalty *= 0.92;
      else if (m.interpretation === 'suspicious') geneticPenalty *= 0.96;
    }
    stress *= Math.max(0.5, geneticPenalty);
  }

  return Math.max(0, Math.min(1.2, stress));
}

// ── Safety Overrides ────────────────────────────────────────────────
function runSafetyOverrides(s) {
  const actions = [];

  for (const mod of s.modules) {
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

  if (s.energy.balance < -20 && s.resources.energy_stored_kwh < 200) {
    for (const mod of s.modules) {
      if (mod.light > 150) {
        mod.light = Math.round(mod.light * 0.7);
        actions.push({ sol: s.mission.currentSol, action: `Reduced LED intensity in ${mod.name}`, reason: 'Energy crisis — conserving battery reserves' });
      }
    }
  }

  // Nutrition warnings — tiered by severity
  const storedKcal = s.nutrition.food_stored_kcal || 0;
  const daysOfFood = storedKcal > 0 ? Math.round(storedKcal / s.nutrition.daily_target_kcal) : 0;
  const emptyModules = s.modules.filter(m => m.crops.reduce((sum, c) => sum + c.area_m2, 0) < m.area_m2 * 0.5);

  if (storedKcal === 0 && s.nutrition.food_reserves_days <= 0) {
    s.alerts.push({ type: 'starvation', sol: s.mission.currentSol, message: 'CRITICAL: No food remaining — crew starvation imminent', severity: 'critical' });
    actions.push({ sol: s.mission.currentSol, action: 'Starvation alert', reason: 'All food reserves depleted. No stored food. Plant fast-growing crops immediately.' });
  } else if (s.nutrition.food_reserves_days > 0 && s.nutrition.food_reserves_days < 10 && storedKcal < s.nutrition.daily_target_kcal * 3) {
    actions.push({ sol: s.mission.currentSol, action: 'Emergency rations running low', reason: `${Math.round(s.nutrition.food_reserves_days)} days of rations left, ${daysOfFood} days of stored food. Need harvests soon.` });
  } else if (daysOfFood < 7 && s.harvests.length > 0) {
    actions.push({ sol: s.mission.currentSol, action: 'Food storage critically low', reason: `Only ${daysOfFood} days of stored food. Coverage at ${s.nutrition.coverage_percent}%.` });
  } else if (s.nutrition.coverage_percent < 60 && emptyModules.length > 0) {
    actions.push({ sol: s.mission.currentSol, action: 'Nutrition deficit', reason: `Coverage at ${s.nutrition.coverage_percent}%. Recommend planting in ${emptyModules.map(m => m.name).join(', ')}` });
  }

  const daysOfWater = s.resources.water_liters / (s.crew.daily_water_need + 20);
  if (daysOfWater < 30) {
    actions.push({ sol: s.mission.currentSol, action: 'Water reserve warning', reason: `Only ~${Math.round(daysOfWater)} days of water remaining at current usage` });
  }

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
    s.agentActions = s.agentActions.concat(actions).slice(-20);
  }
}

// ── Main simulation step ─────────────────────────────────────────────
function advanceSol(state, days = 1) {
  const s = JSON.parse(JSON.stringify(state));

  for (let d = 0; d < days; d++) {
    s.mission.currentSol++;

    // Mission phase — derived from actual state, not arbitrary sol ranges
    const totalPlanted = s.modules.reduce((sum, m) => sum + m.crops.length, 0);
    const hasHarvested = s.harvests.length > 0;
    const solsLeft = s.mission.totalSols - s.mission.currentSol;
    if (totalPlanted === 0 && !hasHarvested) s.mission.phase = 'Pre-planting';
    else if (!hasHarvested) s.mission.phase = 'Growing';
    else if (solsLeft <= 30) s.mission.phase = 'Final harvest';
    else if ((s.nutrition.food_stored_kcal || 0) < s.nutrition.daily_target_kcal * 7) s.mission.phase = 'Food shortage';
    else s.mission.phase = 'Nominal';

    // ── Random Events ──
    for (const template of EVENT_TEMPLATES) {
      if (s.mission.currentSol < template.minSol) continue;
      if (s.events.find(e => e.id === template.id)) continue;
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
            mod.temp += (MARS.avg_temp_c * 0.01) * event.severity;
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

    if (!s.events.find(e => e.effect === 'recycling_drop')) {
      s.resources.water_recycling_efficiency = 0.92;
    }
    for (const mod of s.modules) {
      if (!s.events.find(e => e.effect === 'temp_drift' && e.module === mod.id)) {
        mod.hvac_status = 1.0;
      }
    }

    // ── Energy Budget (day/night aware) ──
    // Solar only produces during daylight hours (~55% of sol on Mars average)
    // Peak production × daylight fraction × atmospheric/dust factors
    const solarDaily = Math.round(s.resources.energy_kwh_daily * solarFactor * MARS.daylight_fraction);
    s.energy.solar_production = solarDaily;

    s.energy.led_consumption = 0;
    s.energy.hvac_consumption = 0;
    for (const mod of s.modules) {
      // LEDs: power = area × PAR intensity × efficiency factor
      // 0.0065 kWh/m²/µmol is derived from typical horticultural LED efficiency (~2.5 µmol/J)
      const cropArea = mod.crops.reduce((sum, c) => sum + c.area_m2, 0);
      s.energy.led_consumption += Math.round(cropArea * mod.light * 0.0065);
      // HVAC: heating from -63°C Mars ambient to ~19°C, efficiency depends on HVAC health
      s.energy.hvac_consumption += Math.round(Math.abs(mod.temp - MARS.avg_temp_c) * 0.15 * (1 / mod.hvac_status));
    }
    const totalConsumption = s.energy.led_consumption + s.energy.hvac_consumption + s.energy.systems_consumption + s.energy.crew_consumption;
    s.energy.balance = solarDaily - totalConsumption;
    s.resources.energy_stored_kwh = Math.max(0, Math.min(1000, s.resources.energy_stored_kwh + s.energy.balance));

    // ── Water Budget (growth-phase aware) ──
    let totalWaterUse = s.crew.daily_water_need;
    for (const mod of s.modules) {
      for (const crop of mod.crops) {
        if (crop.replantCountdown > 0) continue; // replanting, no water use
        const info = CROP_DB[crop.type];
        const waterFactor = waterDemandFactor(crop.daysGrown, info.cycle);
        totalWaterUse += info.water_L_m2_day * crop.area_m2 * waterFactor;
      }
    }
    const waterRecycled = totalWaterUse * s.resources.water_recycling_efficiency;
    const netWaterLoss = totalWaterUse - waterRecycled;
    s.resources.water_liters = Math.max(0, s.resources.water_liters - netWaterLoss);

    // ── Grow Crops ──
    for (const mod of s.modules) {
      if (mod.onlineSol && s.mission.currentSol < mod.onlineSol) continue;

      const newCrops = [];
      for (const crop of mod.crops) {
        const info = CROP_DB[crop.type];

        // Handle replant countdown (turnaround time between harvests)
        if (crop.replantCountdown > 0) {
          crop.replantCountdown--;
          newCrops.push(crop);
          continue;
        }

        crop.daysGrown++;
        const stress = cropStressFactor(crop, mod, s.genetics);
        crop.health = Math.round(stress * 100);

        // Accumulate stress damage (permanent, doesn't recover)
        if (stress < 0.7 && stress > 0) {
          crop.accumulatedDamage = (crop.accumulatedDamage || 0) + (0.7 - stress) * 0.02;
        }

        // Lethal conditions
        if (stress === 0) {
          s.alerts.push({ type: 'crop_death', sol: s.mission.currentSol, message: `${info.name} in ${mod.name} died — lethal conditions`, severity: 'critical' });
          continue;
        }

        if (crop.daysGrown >= info.cycle) {
          // Harvest! Yield goes into food storage, NOT directly to daily nutrition
          const yieldKg = info.yield_kg_m2 * crop.area_m2 * stress;
          const harvestedKcal = yieldKg * 10 * info.kcal_100g;
          const harvestedProtein = yieldKg * 10 * info.protein_g;

          s.nutrition.food_stored_kcal = (s.nutrition.food_stored_kcal || 0) + harvestedKcal;
          s.nutrition.food_stored_protein = (s.nutrition.food_stored_protein || 0) + harvestedProtein;

          s.harvests.push({
            sol: s.mission.currentSol, crop: info.name, module: mod.id,
            yield_kg: Math.round(yieldKg * 10) / 10, stress: crop.health,
          });

          // Auto-replant with turnaround delay
          newCrops.push({
            type: crop.type, area_m2: crop.area_m2, daysGrown: 0,
            plantedSol: s.mission.currentSol, health: 100,
            replantCountdown: info.replantDays || 2, accumulatedDamage: 0,
          });
        } else {
          newCrops.push(crop);
        }
      }
      mod.crops = newCrops;
    }

    // ── Nutrition (per-crew-member consumption from stored food) ──
    // Initialize crew members if missing (old saves)
    if (!s.crew.members) {
      s.crew.members = [
        { name: 'Cmdr. Jeff Rowe', role: 'Chief Agronomist & Mission Lead', kcal_need: 2800, health: 100, daysWithoutFood: 0, alive: true, photo: '/crew/rowe.png' },
        { name: 'Cmdr. Jeff Bezos', role: 'Mission Commander', kcal_need: 2400, health: 100, daysWithoutFood: 0, alive: true, photo: '/crew/bezos.png' },
        { name: 'Dr. Jeff Goldblum', role: 'Flight Surgeon', kcal_need: 2600, health: 100, daysWithoutFood: 0, alive: true, photo: '/crew/goldblum.png' },
        { name: 'Dr. Jeff Bridges', role: 'Botanist', kcal_need: 2200, health: 100, daysWithoutFood: 0, alive: true, photo: '/crew/bridges.png' },
      ];
    }

    let totalKcalConsumed = 0;
    let totalProteinConsumed = 0;
    let stored = s.nutrition.food_stored_kcal || 0;
    let storedP = s.nutrition.food_stored_protein || 0;
    let rationUsed = false;

    // Daily activity events that modify calorie needs
    // Each crew member's need varies day-to-day based on activity
    const ACTIVITIES = [
      { name: 'EVA / Spacewalk', prob: 0.04, multiplier: 1.6, roles: null },          // anyone, +60% kcal
      { name: 'Heavy maintenance', prob: 0.08, multiplier: 1.35, roles: ['Engineer'] },// engineer, +35%
      { name: 'Greenhouse fieldwork', prob: 0.12, multiplier: 1.2, roles: ['Botanist'] },// botanist, +20%
      { name: 'Medical emergency drill', prob: 0.03, multiplier: 1.25, roles: ['Flight Surgeon'] },
      { name: 'Command briefing (low activity)', prob: 0.06, multiplier: 0.9, roles: ['Mission Commander'] },
      { name: 'Rest day', prob: 0.05, multiplier: 0.85, roles: null },                // anyone, -15%
    ];

    for (const member of s.crew.members) {
      if (!member.alive) continue;

      // Compute today's calorie need: base ± gaussian noise ± activity modifier
      // Box-Muller transform for gaussian: mean=1.0, stddev=0.08 (~±8% daily variation)
      const u1 = Math.random(), u2 = Math.random();
      const gaussian = Math.sqrt(-2 * Math.log(u1 || 0.001)) * Math.cos(2 * Math.PI * u2);
      let dailyMultiplier = 1.0 + gaussian * 0.08; // normal distribution around 1.0

      // Check for special activities
      member.activity = null;
      for (const act of ACTIVITIES) {
        if (Math.random() < act.prob) {
          if (!act.roles || act.roles.includes(member.role)) {
            dailyMultiplier *= act.multiplier;
            member.activity = act.name;
            break; // only one activity per day
          }
        }
      }

      dailyMultiplier = Math.max(0.75, Math.min(1.8, dailyMultiplier)); // clamp to reasonable range
      const todayNeed = Math.round(member.kcal_need * dailyMultiplier);
      member.todayKcalNeed = todayNeed;

      let fed = false;
      // Try to feed from stored food
      if (stored >= todayNeed * 0.5) {
        const kcalEaten = Math.min(todayNeed, stored);
        const proteinRatio = storedP > 0 ? storedP / stored : 0;
        const proteinEaten = kcalEaten * proteinRatio;
        stored -= kcalEaten;
        storedP -= proteinEaten;
        totalKcalConsumed += kcalEaten;
        totalProteinConsumed += proteinEaten;
        fed = kcalEaten >= todayNeed * 0.8;
      }

      // Fall back to emergency rations if not enough stored food
      if (!fed && s.nutrition.food_reserves_days > 0) {
        s.nutrition.food_reserves_days -= 0.25;
        totalKcalConsumed += todayNeed;
        totalProteinConsumed += 55;
        fed = true;
        rationUsed = true;
      }

      // Track hunger
      if (fed) {
        member.daysWithoutFood = 0;
        member.health = Math.min(100, member.health + 2); // slow recovery
      } else {
        member.daysWithoutFood++;
        // Health degrades: -5/day for first 3 days, then -10/day, then -20/day
        if (member.daysWithoutFood <= 3) member.health -= 5;
        else if (member.daysWithoutFood <= 7) member.health -= 10;
        else member.health -= 20;
        member.health = Math.max(0, member.health);

        if (member.health <= 0) {
          member.alive = false;
          s.alerts.push({ type: 'crew_death', sol: s.mission.currentSol, message: `${member.name} has died of starvation`, severity: 'critical' });
        } else if (member.daysWithoutFood === 1) {
          s.alerts.push({ type: 'hunger', sol: s.mission.currentSol, message: `${member.name} has no food — health declining`, severity: 'warning' });
        }
      }
    }

    if (rationUsed && s.nutrition.food_reserves_days <= 5) {
      s.alerts.push({ type: 'rations', sol: s.mission.currentSol, message: `Emergency rations at ${Math.round(s.nutrition.food_reserves_days)} days — need harvests`, severity: 'warning' });
    }

    s.nutrition.food_stored_kcal = Math.max(0, stored);
    s.nutrition.food_stored_protein = Math.max(0, storedP);
    s.nutrition.current_daily_kcal = Math.round(totalKcalConsumed);
    s.nutrition.current_daily_protein_g = Math.round(totalProteinConsumed);

    const aliveCrew = s.crew.members.filter(m => m.alive);
    const totalNeed = aliveCrew.reduce((sum, m) => sum + (m.todayKcalNeed || m.kcal_need), 0);
    s.nutrition.coverage_percent = totalNeed > 0 ? Math.round((totalKcalConsumed / totalNeed) * 100) : 0;
    s.mission.crew = aliveCrew.length;

    // Track daily calorie history for charts (last 30 sols)
    if (!s.nutrition.history) s.nutrition.history = [];
    s.nutrition.history.push({
      sol: s.mission.currentSol,
      consumed: Math.round(totalKcalConsumed),
      need: Math.round(totalNeed),
      stored: Math.round(s.nutrition.food_stored_kcal || 0),
    });
    if (s.nutrition.history.length > 30) s.nutrition.history = s.nutrition.history.slice(-30);

    // ── DNA Mutations (Mars cosmic radiation) ──
    if (!s.genetics) s.genetics = { mutations: [], totalRadiationEvents: 0 };
    const activeCropTypes = new Set();
    for (const mod of s.modules) {
      for (const crop of mod.crops) activeCropTypes.add(crop.type);
    }
    const hasDustStorm = s.events.some(e => e.id === 'dust_storm');
    const mutationProb = hasDustStorm ? 0.035 : 0.018;
    if (activeCropTypes.size > 0 && Math.random() < mutationProb) {
      const cropTypes = Array.from(activeCropTypes);
      const targetCrop = cropTypes[Math.floor(Math.random() * cropTypes.length)];
      const geneLength = 5428;
      const pos = Math.floor(Math.random() * (geneLength - 20)) + 11;
      const kind = Math.random() < 0.75 ? 'snv' : 'del';
      const bases = ['A', 'C', 'G', 'T'];
      const alt = kind === 'snv' ? bases[Math.floor(Math.random() * 4)] : null;
      s.genetics.mutations.push({
        id: `mut-${s.mission.currentSol}-${pos}`,
        sol: s.mission.currentSol,
        crop: targetCrop,
        gene: 'GBSS',
        kind, pos, alt,
        scored: false,
        delta_score: null,
        interpretation: 'pending',
        probabilities: null,
      });
      s.genetics.totalRadiationEvents++;
      s.alerts.push({
        type: 'dna_mutation', sol: s.mission.currentSol,
        message: `Radiation-induced DNA mutation detected in ${CROP_DB[targetCrop].name} GBSS gene at pos ${pos}`,
        severity: 'warning',
      });
    }
    if (s.genetics.mutations.length > 50) s.genetics.mutations = s.genetics.mutations.slice(-50);

    // ── Run Proactive Agent ──
    runSafetyOverrides(s);

    if (s.alerts.length > 20) s.alerts = s.alerts.slice(-20);
    if (s.eventLog.length > 30) s.eventLog = s.eventLog.slice(-30);
  }

  return s;
}

function plantCrop(state, moduleId, cropType, area_m2) {
  const s = JSON.parse(JSON.stringify(state));
  const mod = s.modules.find(m => m.id === moduleId);
  if (!mod) return s;
  if (mod.onlineSol && s.mission.currentSol < mod.onlineSol) return s;
  const usedArea = mod.crops.reduce((sum, c) => sum + c.area_m2, 0);
  const actualArea = Math.min(area_m2, mod.area_m2 - usedArea);
  if (actualArea > 0 && CROP_DB[cropType]) {
    mod.crops.push({
      type: cropType, area_m2: actualArea, daysGrown: 0,
      plantedSol: s.mission.currentSol, health: 100,
      accumulatedDamage: 0, replantCountdown: 0,
    });
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

// ── Persistence (server only — no localStorage) ─────────────────────
const STATE_API = 'https://lwx98cb4sg.execute-api.us-east-1.amazonaws.com/state';

function saveState(state) {
  const json = JSON.stringify(state);
  fetch(STATE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json }).catch(() => {});
}

async function loadState() {
  try {
    const res = await fetch(STATE_API);
    if (res.ok) {
      const data = await res.json();
      if (data?.mission) return data;
    }
  } catch {}
  return null;
}

function resetState() {
  const fresh = createInitialState();
  fetch(STATE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fresh) }).catch(() => {});
  return fresh;
}

export { CROP_DB, MARS, CREW, createInitialState, advanceSol, plantCrop, applyActions, cropStressFactor, saveState, loadState, resetState };
