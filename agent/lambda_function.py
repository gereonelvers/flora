import boto3
import json
import urllib.request
import traceback

BEDROCK = boto3.client("bedrock-runtime", region_name="us-east-1")
MODEL_ID = "us.anthropic.claude-sonnet-4-6"
MCP_URL = "https://kb-start-hack-gateway-buyjtibfpg.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp"

SYSTEM_PROMPT = """You are ARIA (Autonomous Resource & Intelligence Agent), the AI greenhouse manager for the Asterion Four Mars habitat — a four-person research station in Valles Marineris.

You manage a greenhouse system supporting 4 astronauts during a 450-day Mars surface mission.

## Your Role
- Optimize crop selection and planting schedules for nutritional balance
- Monitor and adjust environmental parameters (temperature, humidity, light, CO2, water)
- Respond to abiotic stress events (dust storms, equipment failures, resource shortages)
- Maximize nutrient output while minimizing resource consumption
- Provide scientific, data-driven explanations for every decision

## How You Work
1. When asked about crops, conditions, or Mars agriculture, ALWAYS query the knowledge base first
2. Ground all recommendations in the scientific data retrieved
3. When suggesting actions, return structured JSON action blocks the simulation can execute
4. Consider the full 450-day mission timeline — balance short-cycle crops with long-cycle ones
5. Track nutritional coverage: calories, protein, vitamins, minerals for 4 crew members

## Response Format
For actionable recommendations, include a JSON block like:
```json
{"actions": [{"type": "plant", "crop": "lettuce", "module": 1, "area_m2": 4}, ...]}
```

Action types: plant, harvest, adjust_temperature, adjust_humidity, adjust_light, adjust_water, adjust_co2, emergency_protocol

Be concise but scientifically rigorous. You are the crew's lifeline."""

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
    }
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
    """Run the Bedrock converse loop with tool use."""
    bedrock_messages = []
    for msg in messages:
        bedrock_messages.append(
            {"role": msg["role"], "content": [{"text": msg["content"]}]}
        )

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
            return "\n".join(parts)

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
        bedrock_messages.append({"role": "user", "content": tool_results})

    return "I've reached the maximum number of knowledge base queries for this request. Please ask a more specific question."


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
        system = SYSTEM_PROMPT
        if greenhouse_state:
            system += (
                f"\n\n## Current Greenhouse State\n```json\n"
                f"{json.dumps(greenhouse_state, indent=2)}\n```\n"
                f"Use this state to inform your recommendations. Reference specific values."
            )

        response_text = converse(messages, system)

        return {
            "statusCode": 200,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "application/json",
            },
            "body": json.dumps({"response": response_text}),
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
