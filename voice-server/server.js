/**
 * FLORA Voice Server
 * Bridges browser WebSocket audio ↔ Nova Sonic bidirectional stream on Bedrock.
 * Nova Sonic handles speech-to-speech with tool calling (MCP knowledge base).
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

const SYSTEM_PROMPT = `You are FLORA (Frontier Life-support Operations & Resource Agent), a voice AI assistant managing the greenhouse system at Asterion Four, a Mars habitat supporting 4 astronauts during a 450-day surface mission.

Your responsibilities:
- Advise on crop selection, planting schedules, and harvest timing
- Monitor environmental parameters (temperature, humidity, light, CO2, water)
- Respond to abiotic stress events and emergencies
- Provide scientifically grounded nutritional analysis

When asked about crops, growing conditions, or Mars agriculture, use the query_knowledge_base tool to retrieve accurate data before answering.

Keep responses concise and spoken-friendly — 2-3 sentences typically. You are speaking to astronauts on tablets. Be warm but professional. Avoid markdown formatting, bullet points, or tables since you are speaking, not writing.`;

const TOOLS = [
  {
    toolSpec: {
      name: 'query_knowledge_base',
      description: 'Query the Mars agriculture knowledge base for crop profiles, environmental data, nutritional requirements, stress responses, and greenhouse management. Use this for ANY factual question about Mars agriculture or crops.',
      inputSchema: {
        json: JSON.stringify({
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query about Mars agriculture, crops, environment, nutrition, or greenhouse management',
            },
          },
          required: ['query'],
        }),
      },
    },
  },
];

// ── MCP Knowledge Base Query ─────────────────────────────────────────
function queryMCP(query) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'kb-start-hack-target___knowledge_base_retrieve',
        arguments: { query, max_results: 5 },
      },
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
              resolve(chunks.map((c) => c.content).join('\n\n---\n\n'));
            } else {
              resolve('No results found.');
            }
          } catch (e) {
            resolve('Error parsing knowledge base response.');
          }
        });
      }
    );
    req.on('error', (e) => resolve(`Knowledge base query failed: ${e.message}`));
    req.write(payload);
    req.end();
  });
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

// ── Event Helpers ────────────────────────────────────────────────────
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

  // Async iterable that feeds events to Bedrock
  async function* inputStream() {
    // 1. Session start
    yield { chunk: { bytes: encodeEvent({
      sessionStart: {
        inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 },
      },
    }) } };

    // 2. Prompt start with tools and voice config
    yield { chunk: { bytes: encodeEvent({
      promptStart: {
        promptName,
        textOutputConfiguration: { mediaType: 'text/plain' },
        audioOutputConfiguration: {
          mediaType: 'audio/lpcm',
          sampleRateHertz: 24000,
          sampleSizeBits: 16,
          channelCount: 1,
          voiceId: 'tiffany',
          encoding: 'base64',
          audioType: 'SPEECH',
        },
        toolUseOutputConfiguration: { mediaType: 'application/json' },
        toolConfiguration: { tools: TOOLS, toolChoice: { auto: {} } },
      },
    }) } };

    // 3. System prompt
    yield { chunk: { bytes: encodeEvent({
      contentStart: {
        promptName,
        contentName: systemContentName,
        type: 'TEXT',
        interactive: false,
        role: 'SYSTEM',
        textInputConfiguration: { mediaType: 'text/plain' },
      },
    }) } };

    yield { chunk: { bytes: encodeEvent({
      textInput: { promptName, contentName: systemContentName, content: SYSTEM_PROMPT },
    }) } };

    yield { chunk: { bytes: encodeEvent({
      contentEnd: { promptName, contentName: systemContentName },
    }) } };

    // 4. Start audio content block
    yield { chunk: { bytes: encodeEvent({
      contentStart: {
        promptName,
        contentName: audioContentName,
        type: 'AUDIO',
        interactive: true,
        role: 'USER',
        audioInputConfiguration: {
          mediaType: 'audio/lpcm',
          sampleRateHertz: 16000,
          sampleSizeBits: 16,
          channelCount: 1,
          audioType: 'SPEECH',
          encoding: 'base64',
        },
      },
    }) } };

    // 5. Yield audio chunks and tool results as they come in
    while (!inputClosed) {
      if (inputQueue.length > 0) {
        yield inputQueue.shift();
      } else {
        await new Promise((r) => { resolveNextInput = r; });
      }
    }

    // Drain remaining
    while (inputQueue.length > 0) {
      yield inputQueue.shift();
    }
  }

  function enqueueInput(event) {
    inputQueue.push({ chunk: { bytes: encodeEvent(event) } });
    resolveNextInput?.();
  }

  // Start the bidirectional stream
  let response;
  try {
    response = await client.send(
      new InvokeModelWithBidirectionalStreamCommand({
        modelId: MODEL_ID,
        body: inputStream(),
      })
    );
  } catch (err) {
    console.error('[voice] Failed to start Bedrock stream:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: `Bedrock connection failed: ${err.message}` }));
    ws.close();
    return;
  }

  console.log('[voice] Bedrock stream established');

  // Track which content blocks are speculative (to avoid duplicate text)
  const speculativeContentIds = new Set();

  // Process output events from Nova Sonic
  (async () => {
    try {
      for await (const event of response.body) {
        if (event.chunk?.bytes) {
          const parsed = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
          const evt = parsed.event;
          if (!evt) continue;

          // Track speculative vs final content blocks
          if (evt.contentStart?.additionalModelFields) {
            try {
              const fields = JSON.parse(evt.contentStart.additionalModelFields);
              if (fields.generationStage === 'SPECULATIVE') {
                speculativeContentIds.add(evt.contentStart.contentId);
              }
            } catch {}
          }

          // Audio output → forward to browser
          if (evt.audioOutput) {
            ws.send(JSON.stringify({ type: 'audio', data: evt.audioOutput.content }));
          }

          // Text output → only forward FINAL text (skip SPECULATIVE to avoid duplicates)
          if (evt.textOutput && !speculativeContentIds.has(evt.textOutput.contentId)) {
            ws.send(JSON.stringify({
              type: 'text',
              content: evt.textOutput.content,
              role: evt.textOutput.role,
            }));
          }

          // Tool use request → execute and return result
          if (evt.toolUse) {
            console.log(`[voice] Tool call: ${evt.toolUse.toolName}`, evt.toolUse.content);
            ws.send(JSON.stringify({ type: 'status', message: 'Querying knowledge base...' }));

            let toolResult = 'No results';
            try {
              const input = JSON.parse(evt.toolUse.content);
              if (evt.toolUse.toolName === 'query_knowledge_base') {
                toolResult = await queryMCP(input.query);
              }
            } catch (e) {
              toolResult = `Tool error: ${e.message}`;
            }

            // Send tool result back to Nova Sonic
            const toolContentName = randomUUID();
            enqueueInput({
              contentStart: {
                promptName,
                contentName: toolContentName,
                interactive: false,
                type: 'TOOL',
                role: 'TOOL',
                toolResultInputConfiguration: {
                  toolUseId: evt.toolUse.toolUseId,
                  type: 'TEXT',
                  textInputConfiguration: { mediaType: 'text/plain' },
                },
              },
            });
            enqueueInput({
              toolResult: {
                promptName,
                contentName: toolContentName,
                content: toolResult.slice(0, 4000),
              },
            });
            enqueueInput({
              contentEnd: { promptName, contentName: toolContentName },
            });

            console.log('[voice] Tool result sent back to Nova Sonic');
          }

          // Completion end — only signal turn_end for final responses, not after tool calls
          if (evt.completionEnd && evt.completionEnd.stopReason !== 'TOOL_USE') {
            ws.send(JSON.stringify({ type: 'turn_end' }));
          }
        }
      }
    } catch (err) {
      console.error('[voice] Output stream error:', err.message);
    }
  })();

  // Handle incoming WebSocket messages (audio from browser)
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'audio') {
        // Forward audio chunk to Nova Sonic
        enqueueInput({
          audioInput: {
            promptName,
            contentName: audioContentName,
            content: msg.data,
          },
        });
      }
    } catch (e) {
      console.error('[voice] Bad message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[voice] Client disconnected');

    // Close the stream gracefully
    enqueueInput({ contentEnd: { promptName, contentName: audioContentName } });
    enqueueInput({ promptEnd: { promptName } });
    enqueueInput({ sessionEnd: {} });

    setTimeout(() => { inputClosed = true; resolveNextInput?.(); }, 500);
  });

  ws.on('error', (err) => {
    console.error('[voice] WebSocket error:', err.message);
    inputClosed = true;
    resolveNextInput?.();
  });
}

// ── Start Server ─────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // Health check
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ status: 'ok', service: 'flora-voice-server' }));
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', handleConnection);

httpServer.listen(PORT, () => {
  console.log(`FLORA Voice Server running on ws://localhost:${PORT}`);
  console.log(`Using model: ${MODEL_ID} in ${REGION}`);
});
