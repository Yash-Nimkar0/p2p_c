/**
 * Database — SQLite layer for API keys, usage tracking, and provider stats.
 *
 * Uses better-sqlite3 (synchronous, fast, zero-config).
 * Auto-creates schema on first run.
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { createLogger } = require("./logger");

const log = createLogger("db");

// ──────────────────────────────────────────────
// Database Initialization
// ──────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "p2p_gpu.db");

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // Better concurrent read performance
db.pragma("foreign_keys = ON");

log.info(`Database initialized at ${DB_PATH}`);

// ──────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT 'Unnamed',
    email TEXT DEFAULT '',
    rate_limit_rpm INTEGER DEFAULT 60,
    is_active INTEGER DEFAULT 1,
    total_requests INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    razorpay_customer_id TEXT
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'llama-3-8b',
    tokens_completion INTEGER DEFAULT 0,
    latency_ms INTEGER DEFAULT 0,
    node_id TEXT DEFAULT '',
    status TEXT DEFAULT 'success',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
  );

  CREATE TABLE IF NOT EXISTS provider_stats (
    node_id TEXT PRIMARY KEY,
    total_requests INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    pending_balance_usd REAL DEFAULT 0.0,
    available_balance_usd REAL DEFAULT 0.0,
    reputation_score INTEGER DEFAULT 100,
    strikes INTEGER DEFAULT 0,
    is_blacklisted INTEGER DEFAULT 0,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_usage_api_key ON usage_log(api_key_id);
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_keys_prefix ON api_keys(key_prefix);
`);

// Simple automatic migrations for existing DBs
try {
  db.exec(`
    ALTER TABLE provider_stats ADD COLUMN pending_balance_usd REAL DEFAULT 0.0;
    ALTER TABLE provider_stats ADD COLUMN available_balance_usd REAL DEFAULT 0.0;
    ALTER TABLE provider_stats ADD COLUMN reputation_score INTEGER DEFAULT 100;
    ALTER TABLE provider_stats ADD COLUMN strikes INTEGER DEFAULT 0;
    ALTER TABLE provider_stats ADD COLUMN is_blacklisted INTEGER DEFAULT 0;
  `);
  log.info("Applied DB migration: Added provider verification columns");
} catch (err) {
  // Columns likely already exist, ignore.
}

log.info("Database schema ready");

// ──────────────────────────────────────────────
// API Key Management
// ──────────────────────────────────────────────

/**
 * Create a new API key.
 * Returns the raw key (shown to user once) and the DB record.
 *
 * @param {string} name
 * @param {string} email
 * @returns {{ rawKey: string, record: object }}
 */
function createApiKey(name = "Unnamed", email = "") {
  const rawKey = `sk-${crypto.randomBytes(24).toString("hex")}`;
  const prefix = rawKey.slice(0, 7); // "sk-xxxx" for display
  const hash = bcrypt.hashSync(rawKey, 10);

  const stmt = db.prepare(
    "INSERT INTO api_keys (key_prefix, key_hash, name, email) VALUES (?, ?, ?, ?)"
  );
  const result = stmt.run(prefix, hash, name, email);

  log.info(`API key created: ${prefix}...`, { id: result.lastInsertRowid, name });

  return {
    rawKey,
    record: {
      id: result.lastInsertRowid,
      key_prefix: prefix,
      name,
      email,
      rate_limit_rpm: 60,
      is_active: 1,
      created_at: new Date().toISOString(),
    },
  };
}

/**
 * Validate an API key and return the associated record.
 * Returns null if the key is invalid or revoked.
 *
 * @param {string} rawKey — The full API key (sk-...)
 * @returns {object|null}
 */
function validateApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith("sk-")) return null;

  const prefix = rawKey.slice(0, 7);
  const candidates = db
    .prepare("SELECT * FROM api_keys WHERE key_prefix = ? AND is_active = 1")
    .all(prefix);

  for (const row of candidates) {
    if (bcrypt.compareSync(rawKey, row.key_hash)) {
      // Update last_used_at
      db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
      return row;
    }
  }

  return null;
}

