/**
 * API Key Management — REST endpoints for creating and managing API keys.
 *
 * Endpoints:
 *   POST /api/keys/create  — Create a new key (public, from landing page)
 *   GET  /api/keys         — List all keys (admin)
 *   DELETE /api/keys/:id   — Revoke a key (admin)
 *   GET /api/keys/:id/usage — Usage stats for a key (admin)
 */

const express = require("express");
const { createLogger } = require("./logger");
const { adminAuthMiddleware } = require("./auth");
const db = require("./db");

const log = createLogger("api-keys");
const router = express.Router();

// ──────────────────────────────────────────────
// POST /api/keys/create — Create a new API key
// Public endpoint (used by the landing page signup form)
// ──────────────────────────────────────────────

router.post("/api/keys/create", (req, res) => {
  const { name, email } = req.body;

  if (!name || name.trim().length === 0) {
    return res.status(400).json({
      error: { message: "Name is required.", code: "missing_name" },
    });
  }

  try {
    const { rawKey, record } = db.createApiKey(name.trim(), (email || "").trim());

    log.info(`New API key created via portal`, { name: name.trim() });

    res.json({
      success: true,
      api_key: rawKey, // Shown ONCE to the user
      key_info: record,
      message:
        "Save this API key — it won't be shown again. Use it in the Authorization header: Bearer " +
        rawKey,
    });
  } catch (err) {
    log.error(`Failed to create API key: ${err.message}`);
    res.status(500).json({
      error: { message: "Failed to create API key.", code: "internal_error" },
    });
  }
});

// ──────────────────────────────────────────────
// Admin-only endpoints (require ADMIN_SECRET)
// ──────────────────────────────────────────────

// GET /api/keys — List all API keys
router.get("/api/keys", adminAuthMiddleware, (req, res) => {
  const keys = db.listApiKeys();
  res.json({ keys, total: keys.length });
});

// DELETE /api/keys/:id — Revoke a key
router.delete("/api/keys/:id", adminAuthMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ error: { message: "Invalid key ID." } });
  }

  db.revokeApiKey(id);
  res.json({ success: true, message: `API key ${id} revoked.` });
});

// GET /api/keys/:id/usage — Usage stats for a key
router.get("/api/keys/:id/usage", adminAuthMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ error: { message: "Invalid key ID." } });
  }

  const stats = db.getKeyUsageStats(id);
  res.json(stats);
});

module.exports = router;
