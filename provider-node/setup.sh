#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════
# MeshGPU Provider Node — One-Command Installer
# ════════════════════════════════════════════════════════════
#
# Usage:
#   curl -sSL https://meshgpu.dev/install.sh | bash
#   — OR —
#   bash setup.sh
#
# This script:
#   1. Detects your OS and GPU
#   2. Installs Python 3.10+ if missing
#   3. Creates a virtual environment
#   4. Installs all dependencies (with CUDA support if available)
#   5. Downloads the AI model (~5 GB) automatically
#   6. Starts the provider node with a beautiful dashboard
#

set -e

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

# ── Banner ──
echo ""
echo -e "${MAGENTA}${BOLD}"
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║           ⬡  MeshGPU Provider Setup          ║"
echo "  ║    Decentralized AI Inference Network         ║"
echo "  ╚══════════════════════════════════════════════╝"
echo -e "${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

# ──────────────────────────────────────────────
# Step 1: Detect OS
# ──────────────────────────────────────────────

echo -e "${CYAN}[1/5] Detecting system...${NC}"

OS="unknown"
ARCH="$(uname -m)"

case "$(uname -s)" in
  Linux*)   OS="linux";;
  Darwin*)  OS="macos";;
  MINGW*|MSYS*|CYGWIN*) OS="windows";;
esac

echo -e "  OS: ${GREEN}$OS${NC} ($ARCH)"

# ── Detect GPU ──
HAS_NVIDIA=false
if command -v nvidia-smi &> /dev/null; then
  HAS_NVIDIA=true
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
  GPU_VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null | head -1)
  echo -e "  GPU: ${GREEN}$GPU_NAME ($GPU_VRAM)${NC}"
else
  echo -e "  GPU: ${YELLOW}No NVIDIA GPU detected (will use CPU or mock mode)${NC}"
fi

# ──────────────────────────────────────────────
# Step 2: Check Python
# ──────────────────────────────────────────────

echo -e "\n${CYAN}[2/5] Checking Python...${NC}"

PYTHON=""
for candidate in python3.12 python3.11 python3.10 python3 python; do
  if command -v "$candidate" &> /dev/null; then
    version=$("$candidate" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+')
    major=$(echo "$version" | cut -d. -f1)
    minor=$(echo "$version" | cut -d. -f2)
    if [ "$major" -ge 3 ] && [ "$minor" -ge 10 ]; then
      PYTHON="$candidate"
      break
    fi
  fi
done

if [ -z "$PYTHON" ]; then
  echo -e "${RED}  ✗ Python 3.10+ is required but not found.${NC}"
  echo ""
  echo "  Install Python 3.10+ first:"
  if [ "$OS" = "macos" ]; then
    echo "    brew install python@3.12"
  elif [ "$OS" = "linux" ]; then
    echo "    sudo apt install python3.12 python3.12-venv"
  fi
  exit 1
fi

PY_VERSION=$("$PYTHON" --version 2>&1)
echo -e "  Found: ${GREEN}$PY_VERSION${NC} ($PYTHON)"

# ──────────────────────────────────────────────
# Step 3: Create Virtual Environment
# ──────────────────────────────────────────────

echo -e "\n${CYAN}[3/5] Setting up virtual environment...${NC}"

if [ -d "$VENV_DIR" ]; then
  echo -e "  ${GREEN}Virtual environment already exists${NC}"
else
  "$PYTHON" -m venv "$VENV_DIR"
  echo -e "  ${GREEN}Created virtual environment at .venv/${NC}"
fi

# Activate
source "$VENV_DIR/bin/activate"
pip install --upgrade pip -q

# ──────────────────────────────────────────────
# Step 4: Install Dependencies
# ──────────────────────────────────────────────

echo -e "\n${CYAN}[4/5] Installing dependencies...${NC}"

pip install -q websockets "rich>=13.0" "huggingface_hub>=0.23.0"

if [ "$HAS_NVIDIA" = true ]; then
  echo -e "  ${GREEN}NVIDIA GPU detected — installing llama-cpp-python with CUDA...${NC}"
  CMAKE_ARGS="-DGGML_CUDA=on" pip install llama-cpp-python --force-reinstall --no-cache-dir -q 2>&1 | tail -1
  pip install -q pynvml
else
  echo -e "  ${YELLOW}No NVIDIA GPU — installing CPU-only llama-cpp-python...${NC}"
  pip install -q llama-cpp-python
fi

echo -e "  ${GREEN}All dependencies installed ✓${NC}"

# ──────────────────────────────────────────────
# Step 5: Configuration
# ──────────────────────────────────────────────

echo -e "\n${CYAN}[5/5] Configuration...${NC}"

# Ask for router URL
DEFAULT_ROUTER="ws://localhost:3000/provider"
echo -e "  Enter the router WebSocket URL"
echo -e "  (press Enter for default: ${YELLOW}$DEFAULT_ROUTER${NC})"
read -r -p "  Router URL: " ROUTER_URL
ROUTER_URL="${ROUTER_URL:-$DEFAULT_ROUTER}"

echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Setup Complete! ✓${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════${NC}"
echo ""
echo -e "  To start the provider node:"
echo ""
echo -e "    ${CYAN}cd $SCRIPT_DIR${NC}"
echo -e "    ${CYAN}source .venv/bin/activate${NC}"
echo ""

if [ "$HAS_NVIDIA" = true ]; then
  echo -e "    ${CYAN}python main.py --router-url $ROUTER_URL${NC}"
  echo ""
  echo -e "  The AI model (~5 GB) will be auto-downloaded on first run."
else
  echo -e "    ${CYAN}python main.py --mock --router-url $ROUTER_URL${NC}"
  echo ""
  echo -e "  Running in mock mode (no GPU). For real inference, run on a machine with an NVIDIA GPU."
fi

echo ""
echo -e "  ${MAGENTA}Your GPU will start earning as soon as it connects to the mesh! ⬡${NC}"
echo ""

# ── Auto-start option ──
read -r -p "  Start the node now? [Y/n]: " START_NOW
START_NOW="${START_NOW:-Y}"

if [[ "$START_NOW" =~ ^[Yy] ]]; then
  echo ""
  if [ "$HAS_NVIDIA" = true ]; then
    exec "$PYTHON" main.py --router-url "$ROUTER_URL"
  else
    exec "$PYTHON" main.py --mock --router-url "$ROUTER_URL"
  fi
fi
