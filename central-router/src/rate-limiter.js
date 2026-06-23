/**
 * Rate Limiter — Per-API-key request throttling.
 *
 * Uses a sliding window counter in memory.
 * Each API key gets a configurable RPM (requests per minute).
 * Returns 429 with Retry-After header when exceeded.
 */

const { createLogger } = require("./logger");

const log = createLogger("rate-limit");

/** Map<apiKeyId, { timestamps: number[] }> */
const windows = new Map();

const GLOBAL_RPM = parseInt(process.env.RATE_LIMIT_GLOBAL_RPM || "1000", 10);
let globalTimestamps = [];

/**
 * Rate limiter middleware.
 * Must run AFTER auth middleware (needs req.apiKey).
 */
function rateLimiterMiddleware(req, res, next) {
  // Only rate-limit inference endpoints
  if (!req.path.startsWith("/v1/chat")) {
    return next();
  }

  // ── Global rate limit ──
  const now = Date.now();
  globalTimestamps = globalTimestamps.filter((t) => now - t < 60000);
  if (globalTimestamps.length >= GLOBAL_RPM) {
    const retryAfter = Math.ceil((globalTimestamps[0] + 60000 - now) / 1000);
    log.warn("Global rate limit exceeded", { rpm: globalTimestamps.length });
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({
      error: {
        message: "Server is overloaded. Please retry shortly.",
        type: "rate_limit_error",
        code: "global_rate_limit",
      },
    });
  }

  // ── Per-key rate limit ──
  if (req.apiKey) {
    const keyId = req.apiKey.id;
    const rpm = req.apiKey.rate_limit_rpm || 60;

    if (!windows.has(keyId)) {
      windows.set(keyId, { timestamps: [] });
    }

    const win = windows.get(keyId);
    win.timestamps = win.timestamps.filter((t) => now - t < 60000);

    if (win.timestamps.length >= rpm) {
      const retryAfter = Math.ceil((win.timestamps[0] + 60000 - now) / 1000);
      log.warn(`Rate limit exceeded for key ${req.apiKey.key_prefix}`, {
        rpm: win.timestamps.length,
        limit: rpm,
      });
      res.set("Retry-After", String(retryAfter));
      res.set("X-RateLimit-Limit", String(rpm));
      res.set("X-RateLimit-Remaining", "0");
      return res.status(429).json({
        error: {
          message: `Rate limit exceeded: ${rpm} requests per minute. Retry after ${retryAfter}s.`,
          type: "rate_limit_error",
          code: "key_rate_limit",
        },
      });
    }

    // Record this request
    win.timestamps.push(now);
    globalTimestamps.push(now);

    // Set rate limit headers
    res.set("X-RateLimit-Limit", String(rpm));
    res.set("X-RateLimit-Remaining", String(rpm - win.timestamps.length));
  }

  next();
}

// Clean up old windows periodically
setInterval(() => {
  const now = Date.now();
  for (const [keyId, win] of windows) {
    win.timestamps = win.timestamps.filter((t) => now - t < 60000);
    if (win.timestamps.length === 0) {
      windows.delete(keyId);
    }
  }
  globalTimestamps = globalTimestamps.filter((t) => now - t < 60000);
}, 30000);

module.exports = { rateLimiterMiddleware };
