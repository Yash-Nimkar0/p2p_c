#!/usr/bin/env python3
"""
MeshGPU Provider Node — Rich TUI Dashboard

A beautiful terminal interface for GPU providers. Shows:
  - Connection status + node identity
  - GPU metrics (VRAM, temp, utilization)
  - Live inference stats (requests, tokens, latency)
  - Scrolling event log
  - Estimated earnings

Usage:
  python main.py --mock                # Test mode (no GPU)
  python main.py --port 8001           # Real GPU, auto-download model
  python main.py --model-path ./my.gguf # Custom model path
"""

import argparse
import asyncio
import logging
import signal
import sys
import time
import os
from datetime import datetime, timedelta

# ── Rich imports ──
from rich.console import Console
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.align import Align
from rich import box
from collections import deque

# ── Local imports ──
from config import Config
from gpu_monitor import get_gpu_info, is_real_gpu


console = Console()

# ──────────────────────────────────────────────
# Global State
# ──────────────────────────────────────────────

class NodeState:
    """Mutable state for the provider node, shared between TUI and WS client."""
    def __init__(self):
        self.connected = False
        self.node_id = ""
        self.model_name = "llama-3-8b"
        self.model_loaded = False
        self.start_time = time.time()

        # Stats
        self.requests_served = 0
        self.tokens_generated = 0
        self.total_latency_ms = 0
        self.active_request = None

        # Event log (last 30 events)
        self.events = deque(maxlen=30)

    @property
    def uptime(self):
        return timedelta(seconds=int(time.time() - self.start_time))

    @property
    def avg_latency(self):
        if self.requests_served == 0:
            return 0
        return int(self.total_latency_ms / self.requests_served)

    @property
    def earnings(self):
        # Placeholder: $0.0001 per token generated
        return self.tokens_generated * 0.0001

    def log_event(self, msg, level="INFO"):
        ts = datetime.now().strftime("%H:%M:%S")
        self.events.append((ts, level, msg))


state = NodeState()


# ──────────────────────────────────────────────
# TUI Layout Builder
# ──────────────────────────────────────────────

def build_layout():
    """Build the Rich Layout structure."""
    layout = Layout()
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="body"),
        Layout(name="log", size=14),
    )
    layout["body"].split_row(
        Layout(name="status", ratio=1),
        Layout(name="gpu", ratio=1),
        Layout(name="stats", ratio=1),
    )
    return layout


def render_header():
    """Top header bar."""
    status_icon = "[bold green]● CONNECTED[/]" if state.connected else "[bold red]● DISCONNECTED[/]"
    text = Text.from_markup(
        f" [bold]⬡ MeshGPU Provider[/]  │  {status_icon}  │  "
        f"[dim]Node: {state.node_id or '—'}[/]  │  "
        f"[dim]Uptime: {state.uptime}[/]"
    )
    return Panel(text, style="bright_blue", box=box.HEAVY)


def render_status():
    """Connection & model status panel."""
    table = Table(show_header=False, box=None, padding=(0, 1))
    table.add_column(style="dim", width=14)
    table.add_column()

    conn_status = "[green]Connected ✓[/]" if state.connected else "[red]Disconnected ✗[/]"
    model_status = "[green]Loaded ✓[/]" if state.model_loaded else "[yellow]Loading...[/]"
    active = f"[bold yellow]{state.active_request[:16]}...[/]" if state.active_request else "[dim]Idle[/]"

    table.add_row("Connection", conn_status)
    table.add_row("Model", f"[cyan]{state.model_name}[/]")
    table.add_row("Model Status", model_status)
    table.add_row("Active Job", active)
    table.add_row("Node ID", f"[dim]{state.node_id or '—'}[/]")

    return Panel(table, title="[bold]Status[/]", border_style="blue", box=box.ROUNDED)


