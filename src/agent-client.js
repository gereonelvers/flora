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
 * Proactive agent analysis — called autonomously after sol advances
 * when conditions warrant AI review (events, low nutrition, etc.)
 */
export async function runProactiveAnalysis(greenhouseState) {
  const s = greenhouseState;
  const issues = [];

  // Determine what the agent should focus on
  if ((s.events || []).length > 0)
    issues.push(`Active events: ${s.events.map(e => e.name + ' (' + e.desc + ')').join('; ')}`);
  if (s.nutrition.coverage_percent < 60)
    issues.push(`Nutrition critically low at ${s.nutrition.coverage_percent}%`);
  if ((s.energy?.balance || 0) < -20)
    issues.push(`Energy deficit of ${s.energy.balance} kWh/sol`);
  if (s.resources.water_liters < 2000)
    issues.push(`Water reserves low at ${Math.round(s.resources.water_liters)}L`);
  if ((s.mission.morale || 80) < 60)
    issues.push(`Crew morale at ${s.mission.morale}%`);

  // Check crop health
  for (const mod of s.modules) {
    for (const crop of mod.crops) {
      if ((crop.health || 100) < 50)
        issues.push(`${mod.name}: ${crop.type} health at ${crop.health}%`);
    }
  }

  // Only call the agent if there's something worth analyzing
  if (issues.length === 0) return null;

  const prompt = `You are running a proactive monitoring cycle on Sol ${s.mission.currentSol}.

CURRENT ISSUES DETECTED:
${issues.map(i => '- ' + i).join('\n')}

Analyze the greenhouse state and:
1. Identify the most critical issue and explain WHY it matters
2. Take immediate corrective actions (provide executable JSON action blocks)
3. Explain your reasoning using data from the knowledge base if relevant

Be concise — this is an autonomous check, not a conversation. Focus on actionable recommendations.`;

  try {
    return await sendToAgent(
      [{ role: 'user', content: prompt }],
      greenhouseState
    );
  } catch {
    return null;
  }
}

/**
 * Parse action blocks from the agent's markdown response.
 * Looks for ```json blocks containing {"actions": [...]}
 */
export function parseActions(responseText) {
  const jsonBlocks = responseText.match(/```json\s*([\s\S]*?)```/g);
  if (!jsonBlocks) return [];

  for (const block of jsonBlocks) {
    try {
      const jsonStr = block.replace(/```json\s*/, '').replace(/```/, '').trim();
      const parsed = JSON.parse(jsonStr);
      if (parsed.actions && Array.isArray(parsed.actions)) {
        return parsed.actions;
      }
    } catch { /* skip invalid blocks */ }
  }
  return [];
}
