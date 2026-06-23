"""
WebSocket client — manages the persistent connection between this
Provider Node and the Central Router.

Responsibilities:
  - Connect to the router and send a registration message
  - Send periodic heartbeat pings
  - Listen for inference requests from the router
  - Stream inference results back to the router
  - Reconnect with exponential backoff on disconnect
  - Report real GPU metrics via gpu_monitor
"""

import asyncio
import json
import logging
import time
import uuid

import websockets

from inference import stream_chat_completion
from gpu_monitor import get_gpu_info

logger = logging.getLogger("provider.ws_client")


class ProviderWSClient:
    """
    Persistent WebSocket client that connects a provider node to the
    central router. Handles registration, heartbeats, and inference
    request dispatch.
    """

    def __init__(self, llm, cfg, callbacks=None, node_id: str | None = None):
        """
        Args:
            llm: A Llama model instance (real or mock).
            cfg: Config object with router_ws_url, port, etc.
            callbacks: Optional TUI callback object with on_connected, etc.
            node_id: Unique identifier for this node. Auto-generated if None.
        """
        self.llm = llm
        self.cfg = cfg
        self.node_id = node_id or cfg.node_id or f"node-{uuid.uuid4().hex[:8]}"
        self.ws = None
        self.status = "idle"
        self._running = True
        self._reconnect_attempt = 0
        self._active_request_id = None
        self._callbacks = callbacks

    # ──────────────────────────────────────────
    # Callbacks
    # ──────────────────────────────────────────

    def _cb(self, method, *args):
        """Safely invoke a TUI callback."""
        if self._callbacks and hasattr(self._callbacks, method):
            try:
                getattr(self._callbacks, method)(*args)
            except Exception:
                pass

    # ──────────────────────────────────────────
    # Connection Lifecycle
    # ──────────────────────────────────────────

    async def run(self):
        """
        Main loop: connect to router, handle messages, reconnect on failure.
        Runs indefinitely until stopped.
        """
        logger.info(f"Provider Node [{self.node_id}] starting")
        logger.info(f"Router URL: {self.cfg.router_ws_url}")

        while self._running:
            try:
                await self._connect_and_serve()
            except (
                websockets.exceptions.ConnectionClosed,
                websockets.exceptions.ConnectionClosedError,
                ConnectionRefusedError,
                OSError,
            ) as e:
                if not self._running:
                    break
                self._cb("on_disconnected")
                delay = self._backoff_delay()
                self._cb("on_error",
                    f"Connection lost ({type(e).__name__}). Reconnecting in {delay:.0f}s...")
                logger.warning(
                    f"Connection lost ({type(e).__name__}: {e}). "
                    f"Reconnecting in {delay:.1f}s... "
                    f"(attempt {self._reconnect_attempt})"
                )
                await asyncio.sleep(delay)
            except Exception as e:
                if not self._running:
                    break
                self._cb("on_disconnected")
                delay = self._backoff_delay()
                self._cb("on_error", f"Unexpected error: {e}")
                logger.error(
                    f"Unexpected error: {e}. "
                    f"Reconnecting in {delay:.1f}s..."
                )
                await asyncio.sleep(delay)

        logger.info(f"Provider Node [{self.node_id}] stopped")

    async def _connect_and_serve(self):
        """Establish connection, register, and enter message loop."""
        logger.info(f"Connecting to router: {self.cfg.router_ws_url}")

        async with websockets.connect(
            self.cfg.router_ws_url,
            ping_interval=20,
            ping_timeout=10,
            close_timeout=5,
        ) as ws:
            self.ws = ws
            self._reconnect_attempt = 0
            logger.info("Connected to router ✓")
            self._cb("on_connected")

            # Send registration
            await self._send_register()
            self._cb("on_registered", self.node_id)

            # Run heartbeat and message handler concurrently
            heartbeat_task = asyncio.create_task(self._heartbeat_loop())
            try:
                await self._message_loop()
            finally:
                heartbeat_task.cancel()
                try:
                    await heartbeat_task
                except asyncio.CancelledError:
                    pass
                self.ws = None
                self._cb("on_disconnected")

    def _backoff_delay(self) -> float:
        """Calculate exponential backoff delay."""
        self._reconnect_attempt += 1
        delay = min(
            2.0 * (2 ** (self._reconnect_attempt - 1)),
            60.0,
        )
        return delay

    async def stop(self):
        """Gracefully shut down the client."""
        logger.info("Shutting down provider node...")
        self._running = False
        if self.ws:
            await self.ws.close()

    # ──────────────────────────────────────────
    # Registration & Heartbeats
    # ──────────────────────────────────────────

    async def _send_register(self):
        """Send registration message to the router."""
        gpu = get_gpu_info()
        msg = {
            "type": "register",
            "node_id": self.node_id,
            "model": self.cfg.model_name if hasattr(self.cfg, 'model_name') else "llama-3-8b",
            "vram_free_mb": gpu.vram_free_mb,
            "port": self.cfg.port,
        }
        await self.ws.send(json.dumps(msg))
        logger.info(f"Registered with router as [{self.node_id}]")

    async def _heartbeat_loop(self):
        """Send heartbeat pings to the router at regular intervals."""
        interval = getattr(self.cfg, 'heartbeat_interval', 5)
        while self._running:
            try:
                await asyncio.sleep(interval)
                if self.ws:
                    await self._send_heartbeat()
            except (
                websockets.exceptions.ConnectionClosed,
                asyncio.CancelledError,
            ):
                break
            except Exception as e:
                logger.warning(f"Heartbeat error: {e}")

    async def _send_heartbeat(self):
        """Send a single heartbeat ping."""
        if self.ws:
            gpu = get_gpu_info()
            msg = {
                "type": "heartbeat",
                "node_id": self.node_id,
                "status": self.status,
                "model": getattr(self.cfg, 'model_name', 'llama-3-8b'),
                "vram_free_mb": gpu.vram_free_mb,
            }
            await self.ws.send(json.dumps(msg))
            logger.debug(f"Heartbeat sent (status={self.status})")

    # ──────────────────────────────────────────
    # Message Handling
    # ──────────────────────────────────────────

    async def _message_loop(self):
        """Listen for messages from the router and dispatch handlers."""
        async for raw_msg in self.ws:
            try:
                msg = json.loads(raw_msg)
                msg_type = msg.get("type")

                if msg_type == "inference_request":
                    # Run inference in background so we can still receive control messages
                    asyncio.create_task(self._handle_inference(msg))
                elif msg_type == "switch_model":
                    asyncio.create_task(self._handle_switch_model(msg))
                elif msg_type == "ping":
                    # Router-initiated ping — respond with pong
                    await self.ws.send(json.dumps({"type": "pong", "node_id": self.node_id}))
                elif msg_type == "cancel":
                    logger.info(f"Received cancel for request {msg.get('request_id')}")
                elif msg_type == "register_ack":
                    pass # Ignore ack message without warning
                else:
                    logger.warning(f"Unknown message type: {msg_type}")

            except json.JSONDecodeError:
                logger.warning(f"Received non-JSON message: {raw_msg[:100]}")
            except Exception as e:
                logger.error(f"Error processing message: {e}")

    async def _handle_switch_model(self, msg: dict):
        new_model = msg.get("model")
        if not new_model or new_model == getattr(self.cfg, "model_name", "llama-3-8b"):
            return
            
        logger.info(f"Switching model to {new_model}...")
        self.status = "loading"
        self._cb("on_model_switch_start", new_model)
        
        try:
            # Run model loading in a thread to avoid blocking the asyncio event loop
            import concurrent.futures
            from model_loader import auto_download_model, load_model, get_mock_model
            
            loop = asyncio.get_running_loop()
            
            if getattr(self.cfg, "mock_mode", False):
                new_llm = get_mock_model()
            else:
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    # Download might take a while, offload it
                    model_path = await loop.run_in_executor(pool, auto_download_model, new_model)
                    new_llm = await loop.run_in_executor(
                        pool, load_model, model_path, self.cfg.n_gpu_layers, self.cfg.n_ctx
                    )
            
            # Switch successful
            self.llm = new_llm
            self.cfg.model_name = new_model
            logger.info(f"Successfully switched to {new_model}")
            self._cb("on_model_switch_complete", new_model)
            
            # Immediately send a heartbeat to notify router we are ready
            await self._send_heartbeat()
            
        except Exception as e:
            logger.error(f"Failed to switch to {new_model}: {e}")
            self._cb("on_error", f"Model switch failed: {e}")
        finally:
            # Revert to idle (or stay busy if a request somehow slipped in, though unlikely)
            if self.status == "loading":
                self.status = "idle"

    async def _handle_inference(self, msg: dict):
        """
        Handle an inference request from the router.

        1. Mark self as busy
        2. Run streaming inference
        3. Send each token chunk back to the router
        4. Send completion signal
        5. Mark self as idle
        """
        request_id = msg.get("request_id", f"req-{uuid.uuid4().hex[:8]}")
        messages = msg.get("messages", [])

        logger.info(f"[{request_id}] Inference request received ({len(messages)} messages)")

        self.status = "busy"
        self._active_request_id = request_id
        self._cb("on_inference_start", request_id)

        start_time = time.monotonic()
        token_count = 0

        try:
            # Stream tokens back to router
            async for chunk in stream_chat_completion(self.llm, messages, request_id):
                if not self.ws:
                    logger.error(f"[{request_id}] WebSocket closed mid-inference")
                    return

                token_count += 1
                response = {
                    "type": "inference_chunk",
                    "request_id": request_id,
                    "chunk": chunk,
                }
                await self.ws.send(json.dumps(response))

            # Signal completion
            await self.ws.send(json.dumps({
                "type": "inference_done",
                "request_id": request_id,
            }))

            latency_ms = int((time.monotonic() - start_time) * 1000)
            logger.info(f"[{request_id}] Inference complete, {token_count} tokens in {latency_ms}ms")
            self._cb("on_inference_complete", request_id, token_count, latency_ms)

        except Exception as e:
            logger.error(f"[{request_id}] Inference failed: {e}")
            self._cb("on_error", f"Inference failed: {e}")
            try:
                if self.ws:
                    await self.ws.send(json.dumps({
                        "type": "inference_error",
                        "request_id": request_id,
                        "error": str(e),
                    }))
            except Exception:
                pass

        finally:
            self.status = "idle"
            self._active_request_id = None


# ──────────────────────────────────────────
# Factory function for TUI integration
# ──────────────────────────────────────────

async def create_ws_client(cfg, model, callbacks=None):
    """
    Create and run a WebSocket client with optional TUI callbacks.

    Args:
        cfg: Config object with router_ws_url, port, node_id, etc.
        model: Llama model instance.
        callbacks: Optional object with on_connected, on_disconnected, etc.
    """
    client = ProviderWSClient(
        llm=model,
        cfg=cfg,
        callbacks=callbacks,
        node_id=getattr(cfg, 'node_id', None),
    )
    await client.run()
