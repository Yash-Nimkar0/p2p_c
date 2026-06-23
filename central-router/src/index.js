/**
 * Central Router — Server Entry Point
 *
 * Boots the HTTP + WebSocket server for the P2P GPU Inference Network.
 * This is the single process that:
 *   1. Serves the landing page and admin dashboard (static files)
 *   2. Enforces API key authentication and rate limiting
 *   3. Accepts WebSocket connections from Provider Nodes (/provider)
 *   4. Runs the heartbeat monitor to evict stale nodes
 *   5. Exposes the OpenAI-compatible API Gateway with failover
 *   6. Provides API key management and stats endpoints
 *
 * Usage:
 *   npm start          — Start on default port 3000
 *   PORT=8080 npm start — Start on custom port
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http = require("http");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const { createLogger } = require("./logger");
const registry = require("./registry");
const loadBalancer = require("./load-balancer");
const verifier = require("./verifier");
const db = require("./db");
const wsHandler = require("./ws-handler");
const gateway = require("./gateway");
const apiKeys = require("./api-keys");
const apiStats = require("./api-stats");
const { authMiddleware } = require("./auth");
const { rateLimiterMiddleware } = require("./rate-limiter");

const log = createLogger("server");

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10);

// ──────────────────────────────────────────────
// Express App
// ──────────────────────────────────────────────

const app = express();

// ── Security middleware ──
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// ── CORS — allow API calls from any origin ──
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "X-Admin-Secret"],
  })
);

// ── Body parsing ──
app.use(express.json());

// ── Serve static files (landing page + dashboard) ──
app.use(express.static(path.join(__dirname, "..", "public")));

// ── Auth middleware (skips public routes) ──
app.use(authMiddleware);

// ── Rate limiting (per API key) ──
app.use(rateLimiterMiddleware);

// ──────────────────────────────────────────────
// Public Routes (no auth required)
// ──────────────────────────────────────────────

// Health check
app.get("/health", async (req, res) => {
  const counts = await registry.getNodeCounts();
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    nodes: counts,
  });
});

// List active nodes (monitoring)
app.get("/dashboard/api/status", async (req, res) => {
  res.json({
    nodes: await registry.getActiveNodes(),
    counts: await registry.getNodeCounts(),
  });
});

// ──────────────────────────────────────────────
// Internal Edge Routing (Nginx -> Node)
// ──────────────────────────────────────────────

// Nginx calls this to allocate an idle node for a model before proxying
app.get("/internal/allocate", async (req, res) => {
  const model = req.query.model || "llama-3-8b";
  const { acquireOrQueue } = require("./queue");
  
  // This might take a few seconds if it hits the queue, but Nginx will wait.
  const { node, error } = await acquireOrQueue(model);
  
  if (!node) {
    return res.status(503).json({ error });
  }

  // Look up the specific router IP from Redis
  const routerIp = await registry.getNodeRouting(node.nodeId);
  
  if (!routerIp) {
    // Edge case: Node disconnected right after allocation
    const loadBalancer = require("./load-balancer");
    await loadBalancer.releaseNode(node.nodeId);
    return res.status(503).json({ error: "Node disconnected during allocation" });
  }

  res.json({
    nodeId: node.nodeId,
    routerIp: routerIp
  });
});

// ──────────────────────────────────────────────
// API Routes
// ──────────────────────────────────────────────

// API key management
app.use(apiKeys);

// Dashboard stats
app.use(apiStats);

// OpenAI-compatible API Gateway (auth + rate limited)
app.use(gateway);

// ── SPA fallback for dashboard ──
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "dashboard.html"));
});

// ──────────────────────────────────────────────
// HTTP + WebSocket Server
// ──────────────────────────────────────────────

const server = http.createServer(app);

// Attach WebSocket server for provider connections
wsHandler.attachWebSocketServer(server);

// Start heartbeat monitor
registry.startHeartbeatMonitor();
verifier.startVerificationDispatcher();

// ──────────────────────────────────────────────
// Start Listening
// ──────────────────────────────────────────────

server.listen(PORT, () => {
  log.info("═".repeat(56));
  log.info("  P2P GPU Inference Network — Central Router");
  log.info("═".repeat(56));
  log.info(`  Landing Page: http://localhost:${PORT}`);
  log.info(`  Dashboard:    http://localhost:${PORT}/dashboard`);
  log.info(`  Inference:    http://localhost:${PORT}/v1/chat/completions`);
  log.info(`  Models:       http://localhost:${PORT}/v1/models`);
  log.info(`  WS Provider:  ws://localhost:${PORT}/provider`);
  log.info(`  Health:       http://localhost:${PORT}/health`);
  log.info(`  API Keys:     http://localhost:${PORT}/api/keys`);
  log.info("═".repeat(56));
});

// ──────────────────────────────────────────────
// Graceful Shutdown
// ──────────────────────────────────────────────

function shutdown(signal) {
  log.info(`Received ${signal}, shutting down...`);
  registry.stopHeartbeatMonitor();
  verifier.stopVerificationDispatcher();
  server.close(() => {
    log.info("Server closed");
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = { app, server };
