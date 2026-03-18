/**
 * ARIA Agent API client.
 * Sends messages to the Lambda-backed greenhouse agent.
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
