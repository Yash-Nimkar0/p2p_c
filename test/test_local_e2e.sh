#!/usr/bin/env bash
# ════════════════════════════════════════════════════════
# End-to-End Test Script for P2P GPU Inference Network
# ════════════════════════════════════════════════════════
#
# Tests:
#   1. Start the Central Router
#   2. Start two mock Provider Nodes
#   3. Verify both register with the Router
#   4. Send a streaming request → verify SSE response
#   5. Send two concurrent requests → verify load balancing
#
# Usage:
#   bash test/test_local_e2e.sh
#
# Requirements:
#   - Node.js 18+, Python 3.10+
#   - npm install in central-router/
#   - pip install websockets (for provider nodes)

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ROUTER_PID=""
NODE1_PID=""
NODE2_PID=""

cleanup() {
  echo -e "\n${YELLOW}Cleaning up...${NC}"
  [[ -n "$NODE1_PID" ]] && kill "$NODE1_PID" 2>/dev/null || true
  [[ -n "$NODE2_PID" ]] && kill "$NODE2_PID" 2>/dev/null || true
  [[ -n "$ROUTER_PID" ]] && kill "$ROUTER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo -e "${GREEN}Cleanup complete${NC}"
}
trap cleanup EXIT

echo -e "${CYAN}════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  P2P GPU Inference Network — E2E Test${NC}"
echo -e "${CYAN}════════════════════════════════════════════════${NC}"

# ── Step 1: Start the Router ──
echo -e "\n${YELLOW}[1/5] Starting Central Router...${NC}"
cd "$PROJECT_DIR/central-router"
node src/index.js &
ROUTER_PID=$!
sleep 2

# Verify router is up
HEALTH=$(curl -s http://localhost:3000/health)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo -e "${GREEN}  ✅ Router is running${NC}"
else
  echo -e "${RED}  ❌ Router failed to start${NC}"
  exit 1
fi

# ── Step 2: Start Provider Node 1 ──
echo -e "\n${YELLOW}[2/5] Starting Provider Node 1 (mock, port 8001)...${NC}"
cd "$PROJECT_DIR/provider-node"
python3 main.py --port 8001 --mock --node-id test-node-1 &
NODE1_PID=$!
sleep 2

# ── Step 3: Start Provider Node 2 ──
echo -e "\n${YELLOW}[3/5] Starting Provider Node 2 (mock, port 8002)...${NC}"
python3 main.py --port 8002 --mock --node-id test-node-2 &
NODE2_PID=$!
sleep 2

# Verify both nodes registered
NODES=$(curl -s http://localhost:3000/nodes)
NODE_COUNT=$(echo "$NODES" | python3 -c "import sys,json; print(json.load(sys.stdin)['counts']['total'])")
if [[ "$NODE_COUNT" -ge 2 ]]; then
  echo -e "${GREEN}  ✅ Both nodes registered ($NODE_COUNT nodes)${NC}"
else
  echo -e "${RED}  ❌ Expected 2 nodes, got $NODE_COUNT${NC}"
  exit 1
fi

# ── Step 4: Send a streaming request ──
echo -e "\n${YELLOW}[4/5] Sending streaming inference request...${NC}"
RESPONSE=$(curl -s -N \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3-8b","messages":[{"role":"user","content":"Hello, how are you?"}],"stream":true}' \
  http://localhost:3000/v1/chat/completions)

if echo "$RESPONSE" | grep -q 'data: \[DONE\]'; then
  echo -e "${GREEN}  ✅ Streaming response received with [DONE] terminator${NC}"
  # Show first few SSE lines
  echo "$RESPONSE" | head -3
else
  echo -e "${RED}  ❌ Streaming response missing [DONE]${NC}"
  echo "$RESPONSE"
  exit 1
fi

# ── Step 5: Send concurrent requests to test load balancing ──
echo -e "\n${YELLOW}[5/5] Testing load balancing with concurrent requests...${NC}"

# Send two requests in parallel
curl -s -o /tmp/p2p_req1.json \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3-8b","messages":[{"role":"user","content":"Request 1"}],"stream":false}' \
  http://localhost:3000/v1/chat/completions &
REQ1_PID=$!

curl -s -o /tmp/p2p_req2.json \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3-8b","messages":[{"role":"user","content":"Request 2"}],"stream":false}' \
  http://localhost:3000/v1/chat/completions &
REQ2_PID=$!

wait $REQ1_PID $REQ2_PID

if [[ -f /tmp/p2p_req1.json ]] && [[ -f /tmp/p2p_req2.json ]]; then
  R1_OK=$(python3 -c "import json; d=json.load(open('/tmp/p2p_req1.json')); print('ok' if d.get('choices') else 'fail')")
  R2_OK=$(python3 -c "import json; d=json.load(open('/tmp/p2p_req2.json')); print('ok' if d.get('choices') else 'fail')")
  if [[ "$R1_OK" == "ok" ]] && [[ "$R2_OK" == "ok" ]]; then
    echo -e "${GREEN}  ✅ Both concurrent requests succeeded${NC}"
  else
    echo -e "${RED}  ❌ One or both requests failed${NC}"
    exit 1
  fi
fi

echo -e "\n${GREEN}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  All E2E tests PASSED ✅${NC}"
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
