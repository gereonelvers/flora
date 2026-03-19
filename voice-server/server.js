/**
 * FLORA Voice Server
 * Bridges browser WebSocket audio ↔ Nova Sonic bidirectional stream on Bedrock.
 * Knowledge base is pre-loaded into system prompt AND available via tool calling.
 */

import { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 8765;
const REGION = process.env.AWS_DEFAULT_REGION || 'us-east-1';
const MODEL_ID = 'amazon.nova-sonic-v1:0';
const MCP_URL = 'https://kb-start-hack-gateway-buyjtibfpg.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp';

// ── MCP Knowledge Base ───────────────────────────────────────────────
let knowledgeCache = '';

function queryMCP(query, maxResults = 10) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'kb-start-hack-target___knowledge_base_retrieve', arguments: { query, max_results: maxResults } },
    });
    const url = new URL(MCP_URL);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            const content = result?.result?.content;
            if (content?.[0]?.text) {
              const parsed = JSON.parse(content[0].text);
              const body = typeof parsed.body === 'string' ? JSON.parse(parsed.body) : parsed.body;
              const chunks = body?.retrieved_chunks || [];
              resolve(chunks.map((c) => c.content).join('\n\n'));
            } else resolve('No results found.');
          } catch { resolve('Error parsing response.'); }
        });
      }
    );
    req.on('error', () => resolve('Knowledge base unavailable.'));
    req.write(payload);
    req.end();
  });
}

async function loadKnowledgeBase() {
  console.log('[voice] Pre-loading knowledge base...');
  const queries = [
    'Mars greenhouse crop profiles lettuce potato radish bean spinach herbs growth cycle yield nutritional contribution',
    'Mars environmental conditions temperature humidity light CO2 water soil regolith hydroponic requirements',
    'Nutritional requirements for 4 astronauts caloric protein vitamin mineral dietary balance 450-day mission',
    'Abiotic stress responses drought heat cold light deficiency salinity crop sensitivity',
    'Water recycling resource management energy budget greenhouse operations Mars',
  ];
  const results = await Promise.all(queries.map((q) => queryMCP(q)));
  knowledgeCache = results.filter(Boolean).join('\n\n---\n\n');
  console.log(`[voice] Knowledge base loaded: ${knowledgeCache.length} chars`);
}

const TOOLS = [{
  toolSpec: {
    name: 'query_knowledge_base',
    description: 'Query the Mars agriculture knowledge base for specific crop data, environmental parameters, nutritional info, or greenhouse management details not covered in your pre-loaded context.',
    inputSchema: {
      json: JSON.stringify({
        type: 'object',
        properties: { query: { type: 'string', description: 'Specific search query' } },
        required: ['query'],
      }),
    },
  },
}];

function getSystemPrompt() {
  return `You are FLORA (Frontier Life-support Operations & Resource Agent), a voice AI assistant managing the greenhouse system at Asterion Four, a Mars habitat supporting 4 astronauts during a 450-day surface mission.

Your responsibilities: crop selection and scheduling, environmental monitoring, abiotic stress response, nutritional analysis.

Keep responses concise and spoken-friendly — 2-3 sentences typically. You are speaking to astronauts on tablets. Be warm but professional. No markdown, no bullet points, no tables — you are speaking.

You have a query_knowledge_base tool for specific lookups. You also have reference data below for quick answers. Use whichever is most appropriate.

REFERENCE DATA:
${knowledgeCache}`;
}

// ── Bedrock Client ───────────────────────────────────────────────────
function createBedrockClient() {
  return new BedrockRuntimeClient({
    region: REGION,
    requestHandler: new NodeHttp2Handler({
      requestTimeout: 300000,
      sessionTimeout: 300000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
    }),
  });
}

function encodeEvent(event) {
  return new TextEncoder().encode(JSON.stringify({ event }));
}

