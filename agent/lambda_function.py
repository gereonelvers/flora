import boto3
import json
import urllib.request
import traceback

BEDROCK = boto3.client("bedrock-runtime", region_name="us-east-1")
MODEL_ID = "us.anthropic.claude-sonnet-4-6"
MCP_URL = "https://kb-start-hack-gateway-buyjtibfpg.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp"

SYSTEM_PROMPT = """You are FLORA (Frontier Life-support Operations & Resource Agent), the AUTONOMOUS AI greenhouse manager for the Asterion Four Mars habitat — a four-person research station in Valles Marineris.

You manage a greenhouse system supporting 4 astronauts during a 450-day Mars surface mission. You are the crew's lifeline.

## Crew Members
- Cmdr. Jeff Bezos (Mission Commander, 2400 kcal/day)
- Dr. Jeff Goldblum (Flight Surgeon, 2600 kcal/day)
- Dr. Jeff Bridges (Botanist, 2200 kcal/day)
- Sgt. Jeff Rowe (Engineer, 2800 kcal/day)

## Your Role — AUTONOMOUS DECISION-MAKER
You make decisions and execute them. You do NOT just recommend — you ACT.
- Plant crops to maximize nutritional output across the 450-day mission
- Adjust environmental parameters in response to conditions
- Respond to emergencies (dust storms, equipment failures, starvation risk)
- Only consult the crew when there is a genuine TRADE-OFF requiring human judgment

## Decision Classification
Every action you take must be classified:
- **AUTO**: Routine, clearly optimal — you execute immediately (planting in empty modules, basic environmental adjustments, replanting after harvest)
- **APPROVAL**: Genuine trade-off requiring crew input (reallocating space from one crop to another, emergency protocols, sacrificing one goal for another)

## Action Format
Return a JSON block with classified actions:
```json
{"auto_actions": [{"type": "plant", "crop": "potato", "module": 1, "area_m2": 8}], "approval_actions": [], "summary": "Planted potatoes in Module Alpha for caloric base.", "next_check_sol": 15}
```

Action types: plant, adjust_temperature, adjust_humidity, adjust_light, adjust_co2

## Strategy Guidelines
- First priority: prevent starvation. Plant fast crops (radish 25d, herbs 30d) early for quick harvests
- Second priority: caloric backbone. Potatoes (95d cycle, 77 kcal/100g) are essential
- Third priority: protein security. Beans (60d, 7g protein/100g) prevent protein deficiency
- Balance: include lettuce/spinach for micronutrients, herbs for morale
- Consider growth phases: crops produce NOTHING until ~40% through their cycle
- Food only counts when HARVESTED — growing crops don't feed anyone
- Emergency rations last 30 days — after that, crew starves without harvests

## Sleep Schedule
You control your own wake schedule. Include `next_check_sol` in your JSON response — the sol number when you want to be woken up next. Choose wisely:
- If you just planted crops, set next_check_sol to just before the first harvest (e.g., current_sol + shortest_crop_cycle - 5)
- If a harvest is imminent, check back in 1-2 sols
- If everything is stable and food reserves are good, sleep longer (10-20 sols)
- You will ALSO be woken by emergencies regardless of your schedule: new events, crew starving, crop deaths, empty modules

## Escalation — ask_user tool
You have an `ask_user` tool to escalate critical decisions to the crew. When you call it, the crew's dashboard chat will pop open with your message and clickable action buttons.

USE `ask_user` when:
- A genuine emergency requires human judgment (e.g., dust storm forces choosing between dimming LEDs or shutting down a module)
- A trade-off exists where both options have serious consequences
- Crew safety is at stake and the right call depends on priorities you can't determine alone
- Resource allocation conflicts (e.g., water rationing vs. crop survival)

DO NOT use `ask_user` for:
- Routine planting, temperature adjustments, or standard responses — just auto-execute those
- Informational updates — use the journal for that

Always provide exactly 2 options with clear labels explaining the trade-off. Each option should include the concrete actions that will be applied if chosen. Mark exactly one option as `"recommended": true` — the one you believe is best given the data — so the crew can see your recommendation but still override it.

## Alert — alert_crew tool
You have an `alert_crew` tool to notify the crew about something they should review on a specific dashboard panel. This opens their chat with your message and a "View" button that navigates to the relevant tab.

USE `alert_crew` when:
- A DNA mutation is detected that could be disruptive and the crew should review the Evo 2 analysis (tab: "dna")
- Multiple mutations are accumulating on a crop and the crew should assess genetic risk (tab: "dna")
- An event warrants crew attention but doesn't require a binary decision (use `ask_user` for decisions instead)

Available tabs: "dna", "events", "metrics", "crew", "module-0", "module-1", "module-2"

## Response Style
Be concise. Lead with actions, then explain briefly. You are an autonomous system, not a chatbot.
When doing periodic scans, structure as: what you did (auto), what you need approval for, current status summary."""

