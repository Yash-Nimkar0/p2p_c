/**
 * Redis — Horizontal Scaling & Cross-Router Pub/Sub.
 */

const Redis = require("ioredis");
const { createLogger } = require("./logger");

const log = createLogger("redis");

const REDIS_URL = process.env.REDIS_URL || null;

let pub = null;
let sub = null;
let isRedisEnabled = false;

if (REDIS_URL) {
  pub = new Redis(REDIS_URL);
  sub = new Redis(REDIS_URL);
  isRedisEnabled = true;

  pub.on("connect", () => log.info("Redis Publisher connected"));
  sub.on("connect", () => log.info("Redis Subscriber connected"));
  
  pub.on("error", (err) => log.error(`Redis Pub Error: ${err.message}`));
  sub.on("error", (err) => log.error(`Redis Sub Error: ${err.message}`));
} else {
  log.warn("REDIS_URL not set. Running in Single-Node / Memory mode.");
}

/**
 * Publish an event to all router instances.
 */
function publishEvent(channel, eventType, payload) {
  if (!isRedisEnabled) return;
  const message = JSON.stringify({ type: eventType, data: payload, routerId: process.pid });
  pub.publish(channel, message);
}

/**
 * Subscribe to a channel.
 */
function subscribeToChannel(channel, handler) {
  if (!isRedisEnabled) return;
  sub.subscribe(channel, (err) => {
    if (err) log.error(`Failed to subscribe to ${channel}: ${err.message}`);
    else log.info(`Subscribed to Redis channel: ${channel}`);
  });

  sub.on("message", (ch, message) => {
    if (ch === channel) {
      try {
        const parsed = JSON.parse(message);
        // Ignore messages published by ourselves
        if (parsed.routerId !== process.pid) {
          handler(parsed.type, parsed.data);
        }
      } catch (err) {
        log.error(`Failed to parse Redis message: ${err.message}`);
      }
    }
  });
}

module.exports = {
  pub,
  sub,
  isRedisEnabled,
  publishEvent,
  subscribeToChannel
};
