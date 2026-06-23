/**
 * Registry — Hybrid State Manager.
 *
 * Tracks local WebSocket connections in memory, but synchronizes all node metadata
 * (model, status, vram, etc.) to Redis for global horizontal scaling.
 */

const { createLogger } = require("./logger");
const redis = require("./redis");

const log = createLogger("registry");

const HEARTBEAT_CHECK_INTERVAL = parseInt(process.env.HEARTBEAT_CHECK_MS || "5000", 10);
const HEARTBEAT_TIMEOUT = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || "15000", 10);

/**
 * Local memory map exclusively for holding WebSocket references.
 * @type {Map<string, { ws: WebSocket, lastHeartbeat: Date }>}
 */
const localConnections = new Map();

let heartbeatMonitorHandle = null;

// Use our own host IP or container ID for Nginx to route back to us
// In Docker, hostname is the container ID.
const ROUTER_IP = process.env.HOSTNAME || "localhost"; 

/**
 * Register a new provider node.
 */
async function registerNode(nodeId, ws, metadata = {}) {
  // 1. Store WebSocket locally
  localConnections.set(nodeId, { ws, lastHeartbeat: new Date() });

  // 2. Sync Metadata to Redis
  const info = {
    nodeId,
    model: metadata.model || "unknown",
    status: "idle",
    vramFreeMb: metadata.vramFreeMb ?? metadata.vram_free_mb ?? 0,
    registeredAt: new Date().toISOString(),
    port: metadata.port || 0,
  };

  await redis.setNodeState(nodeId, info);
  await redis.setNodeRouting(nodeId, ROUTER_IP);

  log.info(`Node registered globally: [${nodeId}]`, {
    model: info.model,
    vram: `${info.vramFreeMb}MB`,
  });
}

/**
 * Remove a provider node.
 */
async function removeNode(nodeId, reason = "unknown") {
  localConnections.delete(nodeId);
  await redis.removeNodeState(nodeId);
  log.warn(`Node removed globally: [${nodeId}]`, { reason });
}

/**
 * Mark a node as busy.
 */
async function markBusy(nodeId) {
  const nodes = await redis.getAllNodes();
  const node = nodes.find(n => n.nodeId === nodeId);
  if (node) {
    node.status = "busy";
    await redis.setNodeState(nodeId, node);
    log.debug(`Node [${nodeId}] → BUSY`);
  }
}

/**
 * Mark a node as idle.
 */
async function markIdle(nodeId) {
  const nodes = await redis.getAllNodes();
  const node = nodes.find(n => n.nodeId === nodeId);
  if (node) {
    node.status = "idle";
    await redis.setNodeState(nodeId, node);
    log.debug(`Node [${nodeId}] → IDLE`);
  }
}

/**
 * Update heartbeat timestamp and optional metadata.
 */
async function updateHeartbeat(nodeId, metadata = {}) {
  const local = localConnections.get(nodeId);
  if (!local) {
    log.warn(`Heartbeat from unknown node [${nodeId}]`);
    return;
  }
  
  // Update local memory timestamp for eviction
  local.lastHeartbeat = new Date();

  // If metadata changed, sync to Redis
  if (metadata.status || metadata.model || metadata.vram_free_mb !== undefined) {
    const nodes = await redis.getAllNodes();
    const node = nodes.find(n => n.nodeId === nodeId);
    if (node) {
      if (metadata.status) node.status = metadata.status;
      if (metadata.model) node.model = metadata.model;
      if (metadata.vram_free_mb !== undefined) node.vramFreeMb = metadata.vram_free_mb;
      await redis.setNodeState(nodeId, node);
    }
  }

  log.debug(`Heartbeat ♥ [${nodeId}]`);
}

/**
 * Get the first idle node globally that has a specific model loaded.
 */
async function getIdleNode(model) {
  const nodes = await redis.getAllNodes();
  return nodes.find(n => n.status === "idle" && n.model === model) || null;
}

/**
 * Get ANY idle node globally, regardless of the model loaded.
 */
async function getAnyIdleNode() {
  const nodes = await redis.getAllNodes();
  return nodes.find(n => n.status === "idle") || null;
}

/**
 * Get all idle nodes globally for a given model.
 */
async function getAllIdleNodes(model) {
  const nodes = await redis.getAllNodes();
  return nodes.filter(n => n.status === "idle" && n.model === model);
}

/**
 * Get a snapshot of all active nodes globally.
 */
async function getActiveNodes() {
  return await redis.getAllNodes();
}

/**
 * Get a specific node by ID.
 */
async function getNode(nodeId) {
  const nodes = await redis.getAllNodes();
  return nodes.find(n => n.nodeId === nodeId) || null;
}

/**
 * Get the local WebSocket connection (if it exists on this instance).
 */
function getLocalWs(nodeId) {
  const local = localConnections.get(nodeId);
  return local ? local.ws : null;
}

/**
 * Get global node counts.
 */
async function getNodeCounts() {
  const nodes = await redis.getAllNodes();
  let idle = 0;
  let busy = 0;
  for (const node of nodes) {
    if (node.status === "idle") idle++;
    else busy++;
  }
  return { total: nodes.length, idle, busy };
}

// ──────────────────────────────────────────────
// Heartbeat Monitor (Local Only)
// ──────────────────────────────────────────────

/**
 * The heartbeat monitor ONLY evicts local connections that drop.
 * If a local connection drops, we remove it from global Redis.
 */
function startHeartbeatMonitor() {
  if (heartbeatMonitorHandle) return; 

  log.info("Heartbeat monitor started (Local Connections)", {
    check_interval: `${HEARTBEAT_CHECK_INTERVAL}ms`,
    timeout: `${HEARTBEAT_TIMEOUT}ms`,
  });

  heartbeatMonitorHandle = setInterval(async () => {
    const now = Date.now();
    const staleIds = [];

    for (const [nodeId, local] of localConnections) {
      const elapsed = now - local.lastHeartbeat.getTime();
      if (elapsed > HEARTBEAT_TIMEOUT) {
        staleIds.push(nodeId);
      }
    }

    for (const nodeId of staleIds) {
      const local = localConnections.get(nodeId);
      if (local && local.ws) {
        try {
          local.ws.close(1001, "Heartbeat timeout");
        } catch (_) {}
      }
      await removeNode(nodeId, "heartbeat_timeout");
    }

    if (staleIds.length > 0) {
      log.warn(`Evicted ${staleIds.length} stale node(s)`);
    }
  }, HEARTBEAT_CHECK_INTERVAL);
}

function stopHeartbeatMonitor() {
  if (heartbeatMonitorHandle) {
    clearInterval(heartbeatMonitorHandle);
    heartbeatMonitorHandle = null;
    log.info("Heartbeat monitor stopped");
  }
}

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
  getLocalWs,
};
