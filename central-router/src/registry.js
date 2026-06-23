/**
 * Registry — In-memory registry of active Provider Nodes.
 *
 * Tracks every connected GPU provider: its WebSocket connection, loaded model,
 * busy/idle status, VRAM, and last heartbeat timestamp.
 *
 * The heartbeat monitor runs on a configurable interval and evicts nodes
 * that miss two consecutive heartbeats.
 */

const { createLogger } = require("./logger");
const log = createLogger("registry");

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

/** Heartbeat check interval in ms (default: 5 seconds) */
const HEARTBEAT_CHECK_INTERVAL = parseInt(process.env.HEARTBEAT_CHECK_MS || "5000", 10);

/** Maximum time since last heartbeat before a node is evicted (default: 15s = 3 missed beats) */
const HEARTBEAT_TIMEOUT = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || "15000", 10);

// ──────────────────────────────────────────────
// Node Registry (Map<nodeId, NodeInfo>)
// ──────────────────────────────────────────────

/**
 * @typedef {Object} NodeInfo
 * @property {string}    nodeId        — Unique node identifier
 * @property {WebSocket} ws            — Live WebSocket connection
 * @property {string}    model         — Model loaded on this node (e.g. "llama-3-8b")
 * @property {"idle"|"busy"} status    — Current processing status
 * @property {number}    vramFreeMb    — Free VRAM in MB (self-reported)
 * @property {Date}      lastHeartbeat — Timestamp of last heartbeat
 * @property {Date}      registeredAt  — Timestamp of initial registration
 * @property {number}    port          — Port the node identified itself with
 */

/** @type {Map<string, NodeInfo>} */
const nodes = new Map();

/** Handle for the heartbeat monitor interval */
let heartbeatMonitorHandle = null;

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Register a new provider node.
 *
 * @param {string}    nodeId   — Unique node ID
 * @param {WebSocket} ws       — The node's WebSocket connection
 * @param {object}    metadata — { model, vramFreeMb, port }
 */
function registerNode(nodeId, ws, metadata = {}) {
  const info = {
    nodeId,
    ws,
    model: metadata.model || "unknown",
    status: "idle",
    vramFreeMb: metadata.vramFreeMb ?? metadata.vram_free_mb ?? 0,
    lastHeartbeat: new Date(),
    registeredAt: new Date(),
    port: metadata.port || 0,
  };

  nodes.set(nodeId, info);

  log.info(`Node registered: [${nodeId}]`, {
    model: info.model,
    vram: `${info.vramFreeMb}MB`,
    total_nodes: nodes.size,
  });
}

/**
 * Remove a provider node from the registry.
 *
 * @param {string} nodeId
 * @param {string} [reason="unknown"] — Reason for removal (for logging)
 */
function removeNode(nodeId, reason = "unknown") {
  if (!nodes.has(nodeId)) return;

  nodes.delete(nodeId);

  log.warn(`Node removed: [${nodeId}]`, {
    reason,
    remaining_nodes: nodes.size,
  });
}

/**
 * Get the first idle node that has a specific model loaded.
 *
 * @param {string} model — Model name to match (e.g. "llama-3-8b")
 * @returns {NodeInfo|null} — The idle node, or null if none available
 */
function getIdleNode(model) {
  for (const [, node] of nodes) {
    if (node.status === "idle" && node.model === model) {
      return node;
    }
  }
  return null;
}

/**
 * Get ANY idle node, regardless of the model loaded.
 * Useful for telling a node to switch to a new model.
 *
 * @returns {NodeInfo|null}
 */
function getAnyIdleNode() {
  for (const [, node] of nodes) {
    if (node.status === "idle") {
      return node;
    }
  }
  return null;
}

/**
 * Get all idle nodes for a given model.
 *
 * @param {string} model
 * @returns {NodeInfo[]}
 */
function getAllIdleNodes(model) {
  const idle = [];
  for (const [, node] of nodes) {
    if (node.status === "idle" && node.model === model) {
      idle.push(node);
    }
  }
  return idle;
}

/**
 * Mark a node as busy (currently processing an inference request).
 *
 * @param {string} nodeId
 */
function markBusy(nodeId) {
  const node = nodes.get(nodeId);
  if (node) {
    node.status = "busy";
    log.debug(`Node [${nodeId}] → BUSY`);
  }
}

/**
 * Mark a node as idle (available for inference).
 *
 * @param {string} nodeId
 */