def render_gpu():
    """GPU metrics panel."""
    gpu = get_gpu_info()
    table = Table(show_header=False, box=None, padding=(0, 1))
    table.add_column(style="dim", width=14)
    table.add_column()

    # VRAM bar
    vram_pct = int((gpu.vram_used_mb / gpu.vram_total_mb) * 100) if gpu.vram_total_mb > 0 else 0
    bar_len = 16
    filled = int(bar_len * vram_pct / 100)
    vram_bar = f"[green]{'█' * filled}[/][dim]{'░' * (bar_len - filled)}[/] {vram_pct}%"

    # Temp color
    temp_color = "green" if gpu.temperature < 60 else "yellow" if gpu.temperature < 80 else "red"

    table.add_row("GPU", f"[cyan]{gpu.name}[/]")
    table.add_row("VRAM", f"{gpu.vram_used_mb}/{gpu.vram_total_mb} MB")
    table.add_row("VRAM Usage", vram_bar)
    table.add_row("Temperature", f"[{temp_color}]{gpu.temperature}°C[/]")
    table.add_row("Utilization", f"{gpu.utilization}%")
    if gpu.power_draw:
        table.add_row("Power", f"{gpu.power_draw:.0f}W")

    gpu_type = "[green]Real GPU[/]" if is_real_gpu() else "[yellow]Mock Mode[/]"
    table.add_row("Type", gpu_type)

    return Panel(table, title="[bold]GPU[/]", border_style="magenta", box=box.ROUNDED)


def render_stats():
    """Inference stats panel."""
    table = Table(show_header=False, box=None, padding=(0, 1))
    table.add_column(style="dim", width=14)
    table.add_column()

    table.add_row("Requests", f"[bold]{state.requests_served}[/]")
    table.add_row("Tokens", f"[bold]{state.tokens_generated:,}[/]")
    table.add_row("Avg Latency", f"{state.avg_latency}ms")
    table.add_row("", "")
    table.add_row("[bold]Earnings[/]", f"[bold green]${state.earnings:.4f}[/]")

    return Panel(table, title="[bold]Stats[/]", border_style="green", box=box.ROUNDED)


def render_log():
    """Scrolling event log panel."""
    table = Table(show_header=True, box=None, padding=(0, 1), expand=True)
    table.add_column("Time", style="dim", width=10)
    table.add_column("Level", width=7)
    table.add_column("Message", ratio=1)

    for ts, level, msg in state.events:
        level_style = {
            "INFO": "[blue]INFO[/]",
            "WARN": "[yellow]WARN[/]",
            "ERROR": "[red]ERROR[/]",
            "OK": "[green]OK[/]",
        }.get(level, f"[dim]{level}[/]")
        table.add_row(ts, level_style, msg)

    return Panel(table, title="[bold]Event Log[/]", border_style="dim", box=box.ROUNDED)


def update_layout(layout):
    """Update all layout panels with current state."""
    layout["header"].update(render_header())
    layout["status"].update(render_status())
    layout["gpu"].update(render_gpu())
    layout["stats"].update(render_stats())
    layout["log"].update(render_log())


# ──────────────────────────────────────────────
# WebSocket Client (uses existing ws_client.py)
# ──────────────────────────────────────────────

