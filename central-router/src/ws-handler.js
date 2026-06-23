/**
 * WebSocket Handler — Manages WebSocket connections from Provider Nodes.
 *
 * Mounted on the HTTP server at the `/provider` path. Handles:
 *   - Provider registration messages
 *   - Heartbeat pings
 *   - Inference response chunks streaming back from nodes
 *   - Node disconnect / error cleanup
 *
 * Emits events via an EventEmitter so the gateway can react to
 * inference chunks, completion signals, errors, and disconnects.
 */

const { WebSocketServer } = require("ws");
const { EventEmitter } = require("events");
const { createLogger } = require("./logger");
const registry = require("./registry");

const log = createLogger("ws-handler");

// ──────────────────────────────────────────────
// Event Bus
// ──────────────────────────────────────────────

/**
 * Central event emitter for inter-component communication.
 *
 * Events:
 *   "inference_chunk"  — { requestId, chunk }
 *   "inference_done"   — { requestId }
 *   "inference_error"  — { requestId, error, nodeId }
 *   "node_disconnect"  — { nodeId, activeRequestId }
 */
const events = new EventEmitter();
events.setMaxListeners(100); // Support many concurrent requests

// Track which request is active on which node
// Map<nodeId, requestId>
const activeRequests = new Map();

// Reverse map: Map<requestId, nodeId>
const requestToNode = new Map();

// ──────────────────────────────────────────────
// WebSocket Server Setup
// ──────────────────────────────────────────────

/**
 * Attach the WebSocket server to an existing HTTP server.
 *
 * Only accepts connections on the `/provider` path.
 *
 * @param {http.Server} server — The HTTP server instance
 */
function attachWebSocketServer(server) {
  const wss = new WebSocketServer({
    server,
    path: "/provider",
  });

  log.info("WebSocket server attached on /provider");

  wss.on("connection", (ws, req) => {
    const remoteAddr =
      req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    let nodeId = null;

    log.info(`New WebSocket connection from ${remoteAddr}`);

    // ── Message Handler ──
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        log.warn(`Non-JSON message from ${remoteAddr}: ${raw.toString().slice(0, 100)}`);
        return;
      }

      switch (msg.type) {
        // ────── Registration ──────
        case "register":
          nodeId = msg.node_id;
          if (!nodeId) {
            log.warn("Registration message missing node_id");
            ws.close(4001, "Missing node_id");
            return;
          }

          await registry.registerNode(nodeId, ws, {
            model: msg.model,
            vram_free_mb: msg.vram_free_mb,
            port: msg.port,
          });

          // Acknowledge registration
          ws.send(
            JSON.stringify({
              type: "register_ack",
              node_id: nodeId,
              message: "Registration successful",
            })
          );
          break;

        // ────── Heartbeat ──────
        case "heartbeat":
          if (!msg.node_id) return;
          nodeId = msg.node_id; // Update in case it wasn't set
          await registry.updateHeartbeat(msg.node_id, {
            status: msg.status,
            vram_free_mb: msg.vram_free_mb,
          });
          break;

        // ────── Inference Chunk ──────
        case "inference_chunk":
          if (msg.request_id && msg.chunk) {
            events.emit("inference_chunk", {
              requestId: msg.request_id,
              chunk: msg.chunk,
            });
          }
          break;

        // ────── Inference Done ──────
        case "inference_done":
          if (msg.request_id) {
            // Clean up tracking maps
            const completedNodeId = requestToNode.get(msg.request_id);
            if (completedNodeId) {
              activeRequests.delete(completedNodeId);
              requestToNode.delete(msg.request_id);
              await registry.markIdle(completedNodeId);
            }

            events.emit("inference_done", {
              requestId: msg.request_id,
            });

            log.info(`Inference complete for request [${msg.request_id}]`);
          }
          break;

        // ────── Inference Error ──────
        case "inference_error":
          if (msg.request_id) {
            const failedNodeId = requestToNode.get(msg.request_id);
            if (failedNodeId) {
              activeRequests.delete(failedNodeId);
              requestToNode.delete(msg.request_id);
              await registry.markIdle(failedNodeId);
            }

            events.emit("inference_error", {
              requestId: msg.request_id,
              error: msg.error || "Unknown inference error",
              nodeId: failedNodeId || nodeId,
            });

            log.error(`Inference error for request [${msg.request_id}]: ${msg.error}`);
          }
          break;

        // ────── Pong (response to router ping) ──────
        case "pong":
          // No-op, just confirms the node is alive
          break;

        default:
          log.warn(`Unknown message type: ${msg.type}`, { from: nodeId });
      }
    });

    // ── Connection Close ──
    ws.on("close", async (code, reason) => {
      const reasonStr = reason?.toString() || "unknown";
      log.warn(`WebSocket closed for node [${nodeId}]`, {
        code,
        reason: reasonStr,
      });

      if (nodeId) {
        // Check if this node had an active request
        const activeReqId = activeRequests.get(nodeId);
        if (activeReqId) {
          requestToNode.delete(activeReqId);
          activeRequests.delete(nodeId);

          // Notify the gateway about the disconnect mid-inference
          events.emit("node_disconnect", {
            nodeId,
            activeRequestId: activeReqId,
          });

          log.error(
            `Node [${nodeId}] disconnected during active request [${activeReqId}]`
          );
        }

        await registry.removeNode(nodeId, `ws_close(${code})`);
      }
    });

    // ── Connection Error ──
    ws.on("error", (err) => {
      log.error(`WebSocket error for node [${nodeId}]: ${err.message}`);
    });
  });

  return wss;
}