/**
 * List all API keys (without exposing hashes).
 * @returns {object[]}
 */
function listApiKeys() {
  return db
    .prepare(
      "SELECT id, key_prefix, name, email, rate_limit_rpm, is_active, total_requests, total_tokens, created_at, last_used_at FROM api_keys ORDER BY created_at DESC"
    )
    .all();
}

/**
 * Revoke an API key.
 * @param {number} id
 */
function revokeApiKey(id) {
  db.prepare("UPDATE api_keys SET is_active = 0 WHERE id = ?").run(id);
  log.warn(`API key revoked`, { id });
}

// ──────────────────────────────────────────────
// Usage Tracking
// ──────────────────────────────────────────────

/**
 * Log a completed inference request.
 */
function logUsage({ apiKeyId, requestId, model, tokensCompletion, latencyMs, nodeId, status = "success" }) {
  db.prepare(
    "INSERT INTO usage_log (api_key_id, request_id, model, tokens_completion, latency_ms, node_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(apiKeyId, requestId, model, tokensCompletion, latencyMs, nodeId, status);

  // Update cumulative stats on the key
  db.prepare(
    "UPDATE api_keys SET total_requests = total_requests + 1, total_tokens = total_tokens + ? WHERE id = ?"
  ).run(tokensCompletion, apiKeyId);
}

/**
 * Get usage stats for a specific API key.
 */
function getKeyUsageStats(apiKeyId) {
  const total = db
    .prepare(
      "SELECT COUNT(*) as requests, COALESCE(SUM(tokens_completion),0) as tokens, COALESCE(AVG(latency_ms),0) as avg_latency FROM usage_log WHERE api_key_id = ?"
    )
    .get(apiKeyId);

  const today = db
    .prepare(
      "SELECT COUNT(*) as requests, COALESCE(SUM(tokens_completion),0) as tokens FROM usage_log WHERE api_key_id = ? AND created_at >= date('now')"
    )
    .get(apiKeyId);

  const recent = db
    .prepare(
      "SELECT request_id, model, tokens_completion, latency_ms, node_id, status, created_at FROM usage_log WHERE api_key_id = ? ORDER BY created_at DESC LIMIT 20"
    )
    .all(apiKeyId);

  return { total, today, recent };
}

// ──────────────────────────────────────────────
// Network Stats (for Dashboard)
// ──────────────────────────────────────────────

/**
 * Get overall network statistics.
 */
function getNetworkStats() {
  const totalRequests = db
    .prepare("SELECT COUNT(*) as count FROM usage_log")
    .get().count;

  const todayRequests = db
    .prepare("SELECT COUNT(*) as count FROM usage_log WHERE created_at >= date('now')")
    .get().count;

  const totalTokens = db
    .prepare("SELECT COALESCE(SUM(tokens_completion),0) as total FROM usage_log")
    .get().total;

  const avgLatency = db
    .prepare("SELECT COALESCE(AVG(latency_ms),0) as avg FROM usage_log WHERE status = 'success'")
    .get().avg;

  const activeKeys = db
    .prepare("SELECT COUNT(*) as count FROM api_keys WHERE is_active = 1")
    .get().count;

  const recentRequests = db
    .prepare(
      "SELECT u.request_id, u.model, u.tokens_completion, u.latency_ms, u.node_id, u.status, u.created_at, k.name as key_name FROM usage_log u LEFT JOIN api_keys k ON u.api_key_id = k.id ORDER BY u.created_at DESC LIMIT 50"
    )
    .all();

  // Requests per hour (last 24h)
  const hourlyStats = db
    .prepare(
      "SELECT strftime('%H', created_at) as hour, COUNT(*) as requests, COALESCE(SUM(tokens_completion),0) as tokens FROM usage_log WHERE created_at >= datetime('now', '-24 hours') GROUP BY hour ORDER BY hour"
    )
    .all();

  return {
    totalRequests,
    todayRequests,
    totalTokens,
    avgLatency: Math.round(avgLatency),
    activeKeys,
    recentRequests,
    hourlyStats,
  };
}

/**
 * Update provider node stats after serving a request.
 */
function updateProviderStats(nodeId, tokensGenerated) {
  // E.g. $0.0001 per token earned
  const earnings = tokensGenerated * 0.0001;
  db.prepare(`
    INSERT INTO provider_stats (node_id, total_requests, total_tokens, balance_usd, last_seen)
    VALUES (?, 1, ?, ?, datetime('now'))
    ON CONFLICT(node_id) DO UPDATE SET
      total_requests = total_requests + 1,
      total_tokens = total_tokens + ?,
      balance_usd = balance_usd + ?,
      last_seen = datetime('now')
  `).run(nodeId, tokensGenerated, earnings, tokensGenerated, earnings);
}

// ──────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// Verification & Reputation (3-Strike System)
// ──────────────────────────────────────────────

/**
 * Record a failed verification challenge for a node.
 * If strikes >= 3, the node is permanently slashed.
 *
 * @param {string} nodeId
 * @returns {object} { strikes, isSlashed }
 */
function addProviderStrike(nodeId) {
  const stmt = db.prepare("SELECT strikes FROM provider_stats WHERE node_id = ?");
  const row = stmt.get(nodeId);

  if (!row) return { strikes: 0, isSlashed: false };

  const newStrikes = row.strikes + 1;
  const isSlashed = newStrikes >= 3;

  if (isSlashed) {
    // Slash the node: 0 out pending balance, set rep to 0, blacklist
    db.prepare(`
      UPDATE provider_stats 
      SET strikes = ?, 
          is_blacklisted = 1, 
          reputation_score = 0, 
          pending_balance_usd = 0.0 
      WHERE node_id = ?
    `).run(newStrikes, nodeId);
    log.warn(`[SLASHED] Node [${nodeId}] has failed 3 verification challenges and is now blacklisted.`);
  } else {
    // Just add a strike and lower reputation
    db.prepare(`
      UPDATE provider_stats 
      SET strikes = ?, 
          reputation_score = MAX(0, reputation_score - 33) 
      WHERE node_id = ?
    `).run(newStrikes, nodeId);
    log.warn(`[STRIKE] Node [${nodeId}] failed a verification challenge. Strike ${newStrikes}/3.`);
  }

  return { strikes: newStrikes, isSlashed };
}

/**
 * Check if a node is blacklisted.
 */
function isNodeBlacklisted(nodeId) {
  const stmt = db.prepare("SELECT is_blacklisted FROM provider_stats WHERE node_id = ?");
  const row = stmt.get(nodeId);
  return row ? row.is_blacklisted === 1 : false;
}

/**
 * Pass a verification challenge, recovering reputation and unlocking some pending balance.
 */
function passVerificationChallenge(nodeId) {
  // Move 10% of pending balance to available balance, recover some reputation
  db.prepare(`
    UPDATE provider_stats 
    SET reputation_score = MIN(100, reputation_score + 10),
        available_balance_usd = available_balance_usd + (pending_balance_usd * 0.10),
        pending_balance_usd = pending_balance_usd - (pending_balance_usd * 0.10)
    WHERE node_id = ? AND is_blacklisted = 0
  `).run(nodeId);
  log.info(`[VERIFIED] Node [${nodeId}] passed challenge. Reputation increased.`);
}

module.exports = {
  db,
  createApiKey,
  validateApiKey,
  listApiKeys,
  revokeApiKey,
  logUsage,
  getKeyUsageStats,
  getNetworkStats,
  updateProviderStats,
  addProviderStrike,
  isNodeBlacklisted,
  passVerificationChallenge
};
