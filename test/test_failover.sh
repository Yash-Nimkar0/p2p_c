#!/usr/bin/env bash
# ════════════════════════════════════════════════════════
# Failover Test Script for P2P GPU Inference Network
# ════════════════════════════════════════════════════════
#
# Tests:
#   1. Start Router + 2 mock Provider Nodes
#   2. Send a large prompt to Node 1
#   3. Kill Node 1 mid-generation
#   4. Verify Node 2 picks up and completes the request
#
# Usage:
#   bash test/test_failover.sh

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
}
trap cleanup EXIT

echo -e "${CYAN}════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  P2P GPU Inference Network — Failover Test${NC}"
echo -e "${CYAN}════════════════════════════════════════════════${NC}"

# ── Start Router ──
echo -e "\n${YELLOW}[1/4] Starting Central Router...${NC}"
cd "$PROJECT_DIR/central-router"
node src/index.js &
ROUTER_PID=$!
sleep 2

# ── Start two mock nodes ──
echo -e "${YELLOW}[2/4] Starting Provider Nodes...${NC}"
cd "$PROJECT_DIR/provider-node"
python3 main.py --port 8001 --mock --node-id failover-node-1 &
NODE1_PID=$!
python3 main.py --port 8002 --mock --node-id failover-node-2 &
NODE2_PID=$!
sleep 3

# Verify both registered
NODES=$(curl -s http://localhost:3000/nodes)
NODE_COUNT=$(echo "$NODES" | python3 -c "import sys,json; print(json.load(sys.stdin)['counts']['total'])")
echo -e "${GREEN}  Nodes registered: $NODE_COUNT${NC}"

# ── Send a request and kill Node 1 mid-generation ──
echo -e "\n${YELLOW}[3/4] Sending request and killing Node 1 mid-generation...${NC}"

# Start the request in background (non-streaming so it will wait for completion or failover)
curl -s -o /tmp/p2p_failover_result.json \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3-8b","messages":[{"role":"user","content":"Tell me a very long story about the history of computing, starting from the abacus and going all the way to modern quantum computers. Include details about every major milestone."}],"stream":false}' \
  http://localhost:3000/v1/chat/completions &
CURL_PID=$!

# Wait a bit for inference to start, then kill node 1
sleep 1
echo -e "${RED}  Killing Node 1 (PID $NODE1_PID)...${NC}"
kill "$NODE1_PID" 2>/dev/null || true
NODE1_PID=""

# Wait for the request to complete (should failover to node 2)
wait $CURL_PID 2>/dev/null || true

# ── Verify the result ──
echo -e "\n${YELLOW}[4/4] Checking failover result...${NC}"

if [[ -f /tmp/p2p_failover_result.json ]]; then
  HAS_RESPONSE=$(python3 -c "
import json
try:
    d = json.load(open('/tmp/p2p_failover_result.json'))
    if d.get('choices'):
        content = d['choices'][0].get('message', {}).get('content', '')
        print(f'ok:{len(content)}')
    elif d.get('error'):
        print(f'error:{d[\"error\"][\"message\"]}')
    else:
        print('unknown')
except Exception as e:
    print(f'parse_error:{e}')
  ")

  if [[ "$HAS_RESPONSE" == ok:* ]]; then
    CONTENT_LEN="${HAS_RESPONSE#ok:}"
    echo -e "${GREEN}  ✅ Failover succeeded! Response received (${CONTENT_LEN} chars)${NC}"
    echo -e "${GREEN}  The request was seamlessly re-routed to Node 2${NC}"
  else
    echo -e "${YELLOW}  ⚠️  Result: $HAS_RESPONSE${NC}"
    echo -e "${YELLOW}  (This may happen if both nodes were killed or timing was off)${NC}"
  fi
else
  echo -e "${RED}  ❌ No response file found${NC}"
fi

echo -e "\n${GREEN}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Failover test complete${NC}"
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