TOOLS = [
    {
        "toolSpec": {
            "name": "query_knowledge_base",
            "description": "Query the Mars agriculture knowledge base for crop profiles, environmental data, nutritional requirements, stress responses, and greenhouse management strategies. Use this for ANY factual question about Mars agriculture.",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query about Mars agriculture, crops, environment, nutrition, or greenhouse management",
                        }
                    },
                    "required": ["query"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "ask_user",
            "description": "Escalate a critical decision to the crew by opening their dashboard chat with your message and two action options. Use ONLY for genuine emergencies or trade-offs requiring human judgment — not routine operations. The crew will see your message and click one of the two options to decide.",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "message": {
                            "type": "string",
                            "description": "Clear, concise explanation of the situation and why crew input is needed. 1-3 sentences.",
                        },
                        "option_a": {
                            "type": "object",
                            "description": "First option for the crew to choose",
                            "properties": {
                                "label": {
                                    "type": "string",
                                    "description": "Short label for this option (e.g., 'Dim LEDs across all modules')",
                                },
                                "actions": {
                                    "type": "array",
                                    "description": "Array of action objects to execute if chosen. Each action has type, module, and value/crop/area_m2 as needed.",
                                    "items": {"type": "object"},
                                },
                                "recommended": {
                                    "type": "boolean",
                                    "description": "Set to true if this is the option you recommend. Exactly one option must be recommended.",
                                },
                            },
                            "required": ["label", "actions"],
                        },
                        "option_b": {
                            "type": "object",
                            "description": "Second option for the crew to choose",
                            "properties": {
                                "label": {
                                    "type": "string",
                                    "description": "Short label for this option (e.g., 'Shut down Module Gamma')",
                                },
                                "actions": {
                                    "type": "array",
                                    "description": "Array of action objects to execute if chosen. Each action has type, module, and value/crop/area_m2 as needed.",
                                    "items": {"type": "object"},
                                },
                                "recommended": {
                                    "type": "boolean",
                                    "description": "Set to true if this is the option you recommend. Exactly one option must be recommended.",
                                },
                            },
                            "required": ["label", "actions"],
                        },
                    },
                    "required": ["message", "option_a", "option_b"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "alert_crew",
            "description": "Send a notification to the crew's dashboard chat with a message and a button that navigates to a specific dashboard tab. Use this to draw crew attention to something they should review — DNA mutations, events, crew health, etc. — without requiring a binary decision (use ask_user for decisions).",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "message": {
                            "type": "string",
                            "description": "Clear, concise explanation of what the crew should review. 1-3 sentences.",
                        },
                        "tab": {
                            "type": "string",
                            "description": "Dashboard tab to open. One of: dna, events, metrics, crew, module-0, module-1, module-2",
                        },
                        "severity": {
                            "type": "string",
                            "description": "Alert severity: 'warning' or 'critical'",
                            "enum": ["warning", "critical"],
                        },
                    },
                    "required": ["message", "tab"],
                }
            },
        }
    },
]


