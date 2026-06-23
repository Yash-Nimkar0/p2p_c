/**
 * Auth Middleware — API key authentication for the inference endpoints.
 *
 * Extracts the API key from the Authorization header (Bearer sk-xxx)
 * and validates it against the database.
 *
 * Skips auth for public routes: /health, /v1/models, /nodes, static files.
 */

const { createLogger } = require("./logger");
const { validateApiKey } = require("./db");

const log = createLogger("auth");

/** Routes that don't require authentication */
const PUBLIC_PATHS = [
  "/health",
  "/nodes",
  "/v1/models",
  "/api/keys/create",  // Landing page key creation
];

/** Path prefixes that don't require auth */
const PUBLIC_PREFIXES = [
  "/dashboard",
  "/assets",
  "/api/stats",  // Dashboard stats (protected by admin secret separately)
  "/api/keys",   // Key management (admin-secret protected separately)
];

/**
 * Express middleware for API key authentication.
 */
function authMiddleware(req, res, next) {
  const reqPath = req.path;

  // Skip auth for public routes
  if (reqPath === "/" || PUBLIC_PATHS.includes(reqPath)) {
    return next();
  }

  // Skip auth for public prefixes (static files, dashboard)
  for (const prefix of PUBLIC_PREFIXES) {
    if (reqPath.startsWith(prefix)) {
      return next();
    }
  }

  // Skip auth for static files
  if (reqPath.match(/\.(html|css|js|ico|png|jpg|svg|woff2?)$/)) {
    return next();
  }

  // Skip auth for WebSocket upgrade (handled separately)
  if (req.headers.upgrade === "websocket") {
    return next();
  }

  // ── Extract API key ──
  const authHeader = req.headers.authorization;
  let apiKey = null;

  if (authHeader) {
    if (authHeader.startsWith("Bearer ")) {
      apiKey = authHeader.slice(7).trim();
    } else {
      apiKey = authHeader.trim();
    }
  }

  // Also check X-API-Key header
  if (!apiKey) {
    apiKey = req.headers["x-api-key"];
  }

  if (!apiKey) {
    log.warn(`Auth failed: no API key provided`, { path: reqPath });
    return res.status(401).json({
      error: {
        message:
          "Missing API key. Include it in the Authorization header: 'Bearer sk-your-key'",
        type: "authentication_error",
        param: null,
        code: "missing_api_key",
      },
    });
  }

  // ── Validate ──
  const keyRecord = validateApiKey(apiKey);

  if (!keyRecord) {
    log.warn(`Auth failed: invalid API key`, { prefix: apiKey.slice(0, 7) });
    return res.status(401).json({
      error: {
        message: "Invalid API key. Check your key or create a new one.",
        type: "authentication_error",
        param: null,
        code: "invalid_api_key",
      },
    });
  }

  // Attach key info to request for downstream use
  req.apiKey = keyRecord;

  next();
}

/**
 * Admin auth middleware — checks the ADMIN_SECRET for management endpoints.
 */
function adminAuthMiddleware(req, res, next) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || adminSecret === "change-this-in-production") {
    // No admin secret set — allow access (dev mode)
    return next();
  }

  const provided =
    req.headers["x-admin-secret"] || req.query.admin_secret;

  if (provided !== adminSecret) {
    return res.status(403).json({
      error: {
        message: "Forbidden: invalid admin secret.",
        type: "authentication_error",
        code: "forbidden",
      },
    });
  }

  next();
}

module.exports = { authMiddleware, adminAuthMiddleware };