async def run_ws_client(config, model):
    """Run the WebSocket client with TUI state updates."""
    from ws_client import create_ws_client

    state.log_event("Connecting to router...", "INFO")

    # Hook into ws_client events via callbacks
    class TUICallbacks:
        def on_connected(self):
            state.connected = True
            state.log_event(f"Connected to {config.router_ws_url}", "OK")

        def on_disconnected(self):
            state.connected = False
            state.log_event("Disconnected from router", "WARN")

        def on_registered(self, node_id):
            state.node_id = node_id
            state.log_event(f"Registered as [{node_id}]", "OK")

        def on_inference_start(self, request_id):
            state.active_request = request_id
            state.log_event(f"Inference started: {request_id[:20]}...", "INFO")

        def on_inference_complete(self, request_id, token_count, latency_ms):
            state.active_request = None
            state.requests_served += 1
            state.tokens_generated += token_count
            state.total_latency_ms += latency_ms
            state.log_event(
                f"Inference done: {token_count} tokens, {latency_ms}ms",
                "OK",
            )

        def on_model_switch_start(self, new_model):
            state.model_loaded = False
            state.model_name = new_model
            state.log_event(f"Downloading/Loading model: {new_model}...", "INFO")

        def on_model_switch_complete(self, new_model):
            state.model_loaded = True
            state.model_name = new_model
            state.log_event(f"Model {new_model} loaded successfully!", "OK")

        def on_error(self, msg):
            state.log_event(f"Error: {msg}", "ERROR")

    await create_ws_client(config, model, TUICallbacks())


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="MeshGPU Provider Node",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py --mock                   # Test without GPU
  python main.py --port 8001              # Real GPU, auto-download model
  python main.py --model-path ./my.gguf   # Custom model path
        """,
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("NODE_PORT", "8001")))
    parser.add_argument("--model-path", default=os.environ.get("MODEL_PATH", ""))
    parser.add_argument("--router-url", default=os.environ.get("ROUTER_WS_URL", "ws://localhost:3000/provider"))
    parser.add_argument("--node-id", default=os.environ.get("NODE_ID", ""))
    parser.add_argument("--mock", action="store_true", default=os.environ.get("MOCK_MODE", "").lower() in ("1", "true"))
    parser.add_argument("--headless", action="store_true", default=os.environ.get("HEADLESS", "").lower() in ("1", "true"), help="Disable TUI")
    parser.add_argument("--n-gpu-layers", type=int, default=int(os.environ.get("N_GPU_LAYERS", "-1")))
    parser.add_argument("--n-ctx", type=int, default=int(os.environ.get("N_CTX", "4096")))

    args = parser.parse_args()

    # Build config
    config = Config()
    config.port = args.port
    config.router_ws_url = args.router_url
    config.mock_mode = args.mock
    config.n_gpu_layers = args.n_gpu_layers
    config.n_ctx = args.n_ctx

    if args.node_id:
        config.node_id = args.node_id
    else:
        import socket
        config.node_id = f"node-{socket.gethostname()}-{args.port}"

    state.node_id = config.node_id

    # ── Load model ──
    state.log_event("Starting MeshGPU Provider Node...", "INFO")
    state.log_event(f"Node ID: {config.node_id}", "INFO")

    if args.mock:
        from model_loader import get_mock_model
        model = get_mock_model()
        state.model_loaded = True
        state.log_event("Mock model loaded (no GPU required)", "OK")
    else:
        state.log_event("Loading model...", "INFO")
        if args.model_path:
            state.log_event(f"Model path: {args.model_path}", "INFO")
            from model_loader import load_model
            model = load_model(args.model_path, args.n_gpu_layers, args.n_ctx)
        else:
            state.log_event("No model path specified — auto-downloading...", "INFO")
            from model_loader import auto_download_model, load_model
            model_path = auto_download_model()
            model = load_model(model_path, args.n_gpu_layers, args.n_ctx)
        state.model_loaded = True
        state.log_event("Model loaded successfully!", "OK")

    # ── Run TUI + WebSocket client concurrently ──
    layout = build_layout()

    async def run_all():
        ws_task = asyncio.create_task(run_ws_client(config, model))

        if args.headless:
            # Run without TUI
            try:
                # Setup basic print logging for headless mode
                root_logger = logging.getLogger()
                root_logger.setLevel(logging.INFO)
                # Remove default handlers
                for handler in root_logger.handlers[:]:
                    root_logger.removeHandler(handler)
                # Add stdout handler
                import sys
                handler = logging.StreamHandler(sys.stdout)
                formatter = logging.Formatter('%(levelname)s:%(name)s:%(message)s')
                handler.setFormatter(formatter)
                root_logger.addHandler(handler)
                
                while True:
                    await asyncio.sleep(1)
            except (KeyboardInterrupt, asyncio.CancelledError):
                ws_task.cancel()
                try:
                    await ws_task
                except asyncio.CancelledError:
                    pass
        else:
            # TUI refresh loop
            with Live(layout, console=console, refresh_per_second=2, screen=True) as live:
                try:
                    while True:
                        update_layout(layout)
                        await asyncio.sleep(0.5)
                except (KeyboardInterrupt, asyncio.CancelledError):
                    state.log_event("Shutting down...", "WARN")
                    ws_task.cancel()
                    try:
                        await ws_task
                    except asyncio.CancelledError:
                        pass

    try:
        asyncio.run(run_all())
    except KeyboardInterrupt:
        if not args.headless:
            console.print("\n[yellow]Provider node stopped.[/]")
        else:
            print("\nProvider node stopped.")


if __name__ == "__main__":
    # Suppress noisy logs — TUI handles display
    logging.basicConfig(level=logging.WARNING)
    main()