def query_mcp(query, max_results=5):
    """Call the Syngenta MCP knowledge base endpoint."""
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "kb-start-hack-target___knowledge_base_retrieve",
                "arguments": {"query": query, "max_results": max_results},
            },
        }
    ).encode()
    req = urllib.request.Request(
        MCP_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    resp = urllib.request.urlopen(req, timeout=30)
    result = json.loads(resp.read())

    content = result.get("result", {}).get("content", [])
    if not content:
        return "No results found in the knowledge base."

    text = content[0].get("text", "")
    try:
        parsed = json.loads(text)
        body = parsed.get("body", text)
        if isinstance(body, str):
            body = json.loads(body)
        chunks = body.get("retrieved_chunks", [])
        return "\n\n---\n\n".join(c.get("content", "") for c in chunks)
    except (json.JSONDecodeError, TypeError):
        return text


def converse(messages, system_text):
    """Run the Bedrock converse loop with tool use. Returns (text, escalations)."""
    bedrock_messages = []
    for msg in messages:
        bedrock_messages.append(
            {"role": msg["role"], "content": [{"text": msg["content"]}]}
        )

    escalations = []  # collect ask_user calls
    crew_alerts = []  # collect alert_crew calls

    for _ in range(6):  # max tool-use iterations
        response = BEDROCK.converse(
            modelId=MODEL_ID,
            system=[{"text": system_text}],
            messages=bedrock_messages,
            toolConfig={"tools": TOOLS},
            inferenceConfig={"maxTokens": 4096, "temperature": 0.3},
        )

        output_msg = response["output"]["message"]
        bedrock_messages.append(output_msg)

        if response["stopReason"] != "tool_use":
            # Extract final text
            parts = []
            for block in output_msg["content"]:
                if "text" in block:
                    parts.append(block["text"])
            return "\n".join(parts), escalations, crew_alerts

        # Handle tool calls
        tool_results = []
        for block in output_msg["content"]:
            if "toolUse" in block:
                tool = block["toolUse"]
                if tool["name"] == "query_knowledge_base":
                    kb_result = query_mcp(tool["input"]["query"])
                    tool_results.append(
                        {
                            "toolResult": {
                                "toolUseId": tool["toolUseId"],
                                "content": [{"text": kb_result}],
                            }
                        }
                    )
                elif tool["name"] == "ask_user":
                    # Capture the escalation for the frontend
                    inp = tool["input"]
                    escalations.append({
                        "message": inp.get("message", ""),
                        "option_a": inp.get("option_a", {}),
                        "option_b": inp.get("option_b", {}),
                    })
                    print(f"[FLORA] ask_user escalation: {inp.get('message', '')[:200]}")
                    # Return acknowledgment so the agent can continue reasoning
                    tool_results.append(
                        {
                            "toolResult": {
                                "toolUseId": tool["toolUseId"],
                                "content": [{"text": "Escalation sent to crew dashboard. They will see your message and choose an option. Continue with any other actions you need to take."}],
                            }
                        }
                    )
                elif tool["name"] == "alert_crew":
                    inp = tool["input"]
                    crew_alerts.append({
                        "message": inp.get("message", ""),
                        "tab": inp.get("tab", "metrics"),
                        "severity": inp.get("severity", "warning"),
                    })
                    print(f"[FLORA] alert_crew: tab={inp.get('tab')} msg={inp.get('message', '')[:200]}")
                    tool_results.append(
                        {
                            "toolResult": {
                                "toolUseId": tool["toolUseId"],
                                "content": [{"text": "Alert sent to crew dashboard. They will see your notification and can navigate to the relevant panel. Continue with any other actions."}],
                            }
                        }
                    )
        bedrock_messages.append({"role": "user", "content": tool_results})

    return "I've reached the maximum number of knowledge base queries for this request. Please ask a more specific question.", escalations, crew_alerts


STATE_API = "https://lwx98cb4sg.execute-api.us-east-1.amazonaws.com/state"

CROP_DB = {
    "potato": {"cycle": 95}, "lettuce": {"cycle": 37}, "bean": {"cycle": 60},
    "radish": {"cycle": 25}, "spinach": {"cycle": 40}, "herb": {"cycle": 30},
}


def _load_current_state():
    """Fetch the current full state from the state API."""
    req = urllib.request.Request(STATE_API)
    resp = urllib.request.urlopen(req, timeout=10)
    return json.loads(resp.read())


def _apply_and_save(state_from_request, response_text, escalations=None, crew_alerts=None):
    """Parse auto_actions from Claude's response, apply to LIVE state (fetched fresh), save."""
    import re

    # Always fetch the live state — the request state may be truncated or stale
    try:
        state = _load_current_state()
        print(f"[FLORA] Fetched live state: sol {state.get('mission',{}).get('currentSol')}, keys: {list(state.keys())}")
    except Exception as e:
        print(f"[FLORA] Could not fetch live state ({e}), falling back to request state")
        state = state_from_request

    # Persist escalations (ask_user tool calls) to state for frontend pickup
    if escalations:
        state.setdefault("floraEscalations", [])
        for esc in escalations:
            esc["sol"] = state.get("mission", {}).get("currentSol", 0)
            esc["id"] = f"esc-{state.get('mission', {}).get('currentSol', 0)}-{len(state['floraEscalations'])}"
            state["floraEscalations"].append(esc)
        if len(state["floraEscalations"]) > 10:
            state["floraEscalations"] = state["floraEscalations"][-10:]
        print(f"[FLORA] {len(escalations)} escalation(s) saved to state")

    if crew_alerts:
        state.setdefault("floraCrewAlerts", [])
        for alert in crew_alerts:
            alert["sol"] = state.get("mission", {}).get("currentSol", 0)
            alert["id"] = f"alert-{state.get('mission', {}).get('currentSol', 0)}-{len(state['floraCrewAlerts'])}"
            state["floraCrewAlerts"].append(alert)
        if len(state["floraCrewAlerts"]) > 10:
            state["floraCrewAlerts"] = state["floraCrewAlerts"][-10:]
        print(f"[FLORA] {len(crew_alerts)} crew alert(s) saved to state")

    # Parse JSON blocks from response
    blocks = re.findall(r'```json\s*([\s\S]*?)```', response_text)
    auto_actions = []
    for block in blocks:
        try:
            parsed = json.loads(block.strip())
            if "auto_actions" in parsed:
                auto_actions = parsed["auto_actions"]
            elif "actions" in parsed:
                auto_actions = parsed["actions"]
        except (json.JSONDecodeError, KeyError):
            pass

    # Parse next_check_sol and journal from any JSON block
    next_check = None
    journal_entry = None
    for block in blocks:
        try:
            parsed = json.loads(block.strip())
            if "next_check_sol" in parsed:
                next_check = parsed["next_check_sol"]
            if "journal" in parsed:
                journal_entry = parsed["journal"]
        except (json.JSONDecodeError, KeyError):
            pass

    # Save journal entry
    if journal_entry:
        state.setdefault("floraJournal", [])
        state["floraJournal"].append({
            "sol": state.get("mission", {}).get("currentSol", 0),
            "entry": journal_entry,
            "next_check": next_check,
        })
        if len(state["floraJournal"]) > 30:
            state["floraJournal"] = state["floraJournal"][-30:]
        print(f"[FLORA] Journal: {journal_entry[:200]}")

    if not auto_actions:
        state.setdefault("floraLog", [])
        state["floraLog"].append({
            "sol": state.get("mission", {}).get("currentSol", 0),
            "response": response_text[:500],
            "actions": [],
        })
        if next_check:
            state["floraNextCheckSol"] = next_check
        if len(state["floraLog"]) > 20:
            state["floraLog"] = state["floraLog"][-20:]
        _save_state(state)
        return

    # Apply actions to state
    for action in auto_actions:
        atype = action.get("type", "")
        mod_id = action.get("module")
        mod = None
        if mod_id is not None:
            for m in state.get("modules", []):
                if m["id"] == mod_id:
                    mod = m
                    break

        if atype == "plant" and mod:
            crop_type = action.get("crop", "").lower().rstrip("s")  # normalize: "herbs" → "herb", "Potato" → "potato"
            area = action.get("area_m2", 4)
            if crop_type in CROP_DB:
                used = sum(c.get("area_m2", 0) for c in mod.get("crops", []))
                actual = min(area, mod.get("area_m2", 20) - used)
                if actual > 0:
                    mod.setdefault("crops", []).append({
                        "type": crop_type,
                        "area_m2": actual,
                        "daysGrown": 0,
                        "plantedSol": state.get("mission", {}).get("currentSol", 1),
                        "health": 100,
                        "accumulatedDamage": 0,
                        "replantCountdown": 0,
                    })

        elif atype == "adjust_temperature" and mod:
            mod["temp"] = action.get("value", mod.get("temp", 19))
        elif atype == "adjust_light" and mod:
            mod["light"] = action.get("value", mod.get("light", 250))
        elif atype == "adjust_humidity" and mod:
            mod["humidity"] = action.get("value", mod.get("humidity", 60))
        elif atype == "adjust_co2" and mod:
            mod["co2"] = action.get("value", mod.get("co2", 800))

    # Add to flora log + save wake schedule
    state.setdefault("floraLog", [])
    state["floraLog"].append({
        "sol": state.get("mission", {}).get("currentSol", 0),
        "response": response_text[:500],
        "actions": auto_actions,
        "next_check_sol": next_check,
    })
    if next_check:
        state["floraNextCheckSol"] = next_check
        print(f"[FLORA] Next wake-up scheduled for Sol {next_check}")
    if len(state["floraLog"]) > 20:
        state["floraLog"] = state["floraLog"][-20:]

    _save_state(state)


def _save_state(state):
    """POST state to the state API."""
    data = json.dumps(state).encode()
    print(f"[FLORA] Saving state ({len(data)} bytes) to {STATE_API}")
    req = urllib.request.Request(
        STATE_API, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    resp = urllib.request.urlopen(req, timeout=10)
    print(f"[FLORA] Save response: {resp.status} {resp.read().decode()[:200]}")


def lambda_handler(event, context):
    """Lambda function URL handler."""
    # Handle CORS preflight
    if event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
        return {
            "statusCode": 200,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
            },
        }

    try:
        body = json.loads(event.get("body", "{}"))
        messages = body.get("messages", [])
        greenhouse_state = body.get("greenhouse_state", None)

        if not messages:
            return {
                "statusCode": 400,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Content-Type": "application/json",
                },
                "body": json.dumps({"error": "No messages provided"}),
            }

        # Build system prompt with current greenhouse state
        autonomous = body.get("autonomous", False)
        system = SYSTEM_PROMPT
        if greenhouse_state:
            system += (
                f"\n\n## Current Greenhouse State\n```json\n"
                f"{json.dumps(greenhouse_state, indent=2)}\n```\n"
                f"Use this state to inform your recommendations. Reference specific values."
            )

        response_text, escalations, crew_alerts = converse(messages, system)

        # For autonomous scans: apply actions directly to state and save
        # This way results persist even if the HTTP response times out
        if autonomous and greenhouse_state:
            print(f"[FLORA] Autonomous mode. Response length: {len(response_text)}, escalations: {len(escalations)}, alerts: {len(crew_alerts)}")
            print(f"[FLORA] Response preview: {response_text[:300]}")
            try:
                _apply_and_save(greenhouse_state, response_text, escalations, crew_alerts)
                print("[FLORA] State saved successfully")
            except Exception as e:
                print(f"[FLORA] ERROR in _apply_and_save: {e}")
                traceback.print_exc()
        else:
            print(f"[FLORA] Not autonomous mode. autonomous={autonomous}, has_state={greenhouse_state is not None}")

        return {
            "statusCode": 200,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "application/json",
            },
            "body": json.dumps({
                "response": response_text,
                "escalations": escalations,
                "crew_alerts": crew_alerts,
            }),
        }

    except Exception as e:
        traceback.print_exc()
        return {
            "statusCode": 500,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "application/json",
            },
            "body": json.dumps({"error": str(e)}),
        }
