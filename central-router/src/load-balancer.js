/**
 * Load Balancer — Selects provider nodes for inference requests.
 *
 * Strategy (MVP): First-available idle node for the requested model.
 * Future: Round-robin, least-connections, latency-weighted, VRAM-aware.
 */

const { createLogger } = require("./logger");
const registry = require("./registry");

const log = createLogger("load-balancer");

/**
 * Acquire an idle node for the given model.
 *
 * Marks the node as "busy" before returning it so no other request
 * can grab it in a race condition.
 *
 * @param {string} model — Model name (e.g. "llama-3-8b")
 * @returns {{ node: object, error: null } | { node: null, error: string }}
 */
async function acquireNode(model) {
  const node = await registry.getIdleNode(model);

  if (!node) {
    const counts = await registry.getNodeCounts();

    // Provide a descriptive error depending on the situation
    if (counts.total === 0) {
      log.warn("No provider nodes connected");
      return {
        node: null,
        error: "No provider nodes are currently connected to the network.",
      };
    }

    // Nodes exist but all are busy
    const idleForModel = await registry.getAllIdleNodes(model);
    if (idleForModel.length === 0 && counts.busy > 0) {
      log.warn(`All nodes busy — cannot serve model "${model}"`, {
        total: counts.total,
        busy: counts.busy,
      });
      return {
        node: null,
        error: `All ${counts.total} node(s) are currently busy. Please retry shortly.`,
      };
    }

    // Nodes exist but none have the requested model
    const anyIdleNode = await registry.getAnyIdleNode();
    if (anyIdleNode) {
      log.info(`Found idle node [${anyIdleNode.nodeId}] to repurpose for model "${model}"`);
      await registry.markBusy(anyIdleNode.nodeId);
      return { node: anyIdleNode, error: null, switch_needed: true };
    }

    log.warn(`No nodes with model "${model}" available, and no idle nodes to repurpose`, {
      total: counts.total,
    });
    return {
      node: null,
      error: `No provider nodes have model "${model}" loaded, and none are free to switch. Available nodes: ${counts.total}`,
    };
  }

  // Mark busy immediately to prevent double-assignment
  await registry.markBusy(node.nodeId);

  log.info(`Acquired node [${node.nodeId}] for model "${model}"`, {
    vram: `${node.vramFreeMb}MB`,
  });

  return { node, error: null };
}

/**
 * Release a node back to idle status.
 *
 * @param {string} nodeId
 */
async function releaseNode(nodeId) {
  await registry.markIdle(nodeId);
  log.info(`Released node [${nodeId}] → IDLE`);
}

module.exports = { acquireNode, releaseNode };
