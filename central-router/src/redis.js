const Redis = require("ioredis");
const { createLogger } = require("./logger");

const log = createLogger("redis");

const REDIS_URL = process.env.REDIS_URL || null;

let redisClient = null;
let isRedisEnabled = false;

if (REDIS_URL) {
  // Use a short timeout for local development testing
  redisClient = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
  });
  isRedisEnabled = true;

  redisClient.on("connect", () => log.info("Connected to Redis State Store"));
  redisClient.on("error", (err) => log.error(`Redis Error: ${err.message}`));
} else {
  log.warn("REDIS_URL not set. State will not persist across restarts.");
}

// ──────────────────────────────────────────────
// Node State Helpers
// ──────────────────────────────────────────────

/**
 * Register or update a node's metadata in Redis.
 * @param {string} nodeId
 * @param {Object} metadata
 */
async function setNodeState(nodeId, metadata) {
  if (!isRedisEnabled) return;
  // Store node metadata as a JSON string in a Hash
  await redisClient.hset("p2p:nodes:metadata", nodeId, JSON.stringify(metadata));
  // Add to active set to track online nodes
  await redisClient.sadd("p2p:nodes:active", nodeId);
}

/**
 * Mark a node as offline/disconnected.
 * @param {string} nodeId
 */
async function removeNodeState(nodeId) {
  if (!isRedisEnabled) return;
  await redisClient.hdel("p2p:nodes:metadata", nodeId);
  await redisClient.srem("p2p:nodes:active", nodeId);
  await redisClient.hdel("p2p:nodes:routing", nodeId);
}

/**
 * Update the specific Router IP/ID that holds the WebSocket for a node.
 * This is crucial for Nginx Layer 7 Load Balancing.
 * @param {string} nodeId
 * @param {string} routerIp
 */
async function setNodeRouting(nodeId, routerIp) {
  if (!isRedisEnabled) return;
  await redisClient.hset("p2p:nodes:routing", nodeId, routerIp);
}

/**
 * Retrieve all currently active nodes and their metadata.
 * @returns {Promise<Array<Object>>}
 */
async function getAllNodes() {
  if (!isRedisEnabled) return [];
  const activeIds = await redisClient.smembers("p2p:nodes:active");
  if (activeIds.length === 0) return [];

  const rawMetadata = await redisClient.hmget("p2p:nodes:metadata", ...activeIds);
  return rawMetadata.filter(Boolean).map(raw => JSON.parse(raw));
}

/**
 * Retrieve routing info for a specific node.
 * @returns {Promise<string|null>} The router IP/ID holding the WS connection.
 */
async function getNodeRouting(nodeId) {
  if (!isRedisEnabled) return null;
  return await redisClient.hget("p2p:nodes:routing", nodeId);
}

module.exports = {
  redisClient,
  isRedisEnabled,
  setNodeState,
  removeNodeState,
  setNodeRouting,
  getAllNodes,
  getNodeRouting,
};
