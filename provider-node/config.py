"""
Configuration for the Provider Node.

Supports both class-based (new TUI main.py) and module-level (legacy) access.
All values can be overridden via environment variables or CLI arguments.
"""

import os


class Config:
    """Configuration container for the provider node."""

    def __init__(self):
        # Model
        self.model_path = os.getenv(
            "MODEL_PATH",
            os.path.join(os.path.dirname(__file__), "models",
                         "Meta-Llama-3-8B-Instruct.Q4_K_M.gguf"),
        )
        self.model_name = "llama-3-8b"
        self.n_gpu_layers = int(os.getenv("N_GPU_LAYERS", "-1"))
        self.n_ctx = int(os.getenv("N_CTX", "4096"))

        # Network
        self.router_ws_url = os.getenv("ROUTER_WS_URL", "ws://localhost:3000/provider")
        self.port = int(os.getenv("NODE_PORT", "8001"))
        self.node_id = os.getenv("NODE_ID", "")

        # Heartbeat
        self.heartbeat_interval = int(os.getenv("HEARTBEAT_INTERVAL", "5"))

        # Reconnection
        self.reconnect_base_delay = float(os.getenv("RECONNECT_BASE_DELAY", "1.0"))
        self.reconnect_max_delay = float(os.getenv("RECONNECT_MAX_DELAY", "30.0"))

        # Mock
        self.mock_mode = os.getenv("MOCK_MODE", "false").lower() in ("true", "1")
        self.mock_token_delay = float(os.getenv("MOCK_TOKEN_DELAY", "0.05"))


# ──────────────────────────────────────────────
# Module-level defaults (backward compatibility)
# ──────────────────────────────────────────────

_default = Config()

MODEL_PATH = _default.model_path
MODEL_NAME = _default.model_name
N_GPU_LAYERS = _default.n_gpu_layers
N_CTX = _default.n_ctx
ROUTER_WS_URL = _default.router_ws_url
NODE_PORT = _default.port
HEARTBEAT_INTERVAL = _default.heartbeat_interval
RECONNECT_BASE_DELAY = _default.reconnect_base_delay
RECONNECT_MAX_DELAY = _default.reconnect_max_delay
MOCK_MODE = _default.mock_mode
MOCK_TOKEN_DELAY = _default.mock_token_delay
