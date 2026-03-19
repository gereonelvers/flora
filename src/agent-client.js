/**
 * FLORA Agent API client.
 * Sends messages to the Lambda-backed greenhouse agent (Claude on Bedrock + MCP).
 */

const API_URL = 'https://lwx98cb4sg.execute-api.us-east-1.amazonaws.com/agent';

export async function sendToAgent(messages, greenhouseState) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      greenhouse_state: greenhouseState,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Agent error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.response;
}

/**
 * Autonomous FLORA scan — runs periodically to manage the greenhouse.
 * Returns { response, autoActions, approvalActions, summary } or null.
 */
export async function runAutonomousScan(greenhouseState) {
  const s = greenhouseState;
  const members = s.crew?.members || [];
  const alive = members.filter(m => m.alive);
  const storedKcal = s.nutrition?.food_stored_kcal || 0;
  const daysOfFood = storedKcal > 0 ? Math.round(storedKcal / (s.nutrition?.daily_target_kcal || 10000)) : 0;
  const rations = Math.round(s.nutrition?.food_reserves_days || 0);

  // Build a detailed situation report for the agent
  const moduleReport = s.modules.map(m => {
    const used = m.crops.reduce((sum, c) => sum + c.area_m2, 0);
    const free = m.area_m2 - used;
    const online = !m.onlineSol || s.mission.currentSol >= m.onlineSol;
    const crops = m.crops.map(c => `${c.type}(${c.daysGrown}d/${c.area_m2}m²/health:${c.health}%)`).join(', ');
    return `${m.name}: ${online ? 'ONLINE' : 'OFFLINE'}, ${used}/${m.area_m2}m² used, free:${free}m², temp:${m.temp}°C, crops:[${crops || 'none'}]`;
  }).join('\n');

  const crewReport = alive.map(m =>
    `${m.name}: health ${m.health}%, ${m.daysWithoutFood > 0 ? `STARVING ${m.daysWithoutFood}d` : 'fed'}, needs ${m.kcal_need} kcal/day`
  ).join('\n');

  const events = (s.events || []).map(e => `${e.name}: ${e.desc} (${e.sol_end - s.mission.currentSol}d left)`).join('\n') || 'None';

  const prompt = `AUTONOMOUS SCAN — Sol ${s.mission.currentSol}/${s.mission.totalSols} (${s.mission.phase})

CREW (${alive.length}/${members.length} alive):
${crewReport}

NUTRITION:
- Food storage: ${Math.round(storedKcal)} kcal (${daysOfFood} days)
- Emergency rations: ${rations} days
- Coverage: ${s.nutrition?.coverage_percent || 0}%
- Total crew daily need: ~10,000 kcal

MODULES:
${moduleReport}

RESOURCES:
- Water: ${Math.round(s.resources?.water_liters || 0)}L (recycling: ${Math.round((s.resources?.water_recycling_efficiency || 0.92) * 100)}%)
- Energy: ${s.energy?.balance || 0} kWh/sol balance, ${Math.round(s.resources?.energy_stored_kwh || 0)} kWh battery
- Solar production: ${s.energy?.solar_production || 0} kWh/sol

ACTIVE EVENTS:
${events}

DNA MUTATIONS: ${(s.genetics?.mutations || []).length} total, ${(s.genetics?.mutations || []).filter(m => m.interpretation === 'disruptive').length} disruptive

HARVESTS TO DATE: ${(s.harvests || []).length} (total yield: ${Math.round((s.harvests || []).reduce((sum, h) => sum + h.yield_kg, 0))} kg)

YOUR PREVIOUS JOURNAL:
${(s.floraJournal || []).slice(-5).map(j => `[Sol ${j.sol}] ${j.entry}`).join('\n') || '(No previous entries — this is your first scan)'}

Analyze this state and take action. Remember:
- AUTO-EXECUTE routine actions (fill empty modules, adjust temps)
- Request APPROVAL only for genuine trade-offs
- Include a "journal" field in your JSON: a 1-3 sentence note about your reasoning, what you're watching for, and why you chose this next_check_sol. This is your memory between scans.
- Return the JSON action block with auto_actions, approval_actions, summary, next_check_sol, and journal`;

  // Fire-and-forget: Lambda may take 45-60s (past API Gateway 30s limit)
  // but it saves results directly to the state API, which the dashboard picks up via polling.
  // If the HTTP response comes back in time, we parse it. If it times out, results still arrive via state.
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        greenhouse_state: greenhouseState,
        autonomous: true,
      }),
      // No timeout — let the browser handle it (API GW may cut at 30s, that's OK)
    });

    if (res.ok) {
      const data = await res.json();
      return parseAutonomousResponse(data.response);
    }
    // API Gateway timeout (504) — Lambda is still running, results will come via state polling
    return { response: '', autoActions: [], approvalActions: [], summary: 'FLORA is analyzing... results will appear shortly.' };
  } catch {
    // Network timeout or error — Lambda may still be running in background
    return { response: '', autoActions: [], approvalActions: [], summary: 'FLORA is analyzing in the background...' };
  }
}

/**
 * Parse the autonomous response for auto and approval actions.
 */
function parseAutonomousResponse(responseText) {
  const result = {
    response: responseText,
    autoActions: [],
    approvalActions: [],
    summary: '',
    nextCheckSol: null,
  };

  const jsonBlocks = responseText.match(/```json\s*([\s\S]*?)```/g);
  if (jsonBlocks) {
    for (const block of jsonBlocks) {
      try {
        const jsonStr = block.replace(/```json\s*/, '').replace(/```/, '').trim();
        const parsed = JSON.parse(jsonStr);

        if (parsed.auto_actions) result.autoActions = parsed.auto_actions;
        if (parsed.approval_actions) result.approvalActions = parsed.approval_actions;
        if (parsed.summary) result.summary = parsed.summary;
        if (parsed.next_check_sol) result.nextCheckSol = parsed.next_check_sol;

        // Also support old format
        if (parsed.actions && !parsed.auto_actions) {
          result.autoActions = parsed.actions;
        }
      } catch { /* skip invalid blocks */ }
    }
  }

  return result;
}

/**
 * Parse action blocks from the agent's markdown response (legacy format).
 */
export function parseActions(responseText) {
  const jsonBlocks = responseText.match(/```json\s*([\s\S]*?)```/g);
  if (!jsonBlocks) return [];

  for (const block of jsonBlocks) {
    try {
      const jsonStr = block.replace(/```json\s*/, '').replace(/```/, '').trim();
      const parsed = JSON.parse(jsonStr);
      if (parsed.actions && Array.isArray(parsed.actions)) return parsed.actions;
      if (parsed.auto_actions) return parsed.auto_actions;
    } catch { /* skip invalid blocks */ }
  }
  return [];
}

// Keep old export for backward compat
export { runAutonomousScan as runProactiveAnalysis };
