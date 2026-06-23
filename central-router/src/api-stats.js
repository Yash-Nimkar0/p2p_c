/**
 * API Stats — REST endpoints for the admin dashboard.
 *
 * Provides real-time network statistics, node info, and usage data.
 */

const express = require("express");
const { createLogger } = require("./logger");
const registry = require("./registry");
const { getQueueStatus } = require("./queue");
const db = require("./db");

const log = createLogger("api-stats");
const router = express.Router();

// GET /api/stats — Overall network statistics
router.get("/api/stats", (req, res) => {
  const nodeCounts = registry.getNodeCounts();
  const queueStatus = getQueueStatus();
  const networkStats = db.getNetworkStats();

  res.json({
    network: {
      nodes: nodeCounts,
      queue: queueStatus,
      uptime: Math.floor(process.uptime()),
    },
    stats: {
      totalRequests: networkStats.totalRequests,
      todayRequests: networkStats.todayRequests,
      totalTokens: networkStats.totalTokens,
      avgLatency: networkStats.avgLatency,
      activeKeys: networkStats.activeKeys,
    },
    hourlyStats: networkStats.hourlyStats,
  });
});

// GET /api/stats/nodes — Detailed node information
router.get("/api/stats/nodes", (req, res) => {
  const nodes = registry.getActiveNodes();
  res.json({ nodes, total: nodes.length });
});

// GET /api/stats/requests — Recent requests feed
router.get("/api/stats/requests", (req, res) => {
  const networkStats = db.getNetworkStats();
  res.json({ requests: networkStats.recentRequests });
});

module.exports = router;
