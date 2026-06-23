# P2P GPU Compute Cloud — Decentralized Serverless Inference Network

A decentralized, serverless inference API that routes developer requests to a distributed mesh of consumer GPUs running quantized open-source AI models.

**OpenAI-compatible** — developers only need to change `base_url` to switch from OpenAI/Azure to this network.

## Architecture

```
Developer (cURL/SDK)
    │
    │  POST /v1/chat/completions
    ▼
┌─────────────────────────┐
│   Central Router        │
│   (Node.js)             │
│                         │
│  ┌──────────────────┐   │
│  │ API Gateway      │   │   ← OpenAI-compatible REST API
│  │ Load Balancer    │   │   ← Routes to idle nodes
│  │ Failover Engine  │   │   ← Auto-retries on node failure
│  │ Node Registry    │   │   ← Tracks heartbeats + VRAM
│  └──────────────────┘   │
└──────────┬──────────────┘
           │ WebSocket
     ┌─────┴─────┐
     ▼           ▼
┌─────────┐ ┌─────────┐
│ Node 1  │ │ Node 2  │    ← Consumer GPUs
│ (Python)│ │ (Python)│
│ llama.cpp│ │ llama.cpp│
└─────────┘ └─────────┘
```

## Prerequisites

- **Node.js** 18+ (for the Central Router)
- **Python** 3.10+ (for Provider Nodes)
- **Model file** (for real inference): `Meta-Llama-3-8B-Instruct.Q4_K_M.gguf` (~4.9 GB)
  - Place in `provider-node/models/`

## Quick Start

### 1. Install dependencies

```bash
# Router
cd central-router
npm install

# Provider Node
cd ../provider-node
pip install -r requirements.txt
```

### 2. Start the Central Router

```bash
cd central-router
npm start
```

The router starts on `http://localhost:3000` with:
- `POST /v1/chat/completions` — OpenAI-compatible inference
- `GET /v1/models` — List available models
- `GET /health` — Health check
- `GET /nodes` — View connected provider nodes

### 3. Start Provider Nodes

**Mock mode** (no GPU required — for testing):

```bash
# Terminal 2 — Node 1
cd provider-node
python main.py --port 8001 --mock

# Terminal 3 — Node 2
python main.py --port 8002 --mock
```

**Real inference** (requires GPU + model file):

```bash
python main.py --port 8001 --model-path ./models/Meta-Llama-3-8B-Instruct.Q4_K_M.gguf
```

### 4. Send an inference request

**Streaming (SSE):**

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3-8b",
    "messages": [{"role": "user", "content": "Explain quantum computing in 3 sentences."}],
    "stream": true
  }'
```

**Non-streaming:**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3-8b",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

**Using the OpenAI Python SDK:**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="any-key",  # No auth in MVP
)

response = client.chat.completions.create(
    model="llama-3-8b",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

## Configuration

### Central Router

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HEARTBEAT_CHECK_MS` | `5000` | Heartbeat check interval (ms) |
| `HEARTBEAT_TIMEOUT_MS` | `15000` | Node eviction timeout (ms) |
| `MAX_RETRIES` | `2` | Max failover retry attempts |
| `FIRST_TOKEN_TIMEOUT_MS` | `2000` | First-token timeout (ms) |
| `TOTAL_TIMEOUT_MS` | `30000` | Total request timeout (ms) |

### Provider Node

| CLI Flag | Environment Variable | Default | Description |
|----------|---------------------|---------|-------------|
| `--port` | `NODE_PORT` | `8001` | Node identifier port |
| `--model-path` | `MODEL_PATH` | `./models/...` | Path to GGUF model |
| `--router-url` | `ROUTER_WS_URL` | `ws://localhost:3000/provider` | Router WebSocket URL |
| `--mock` | `MOCK_MODE` | `false` | Mock mode (no GPU) |
| `--n-gpu-layers` | `N_GPU_LAYERS` | `-1` | GPU layers to offload |
| `--n-ctx` | `N_CTX` | `4096` | Context window size |

## API Reference

### POST /v1/chat/completions

Matches the [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat) schema.

**Request:**

```json
{
  "model": "llama-3-8b",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": true
}
```

**Streaming Response** (`stream: true`):

```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234,"model":"llama-3-8b","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234,"model":"llama-3-8b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**Non-streaming Response** (`stream: false`):

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1234,
  "model": "llama-3-8b",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hello! How can I help you?"},
    "finish_reason": "stop"
  }]
}
```

### GET /v1/models

Returns the list of available models.

### GET /health

Returns server health and node counts.

### GET /nodes

Returns detailed information about all connected provider nodes.

## Testing

```bash
# Full end-to-end test
bash test/test_local_e2e.sh

# Failover test (kills a node mid-generation)
bash test/test_failover.sh
```

## Error Handling & Failover

The system provides enterprise-grade reliability on an unstable P2P mesh:

1. **First-token timeout**: If a node doesn't produce its first token within 2 seconds, the request is automatically re-routed
2. **Mid-generation failover**: If a node disconnects during inference, the exact same prompt is immediately sent to a backup node
3. **Heartbeat monitoring**: Nodes that miss 3 consecutive heartbeats (15s) are automatically evicted
4. **Max retries**: Up to 2 retry attempts per request to prevent infinite loops
5. **Graceful degradation**: Returns 503 with clear error messages when no nodes are available

## Project Structure

```
p2p_c/
├── central-router/             # Node.js — Router + API Gateway
│   ├── package.json
│   └── src/
│       ├── index.js            # Server entry point
│       ├── gateway.js          # OpenAI-compatible API + failover
│       ├── load-balancer.js    # Node selection logic
│       ├── registry.js         # In-memory node registry + heartbeats
│       ├── ws-handler.js       # WebSocket server for providers
│       └── logger.js           # Structured colored logging
├── provider-node/              # Python — GPU Provider
│   ├── requirements.txt
│   ├── main.py                 # Entry point (--mock for testing)
│   ├── config.py               # Configuration
│   ├── model_loader.py         # GGUF model loading + MockLlama
│   ├── inference.py            # Streaming inference wrapper
│   └── ws_client.py            # WebSocket client to router
├── test/
│   ├── test_local_e2e.sh       # E2E test script
│   └── test_failover.sh        # Failover test script
└── README.md
```

## License

MIT