// ── Handle a WebSocket connection ────────────────────────────────────
async function handleConnection(ws) {
  console.log('[voice] Client connected');

  const promptName = randomUUID();
  const systemContentName = randomUUID();
  const audioContentName = randomUUID();
  const client = createBedrockClient();

  let inputClosed = false;
  let resolveNextInput;
  const inputQueue = [];

  async function* inputStream() {
    yield { chunk: { bytes: encodeEvent({
      sessionStart: { inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 } },
    }) } };

    yield { chunk: { bytes: encodeEvent({
      promptStart: {
        promptName,
        textOutputConfiguration: { mediaType: 'text/plain' },
        audioOutputConfiguration: {
          mediaType: 'audio/lpcm', sampleRateHertz: 24000, sampleSizeBits: 16,
          channelCount: 1, voiceId: 'tiffany', encoding: 'base64', audioType: 'SPEECH',
        },
        toolUseOutputConfiguration: { mediaType: 'application/json' },
        toolConfiguration: { tools: TOOLS, toolChoice: { auto: {} } },
      },
    }) } };

    // System prompt with pre-loaded knowledge
    yield { chunk: { bytes: encodeEvent({
      contentStart: { promptName, contentName: systemContentName, type: 'TEXT', interactive: false, role: 'SYSTEM', textInputConfiguration: { mediaType: 'text/plain' } },
    }) } };
    yield { chunk: { bytes: encodeEvent({
      textInput: { promptName, contentName: systemContentName, content: getSystemPrompt() },
    }) } };
    yield { chunk: { bytes: encodeEvent({
      contentEnd: { promptName, contentName: systemContentName },
    }) } };

    // Audio input stream
    yield { chunk: { bytes: encodeEvent({
      contentStart: {
        promptName, contentName: audioContentName, type: 'AUDIO', interactive: true, role: 'USER',
        audioInputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: 'SPEECH', encoding: 'base64' },
      },
    }) } };

    while (!inputClosed) {
      if (inputQueue.length > 0) {
        yield inputQueue.shift();
      } else {
        await new Promise((r) => { resolveNextInput = r; });
      }
    }
    while (inputQueue.length > 0) yield inputQueue.shift();
  }

  function enqueueInput(event) {
    inputQueue.push({ chunk: { bytes: encodeEvent(event) } });
    resolveNextInput?.();
  }

  let response;
  try {
    response = await client.send(
      new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: inputStream() })
    );
  } catch (err) {
    console.error('[voice] Bedrock stream failed:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: `Bedrock error: ${err.message}` }));
    ws.close();
    return;
  }

  console.log('[voice] Bedrock stream established');

  const speculativeContentIds = new Set();
  let pendingTool = null;

  (async () => {
    try {
      for await (const event of response.body) {
        if (!event.chunk?.bytes) continue;
        const parsed = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
        const evt = parsed.event;
        if (!evt) continue;

        // Track speculative content
        if (evt.contentStart?.additionalModelFields) {
          try {
            if (JSON.parse(evt.contentStart.additionalModelFields).generationStage === 'SPECULATIVE')
              speculativeContentIds.add(evt.contentStart.contentId);
          } catch {}
        }

        // Audio → browser
        if (evt.audioOutput) {
          ws.send(JSON.stringify({ type: 'audio', data: evt.audioOutput.content }));
        }

        // Text → browser (FINAL only, skip interrupted markers)
        if (evt.textOutput && !speculativeContentIds.has(evt.textOutput.contentId)) {
          // Barge-in: Nova Sonic sends interrupted marker when user interrupts
          let isInterrupted = false;
          try {
            const parsed = JSON.parse(evt.textOutput.content);
            if (parsed.interrupted) isInterrupted = true;
          } catch {}
          if (isInterrupted || evt.textOutput.content?.includes('"interrupted"')) {
            console.log('[voice] Barge-in detected, clearing audio');
            ws.send(JSON.stringify({ type: 'interrupted' }));
          } else {
            ws.send(JSON.stringify({ type: 'text', content: evt.textOutput.content, role: evt.textOutput.role }));
          }
        }

        // Also detect interrupted via contentEnd
        if (evt.contentEnd?.stopReason === 'INTERRUPTED') {
          console.log('[voice] Content interrupted');
          ws.send(JSON.stringify({ type: 'interrupted' }));
        }

        // Tool call — store info when toolUse arrives, but DON'T execute yet
        if (evt.toolUse) {
          pendingTool = {
            toolName: evt.toolUse.toolName,
            toolUseId: evt.toolUse.toolUseId,
            content: evt.toolUse.content,
          };
          console.log(`[voice] Tool requested: ${pendingTool.toolName} id=${pendingTool.toolUseId}`);
          ws.send(JSON.stringify({ type: 'status', message: 'Querying knowledge base...' }));
        }

        // Tool execution — wait for contentEnd with type=TOOL (Nova Sonic finished sending request)
        if (evt.contentEnd?.type === 'TOOL' && pendingTool) {
          console.log(`[voice] Tool contentEnd received, executing ${pendingTool.toolName}`);
          const { toolName, toolUseId, content: toolInput } = pendingTool;
          pendingTool = null;

          let toolResult = 'No additional results.';
          try {
            const input = JSON.parse(toolInput);
            if (toolName === 'query_knowledge_base') {
              toolResult = await queryMCP(input.query, 3);
            }
          } catch (e) {
            toolResult = `Error: ${e.message}`;
          }
          // Nova Sonic has a limit on tool result size — truncate aggressively
          if (toolResult.length > 2000) {
            toolResult = toolResult.slice(0, 2000) + '\n[truncated]';
          }
          console.log(`[voice] Tool result: ${toolResult.length} chars, sending back`);

          const toolContentName = randomUUID();

          // Build exact events matching AWS Python sample
          const toolStartEvent = {
            contentStart: {
              promptName,
              contentName: toolContentName,
              interactive: false,
              type: 'TOOL',
              role: 'TOOL',
              toolResultInputConfiguration: {
                toolUseId,
                type: 'TEXT',
                textInputConfiguration: { mediaType: 'text/plain' },
              },
            },
          };

          // Strip markdown formatting (not useful for speech) and wrap as JSON — Nova Sonic needs valid JSON, not raw markdown
          const cleanResult = toolResult
            .replace(/#{1,6}\s/g, '')      // markdown headers
            .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1') // bold/italic (keep inner text)
            .replace(/---+/g, '')          // horizontal rules
            .replace(/\|/g, ', ')          // table pipes
            .replace(/\n{3,}/g, '\n\n')    // collapse newlines
            .trim();
          const toolResultContent = JSON.stringify({ answer: cleanResult });
          const toolResultEvent = {
            toolResult: {
              promptName,
              contentName: toolContentName,
              content: toolResultContent,
            },
          };

          const toolEndEvent = {
            contentEnd: {
              promptName,
              contentName: toolContentName,
            },
          };

          console.log(`[voice] Sending tool result events:`);
          console.log(`[voice]   contentStart: ${JSON.stringify(toolStartEvent).substring(0, 200)}`);
          console.log(`[voice]   toolResult content (${toolResultContent.length} chars): ${toolResultContent.substring(0, 150)}...`);
          console.log(`[voice]   contentEnd: ${JSON.stringify(toolEndEvent)}`);

          enqueueInput(toolStartEvent);
          enqueueInput(toolResultEvent);
          enqueueInput(toolEndEvent);
        }

        // Turn complete
        if (evt.completionEnd) {
          console.log(`[voice] completionEnd stopReason=${evt.completionEnd.stopReason}`);
          // Always send turn_end — the dashboard has a safety timeout anyway
          ws.send(JSON.stringify({ type: 'turn_end' }));
        }
      }
    } catch (err) {
      console.error('[voice] Output stream error:', err.message);
    }
  })();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'audio') {
        enqueueInput({ audioInput: { promptName, contentName: audioContentName, content: msg.data } });
      }
    } catch {}
  });

  ws.on('close', () => {
    console.log('[voice] Client disconnected');
    enqueueInput({ contentEnd: { promptName, contentName: audioContentName } });
    enqueueInput({ promptEnd: { promptName } });
    enqueueInput({ sessionEnd: {} });
    setTimeout(() => { inputClosed = true; resolveNextInput?.(); }, 500);
  });

  ws.on('error', () => { inputClosed = true; resolveNextInput?.(); });
}

// ── Start Server ─────────────────────────────────────────────────────
const httpServer = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ status: 'ok', service: 'flora-voice-server' }));
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', handleConnection);

loadKnowledgeBase().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`FLORA Voice Server running on ws://localhost:${PORT}`);
  });
});