function markIdle(nodeId) {
  const node = nodes.get(nodeId);
  if (node) {
    node.status = "idle";
    log.debug(`Node [${nodeId}] → IDLE`);
  }
}

/**
 * Update heartbeat timestamp and optional metadata for a node.
 *
 * @param {string} nodeId
 * @param {object} [metadata] — Optional fields to update (status, vramFreeMb)
 */
function updateHeartbeat(nodeId, metadata = {}) {
  const node = nodes.get(nodeId);
  if (!node) {
    log.warn(`Heartbeat from unknown node [${nodeId}]`);
    return;
  }

  node.lastHeartbeat = new Date();

  if (metadata.status) node.status = metadata.status;
  if (metadata.model) node.model = metadata.model;
  if (metadata.vram_free_mb !== undefined) node.vramFreeMb = metadata.vram_free_mb;
  if (metadata.vramFreeMb !== undefined) node.vramFreeMb = metadata.vramFreeMb;

  log.debug(`Heartbeat ♥ [${nodeId}]`, {
    status: node.status,
    vram: `${node.vramFreeMb}MB`,
  });
}

/**
 * Get a node by its ID.
 *
 * @param {string} nodeId
 * @returns {NodeInfo|undefined}
 */
function getNode(nodeId) {
  return nodes.get(nodeId);
}

/**
 * Get a snapshot of all active nodes (for monitoring / health checks).
 *
 * @returns {object[]} — Array of node info objects (without WS reference)
 */
function getActiveNodes() {
  const result = [];
  for (const [, node] of nodes) {
    result.push({
      nodeId: node.nodeId,
      model: node.model,
      status: node.status,
      vramFreeMb: node.vramFreeMb,
      lastHeartbeat: node.lastHeartbeat.toISOString(),
      registeredAt: node.registeredAt.toISOString(),
      port: node.port,
    });
  }
  return result;
}

/**
 * Get a count of nodes by status.
 *
 * @returns {{ total: number, idle: number, busy: number }}
 */
function getNodeCounts() {
  let idle = 0;
  let busy = 0;
  for (const [, node] of nodes) {
    if (node.status === "idle") idle++;
    else busy++;
  }
  return { total: nodes.size, idle, busy };
}

// ──────────────────────────────────────────────
// Heartbeat Monitor
// ──────────────────────────────────────────────

/**
 * Start the heartbeat monitor that evicts stale nodes.
 * Runs every HEARTBEAT_CHECK_INTERVAL ms and removes nodes
 * whose last heartbeat exceeds HEARTBEAT_TIMEOUT.
 */
function startHeartbeatMonitor() {
  if (heartbeatMonitorHandle) return; // Already running

  log.info("Heartbeat monitor started", {
    check_interval: `${HEARTBEAT_CHECK_INTERVAL}ms`,
    timeout: `${HEARTBEAT_TIMEOUT}ms`,
  });

  heartbeatMonitorHandle = setInterval(() => {
    const now = Date.now();
    const staleIds = [];

    for (const [nodeId, node] of nodes) {
      const elapsed = now - node.lastHeartbeat.getTime();
      if (elapsed > HEARTBEAT_TIMEOUT) {
        staleIds.push(nodeId);
      }
    }

    for (const nodeId of staleIds) {
      const node = nodes.get(nodeId);
      if (node && node.ws) {
        try {
          node.ws.close(1001, "Heartbeat timeout");
        } catch (_) {
          // Ignore close errors
        }
      }
      removeNode(nodeId, "heartbeat_timeout");
    }

    if (staleIds.length > 0) {
      log.warn(`Evicted ${staleIds.length} stale node(s)`, {
        evicted: staleIds,
      });
    }
  }, HEARTBEAT_CHECK_INTERVAL);
}

/**
 * Stop the heartbeat monitor.
 */
function stopHeartbeatMonitor() {
  if (heartbeatMonitorHandle) {
    clearInterval(heartbeatMonitorHandle);
    heartbeatMonitorHandle = null;
    log.info("Heartbeat monitor stopped");
  }
}

// ──────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────

module.exports = {
  registerNode,
  removeNode,
  getIdleNode,
  getAnyIdleNode,
  getAllIdleNodes,
  markBusy,
  markIdle,
  updateHeartbeat,
  getNode,
  getActiveNodes,
  getNodeCounts,
  startHeartbeatMonitor,
  stopHeartbeatMonitor,
};
