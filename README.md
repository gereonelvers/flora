# FLORA — Frontier Life-support Operations & Resource Agent

Autonomous AI-driven Mars greenhouse management system for a 450-sol surface mission supporting 4 astronauts. Built at START Hack 2026.

## System Architecture

```
                                    FLORA System Architecture
                                    ========================

    ┌──────────────────────────────────── USER INTERFACES ─────────────────────────────────────┐
    │                                                                                          │
    │   index.html                   dashboard.html                  Voice (Microphone)        │
    │   ┌────────────────────┐       ┌────────────────────┐          ┌────────────────────┐    │
    │   │  3D Mars Base      │       │  Crew Dashboard    │          │  Voice Assistant   │    │
    │   │  ─────────────     │       │  ──────────────    │          │  ───────────────   │    │
    │   │  Three.js scene    │       │  Mission metrics   │          │  Browser mic input │    │
    │   │  Day/night cycle   │       │  Module controls   │          │  16kHz PCM audio   │    │
    │   │  Orbital camera    │       │  Genetics viewer   │          │  24kHz PCM output  │    │
    │   │  Particle effects  │       │  Harvest logs      │          │  Barge-in support  │    │
    │   │  Sol progression   │       │  Real-time charts  │          │  FLORA orb avatar  │    │
    │   │  Sim speed control │       │  FLORA chat panel  │          │                    │    │
    │   └────────┬───────────┘       └─────────┬──────────┘          └─────────┬──────────┘    │
    └────────────┼─────────────────────────────┼──────────────────────────────┼────────────────┘
                 │                             │                              │
                 │  HTTP (fetch)               │  HTTP (fetch)                │  WebSocket
                 │                             │                              │
    ═════════════╪═════════════════════════════╪══════════════════════════════╪════════════════
                 │              A W S    C L O U D                           │
                 │                             │                              │
                 ▼                             ▼                              ▼
    ┌─────────────────────────────────────────────────┐          ┌─────────────────────────┐
    │              API Gateway (us-east-1)            │          │  CloudFront (CDN)       │
    │  ┌──────────────┐  ┌────────────────────────┐   │          │  WSS termination        │
    │  │ POST /agent  │  │ GET/POST /state        │   │          │  ┌───────────────────┐  │
    │  │ Agent queries │  │ Greenhouse state sync  │   │          │  │ Voice WebSocket   │  │
    │  └──────┬───────┘  └───────────┬────────────┘   │          │  │ endpoint          │  │
    │         │                      │                │          │  └─────────┬─────────┘  │
    └─────────┼──────────────────────┼────────────────┘          └───────────┼─────────────┘
              │                      │                                       │
              ▼                      ▼                                       ▼
    ┌──────────────────┐   ┌──────────────────┐                ┌──────────────────────────┐
    │  Lambda          │   │  State Storage   │                │  Voice Server            │
    │  Agent Handler   │   │  (DynamoDB/S3)   │                │  (ECS / Docker)          │
    │  ────────────    │   │  ────────────    │                │  ──────────────          │
    │  Python runtime  │   │  Shared state    │                │  Node.js + WS            │
    │  Claude Bedrock  │   │  Cross-device    │◄──── sync ────►│  Bidirectional stream    │
    │  Action parsing  │   │  persistence     │                │  Audio encode/decode     │
    │  State mutation  │   │                  │                │  Tool call execution     │
    └────────┬─────────┘   └──────────────────┘                └────────────┬─────────────┘
             │                                                              │
             │  converse() API                              InvokeModel w/  │
             │  (tool_use loops, max 6)                  BidirectionalStream│
             │                                                              │
             ▼                                                              ▼
    ┌────────────────────────────────────────────────────────────────────────────────────────┐
    │                            AWS Bedrock                                                 │
    │                                                                                        │
    │   ┌─────────────────────────────┐       ┌──────────────────────────────────────────┐   │
    │   │  Claude Sonnet 4.6          │       │  Amazon Nova Sonic v1                    │   │
    │   │  (us.anthropic.claude-      │       │  (amazon.nova-sonic-v1:0)                │   │
    │   │   sonnet-4-6)               │       │                                          │   │
    │   │  ─────────────────          │       │  ──────────────────────                  │   │
    │   │  Autonomous greenhouse      │       │  Speech-to-text recognition              │   │
    │   │  decision engine            │       │  Text-to-speech synthesis                │   │
    │   │  JSON action classification │       │  Speculative decoding                    │   │
    │   │  (AUTO vs APPROVAL)         │       │  Real-time tool use during speech        │   │
    │   └──────────┬──────────────────┘       └──────────────────┬───────────────────────┘   │
    │              │                                             │                           │
    │              │          ┌──────────────────────────┐       │                           │
    │              └─────────►│  MCP Gateway             │◄──────┘                           │
    │                         │  (Bedrock AgentCore,     │                                   │
    │                         │   us-east-2)             │                                   │
    │                         │  ────────────────        │                                   │
    │                         │  Syngenta knowledge base │                                   │
    │                         │  Mars crop profiles      │                                   │
    │                         │  Nutritional strategies  │                                   │
    │                         │  Abiotic stress data     │                                   │
    │                         └──────────────────────────┘                                   │
    └────────────────────────────────────────────────────────────────────────────────────────┘

    ┌────────────────────────────────────────────────────────────────────────────────────────┐
    │                         Mutation Scoring Pipeline                                      │
    │                                                                                        │
    │   ┌──────────────────┐        ┌──────────────────┐        ┌────────────────────────┐  │
    │   │  API Gateway     │        │  Lambda           │        │  NVIDIA NIM API        │  │
    │   │  POST /score     │───────►│  Evo 2 Wrapper    │───────►│  (health.api.nvidia)   │  │
    │   │  (us-east-1)     │        │  ──────────────   │        │  ──────────────────    │  │
    │   │                  │        │  Window extraction│        │  Evo 2 7B model        │  │
    │   │                  │◄───────│  Delta scoring    │◄───────│  Sequence scoring      │  │
    │   │                  │        │  Interpretation   │        │  Per-base log-probs    │  │
    │   └──────────────────┘        └──────────────────┘        └────────────────────────┘  │
    │                                                                                        │
    │   Alt deployment: EC2 g6e.xlarge (GPU) running FastAPI + local Evo 2 model             │
    └────────────────────────────────────────────────────────────────────────────────────────┘

    ┌────────────────────────────────────────────────────────────────────────────────────────┐
    │                         CI/CD & Container Infrastructure                               │
    │                                                                                        │
    │   ┌──────────────────┐        ┌──────────────────┐        ┌────────────────────────┐  │
    │   │  AWS CodeBuild   │───────►│  Docker Image     │───────►│  Amazon ECR            │  │
    │   │  (buildspec.yml) │        │  (voice-server)   │        │  flora-voice-server    │  │
    │   └──────────────────┘        └──────────────────┘        └────────────────────────┘  │
    └────────────────────────────────────────────────────────────────────────────────────────┘
```

