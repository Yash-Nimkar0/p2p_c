/**
 * Logger — Structured, color-coded logging for the Central Router.
 *
 * Log format: [HH:MM:SS] [LEVEL] [component] message {metadata}
 */

const chalk = require("chalk");

const LEVELS = {
  DEBUG: { priority: 0, color: chalk.gray, label: "DEBUG" },
  INFO: { priority: 1, color: chalk.cyan, label: "INFO " },
  WARN: { priority: 2, color: chalk.yellow, label: "WARN " },
  ERROR: { priority: 3, color: chalk.red, label: "ERROR" },
};

const MIN_LEVEL = process.env.LOG_LEVEL
  ? LEVELS[process.env.LOG_LEVEL.toUpperCase()]?.priority ?? 1
  : 1;

/**
 * Format a timestamp as HH:MM:SS.mmm
 */
function timestamp() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * Format metadata object as a compact string.
 */
function formatMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) return "";
  const parts = Object.entries(meta).map(
    ([k, v]) => `${chalk.gray(k)}=${typeof v === "string" ? v : JSON.stringify(v)}`
  );
  return " " + parts.join(" ");
}

/**
 * Create a logger scoped to a component name.
 *
 * @param {string} component — The component name (e.g., "registry", "gateway")
 * @returns {object} Logger with debug/info/warn/error methods.
 */
function createLogger(component) {
  const padded = component.padEnd(12);

  function log(level, message, meta) {
    if (level.priority < MIN_LEVEL) return;
    const ts = chalk.gray(timestamp());
    const lvl = level.color(level.label);
    const comp = chalk.magenta(padded);
    const metaStr = formatMeta(meta);
    console.log(`${ts} │ ${lvl} │ ${comp} │ ${message}${metaStr}`);
  }

  return {
    debug: (msg, meta) => log(LEVELS.DEBUG, msg, meta),
    info: (msg, meta) => log(LEVELS.INFO, msg, meta),
    warn: (msg, meta) => log(LEVELS.WARN, msg, meta),
    error: (msg, meta) => log(LEVELS.ERROR, msg, meta),
  };
}

module.exports = { createLogger };
