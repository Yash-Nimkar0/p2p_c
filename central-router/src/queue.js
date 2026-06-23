/**
 * Request Queue — Smart queuing when all nodes are busy.
 *
 * Instead of returning 503 immediately, requests wait in a FIFO queue
 * for a node to become available. Requests timeout after QUEUE_TIMEOUT_MS.
 */

const { createLogger } = require("./logger");
const registry = require("./registry");
const loadBalancer = require("./load-balancer");
const wsHandler = require("./ws-handler");

const log = createLogger("queue");

const QUEUE_MAX_SIZE = parseInt(process.env.QUEUE_MAX_SIZE || "50", 10);
const QUEUE_TIMEOUT_MS = parseInt(process.env.QUEUE_TIMEOUT_MS || "30000", 10);

/**
 * @typedef {Object} QueuedRequest
 * @property {string} model
 * @property {Function} resolve — Resolves with the node when one becomes available
 * @property {number} enqueuedAt
 * @property {NodeJS.Timeout} timer
 */

/** @type {QueuedRequest[]} */
const queue = [];

/**
 * Try to acquire a node, or queue the request if all are busy.
 *
 * @param {string} model
 * @returns {Promise<{node: object|null, error: string|null, queued: boolean}>}
 */
function acquireOrQueue(model) {
  // Try to acquire using load balancer logic
  const { node, error, switch_needed } = loadBalancer.acquireNode(model);

  if (node && !switch_needed) {
    return Promise.resolve({ node, error: null, queued: false });
  }

  if (switch_needed) {
    // Send the command to the repurposed node to switch models
    wsHandler.sendSwitchModelCommand(node.nodeId, model);
    // Even though we found a node, we must queue the request until the node finishes loading
  }

  const counts = registry.getNodeCounts();

  // No nodes at all — don't queue, fail fast
  if (counts.total === 0) {
    return Promise.resolve({
      node: null,
      error: "No provider nodes are currently connected to the network.",
      queued: false,
    });
  }

  // Queue is full
  if (queue.length >= QUEUE_MAX_SIZE) {
    log.warn("Queue is full", { size: queue.length, max: QUEUE_MAX_SIZE });
    return Promise.resolve({
      node: null,
      error: `Server is at capacity (${queue.length} requests queued). Please retry later.`,
      queued: false,
    });
  }

  // Add to queue
  return new Promise((resolve) => {
    const entry = {
      model,
      enqueuedAt: Date.now(),
      resolve: null,
      timer: null,
    };

    // Timeout — give up waiting
    entry.timer = setTimeout(() => {
      const idx = queue.indexOf(entry);
      if (idx !== -1) {
        queue.splice(idx, 1);
      }
      log.warn("Queued request timed out", {
        position: idx,
        waited: `${QUEUE_TIMEOUT_MS}ms`,
      });
      resolve({
        node: null,
        error: `Request timed out after ${QUEUE_TIMEOUT_MS / 1000}s in queue (position ${idx + 1}).`,
        queued: true,
      });
    }, QUEUE_TIMEOUT_MS);

    entry.resolve = (node) => {
      clearTimeout(entry.timer);
      resolve({ node, error: null, queued: true });
    };

    queue.push(entry);

    const position = queue.length;
    log.info(`Request queued at position ${position}`, {
      model,
      queue_size: position,
    });
  });
}

/**
 * Called when a node becomes idle — try to dequeue and serve the next request.
 * Should be called whenever a node finishes an inference.
 *
 * @param {string} model — The model the node has loaded
 */
function tryDequeue(model) {
  if (queue.length === 0) return;

  // Find next matching queued request
  const idx = queue.findIndex((entry) => entry.model === model);
  if (idx === -1) return;

  // Get an idle node
  const node = registry.getIdleNode(model);
  if (!node) return;

  // Dequeue and serve
  const entry = queue.splice(idx, 1)[0];
  registry.markBusy(node.nodeId);

  const waited = Date.now() - entry.enqueuedAt;
  log.info(`Dequeued request, waited ${waited}ms`, {
    node: node.nodeId,
    remaining: queue.length,
  });

  entry.resolve(node);
}

/**
 * Get current queue status.
 */
function getQueueStatus() {
  return {
    size: queue.length,
    maxSize: QUEUE_MAX_SIZE,
    timeoutMs: QUEUE_TIMEOUT_MS,
  };
}

module.exports = { acquireOrQueue, tryDequeue, getQueueStatus };