## AWS Services Summary

| Service | Purpose |
|---|---|
| **API Gateway** | REST endpoints for agent queries (`/agent`), state sync (`/state`), and mutation scoring (`/score`) |
| **Lambda** | Agent handler (Claude Bedrock + MCP tool calls) and Evo 2 mutation scoring wrapper |
| **Bedrock** | Claude Sonnet 4.6 for autonomous decision-making; Nova Sonic v1 for multimodal voice |
| **Bedrock AgentCore** | MCP Gateway serving Syngenta agricultural knowledge base (us-east-2) |
| **CloudFront** | CDN + WebSocket termination for the voice server |
| **DynamoDB / S3** | Greenhouse state persistence and cross-device sync |
| **ECR** | Docker image registry for the voice server container |
| **CodeBuild** | CI/CD pipeline for building and pushing the voice server Docker image |
| **EC2** | Optional GPU instance (g6e.xlarge) for running Evo 2 locally |

## External Services

| Service | Purpose |
|---|---|
| **NVIDIA NIM** | Evo 2 7B genomic foundation model for DNA mutation impact scoring on potato GBSS gene |

## Project Structure

```
start-hack-2026/
├── src/                          # Frontend (Vite + vanilla JS)
│   ├── main.js                   # Entry point, Three.js renderer, mission clock
│   ├── scene.js                  # 3D Mars base (terrain, greenhouses, lighting, particles)
│   ├── greenhouse.js             # Core simulation engine (crops, stress, events, resources)
│   ├── dashboard.js              # Crew dashboard (metrics, modules, genetics, chat, voice)
│   ├── agent-client.js           # Agent API client + autonomous scan logic
│   ├── dna.js                    # Evo 2 mutation scoring client + potato GBSS reference
│   ├── noise.js                  # Procedural terrain generation
│   └── style.css
├── agent/                        # Backend — Agent Lambda
│   └── lambda_function.py        # Claude Bedrock converse + MCP tool use + state mutation
├── voice-server/                 # Backend — Voice streaming
│   ├── server.js                 # WebSocket server → Nova Sonic bidirectional stream
│   ├── Dockerfile
│   └── buildspec.yml             # CodeBuild config
├── evo2-potato/                  # Backend — DNA mutation scoring
│   ├── lambda_function.py        # Lambda wrapper → NVIDIA NIM Evo 2 API
│   ├── server.py                 # FastAPI server (local/EC2 GPU deployment)
│   ├── deploy.sh                 # EC2 GPU instance launcher
│   ├── ec2-setup.sh              # Instance setup script
│   └── potato_gbss.fasta         # Reference GBSS gene (X83220.1, 5428 bp)
├── docs/                         # Knowledge base source documents
├── public/                       # Static assets (crew photos, icons)
├── index.html                    # 3D experience entry point
├── dashboard.html                # Crew dashboard entry point
└── vite.config.js                # Dual-entry build config
```