// ──────────────────────────────────────────────
// Send Inference Request to a Node
// ──────────────────────────────────────────────

/**
 * Send an inference request to a specific provider node via its WebSocket.
 *
 * @param {string} nodeId    — Target node ID
 * @param {string} requestId — Unique request ID for tracking
 * @param {Array}  messages  — OpenAI-format messages array
 * @returns {boolean} — true if sent successfully, false otherwise
 */
async function sendInferenceRequest(nodeId, requestId, messages) {
  const ws = registry.getLocalWs(nodeId);

  if (!ws || ws.readyState !== 1 /* OPEN */) {
    log.error(`Cannot send request to node [${nodeId}] — not connected`);
    return false;
  }

  const payload = JSON.stringify({
    type: "inference_request",
    request_id: requestId,
    messages,
  });

  try {
    ws.send(payload);

    // Track the active request
    activeRequests.set(nodeId, requestId);
    requestToNode.set(requestId, nodeId);

    log.info(`Inference request [${requestId}] sent to node [${nodeId}]`);
    return true;
  } catch (err) {
    log.error(`Failed to send request to node [${nodeId}]: ${err.message}`);
    return false;
  }
}

/**
 * Get the node ID handling a specific request.
 *
 * @param {string} requestId
 * @returns {string|undefined}
 */
function getNodeForRequest(requestId) {
  return requestToNode.get(requestId);
}

/**
 * Clean up tracking state for a request (used during failover).
 *
 * @param {string} requestId
 */
function clearRequestTracking(requestId) {
  const nodeId = requestToNode.get(requestId);
  if (nodeId) {
    activeRequests.delete(nodeId);
  }
  requestToNode.delete(requestId);
}

/**
 * Send a command to a node to switch its loaded model.
 *
 * @param {string} nodeId
 * @param {string} newModel
 */
async function sendSwitchModelCommand(nodeId, newModel) {
  const ws = registry.getLocalWs(nodeId);
  if (!ws || ws.readyState !== 1 /* OPEN */) {
    log.error(`Cannot send switch_model to node [${nodeId}] — not connected`);
    return false;
  }

  const payload = JSON.stringify({
    type: "switch_model",
    model: newModel,
  });

  try {
    node.ws.send(payload);
    log.info(`Sent switch_model ("${newModel}") command to node [${nodeId}]`);
    return true;
  } catch (err) {
    log.error(`Failed to send switch_model to node [${nodeId}]: ${err.message}`);
    return false;
  }
}

// ──────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────

module.exports = {
  attachWebSocketServer,
  sendInferenceRequest,
  sendSwitchModelCommand,
  getNodeForRequest,
  clearRequestTracking,
  events,
};