## Key Data Flows

### Autonomous Scan (every ~10 sols)
1. Dashboard builds situation report (crew health, modules, resources, events, genetics)
2. POST to `/agent` with `autonomous: true` and full greenhouse state
3. Lambda fetches fresh state, calls Claude Sonnet 4.6 via Bedrock `converse()`
4. Claude may invoke MCP knowledge base tool (up to 6 tool-use loops)
5. Claude returns JSON with `auto_actions` (applied immediately) and `approval_actions` (shown to crew)
6. Lambda applies auto actions to state, saves via `/state` API
7. Dashboard polls `/state` and picks up changes + journal entries

### Voice Interaction
1. Browser captures mic audio → 16kHz PCM → base64 → WebSocket
2. Voice server forwards audio events to Bedrock Nova Sonic bidirectional stream
3. Nova Sonic performs speech recognition, generates response, may call knowledge base tool
4. Server forwards audio output (24kHz PCM) and text transcripts back to browser
5. Browser decodes and plays audio via AudioContext, renders text in chat

### DNA Mutation Scoring
1. Simulation generates radiation-induced mutations at random positions in potato GBSS gene
2. Client sends mutation (kind, position, alt base) to `/score` API
3. Lambda extracts context window from reference sequence, applies mutation
4. Sends both reference and mutant windows to NVIDIA NIM Evo 2 7B for scoring
5. Returns delta score and interpretation (disruptive / suspicious / neutral)
6. Dashboard displays results in genetics tab; disruptive mutations reduce crop health by 8%

## Simulation Model

- **Crops**: Potato, Lettuce, Bean, Radish, Spinach, Herb — each with unique growth cycles, yields, and stress tolerances
- **Modules**: 3 greenhouse modules (30 m² each) with independent environmental controls
- **Stress factors**: Temperature, light, humidity, CO2 — with exponential damage curves and accumulated permanent degradation
- **Random events**: Dust storms, HVAC failures, water recycler faults, CO2 scrubber issues, LED panel failures
- **Resources**: Water (5000L initial, 92% recycling), energy (200 kWh solar, 800 kWh battery), food reserves (60-day emergency rations)
- **Crew**: 4 astronauts with individual health, caloric needs (2500 kcal/day each), and morale tracking

## Running Locally

```bash
npm install
npm run dev          # Starts Vite dev server (3D view + dashboard)
```

Voice server (requires AWS credentials with Bedrock access):
```bash
cd voice-server
npm install
node server.js       # WebSocket on port 8765
```
