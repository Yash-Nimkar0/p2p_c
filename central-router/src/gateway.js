/**
 * Gateway — OpenAI-compatible API endpoint with failover.
 *
 * Implements:
 *   POST /v1/chat/completions  — Streaming & non-streaming chat inference
 *   GET  /v1/models            — List available models
 *
 * Phase 4 additions:
 *   - First-token timeout (2s) and total request timeout (30s)
 *   - Automatic failover: on node disconnect/error/timeout, re-routes
 *     the exact same prompt to a backup node (up to MAX_RETRIES)
 *   - Structured latency + node ID logging for every lifecycle event
 */

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { createLogger } = require("./logger");
const loadBalancer = require("./load-balancer");
const wsHandler = require("./ws-handler");
const { acquireOrQueue, tryDequeue } = require("./queue");
const db = require("./db");

const log = createLogger("gateway");
const router = express.Router();

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

/** Max retry attempts on node failure (excluding the initial attempt) */
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "2", 10);

/** Timeout for receiving the first token (ms) */
const FIRST_TOKEN_TIMEOUT = parseInt(process.env.FIRST_TOKEN_TIMEOUT_MS || "2000", 10);

/** Total request timeout (ms) */
const TOTAL_TIMEOUT = parseInt(process.env.TOTAL_TIMEOUT_MS || "30000", 10);

// ──────────────────────────────────────────────
// Supported models (hardcoded for MVP)
// ──────────────────────────────────────────────

const SUPPORTED_MODELS = [
  {
    id: "llama-3-8b",
    object: "model",
    created: 1700000000,
    owned_by: "meta",
    permission: [],
    root: "llama-3-8b",
    parent: null,
  },
];

// ──────────────────────────────────────────────
// GET /v1/models
// ──────────────────────────────────────────────

router.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: SUPPORTED_MODELS,
  });
});

// ──────────────────────────────────────────────
// POST /v1/chat/completions
// ──────────────────────────────────────────────

router.post("/v1/chat/completions", async (req, res) => {
  const startTime = Date.now();
  const requestId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 12)}`;

  // ── Parse & validate request ──
  const { model, messages, stream = true } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: "Invalid request: 'messages' must be a non-empty array.",
        type: "invalid_request_error",
        param: "messages",
        code: null,
      },
    });
  }

  const requestedModel = model || "llama-3-8b";

  log.info(`[${requestId}] New request`, {
    model: requestedModel,
    messages: messages.length,
    stream: String(stream),
  });

  // ── Handle streaming vs non-streaming ──
  if (stream) {
    await handleStreamingWithFailover(req, res, requestId, requestedModel, messages, startTime);
  } else {
    await handleNonStreamingWithFailover(req, res, requestId, requestedModel, messages, startTime);
  }
});

// ──────────────────────────────────────────────
// Streaming Response with Failover
// ──────────────────────────────────────────────

/**
 * Attempt streaming inference with automatic failover.
 *
 * If a node fails (disconnect, error, or first-token timeout),
 * the gateway re-dispatches the same prompt to another node,
 * up to MAX_RETRIES times. The SSE stream to the client stays
 * open throughout — the developer sees a seamless response.
 */
async function handleStreamingWithFailover(req, res, requestId, model, messages, startTime) {
  let attempt = 0;
  let headersSent = false;
  let totalTokens = 0;
  let clientDisconnected = false;
  let currentNodeId = null;

  // Track client disconnect
  res.on("close", () => {
    clientDisconnected = true;
  });

  while (attempt <= MAX_RETRIES) {
    if (clientDisconnected) {
      log.warn(`[${requestId}] Client disconnected, aborting (attempt ${attempt})`);
      return;
    }

    // ── Acquire a node (or queue if all busy) ──
    const { node, error, queued } = await acquireOrQueue(model);
    if (queued) log.info(`[${requestId}] Request was queued, now dequeued`);

    if (!node) {
      if (attempt === 0 && !headersSent) {
        // First attempt, no headers sent yet — return proper HTTP error
        log.warn(`[${requestId}] No node available: ${error}`);
        return res.status(503).json({
          error: {
            message: error,
            type: "server_error",
            param: null,
            code: "no_available_nodes",
          },
        });
      }
      // We're in a retry but no backup node available
      log.error(`[${requestId}] Failover failed — no backup nodes available (attempt ${attempt})`);
      if (headersSent) {
        res.write(`data: ${JSON.stringify({
          id: requestId, object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: { content: "\n\n[Error: All provider nodes failed. No backup available.]" }, finish_reason: "error" }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return;
    }

    currentNodeId = node.nodeId;

    log.info(`[${requestId}] Routed to node [${currentNodeId}]`, {
      attempt: attempt + 1,
      max_attempts: MAX_RETRIES + 1,
    });

    // ── Send inference request ──
    const sent = wsHandler.sendInferenceRequest(currentNodeId, requestId, messages);

    if (!sent) {
      log.error(`[${requestId}] Failed to send to node [${currentNodeId}], trying next...`);
      loadBalancer.releaseNode(currentNodeId);
      attempt++;
      continue;
    }

    // ── Wait for inference result ──
    const result = await waitForInference(requestId, currentNodeId);

    if (result.status === "success") {
      // ── Stream all chunks to client ──
      if (!headersSent) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Request-Id": requestId,
          "X-Node-Id": currentNodeId,
        });
        res.flushHeaders();
        headersSent = true;
      }

      for (const chunk of result.chunks) {
        if (clientDisconnected) break;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        totalTokens++;
      }

      if (!clientDisconnected) {
        res.write("data: [DONE]\n\n");
        res.end();
      }

      const latency = Date.now() - startTime;
      log.info(`[${requestId}] Stream complete`, {
        node: currentNodeId,
        tokens: totalTokens,
        latency: `${latency}ms`,
        attempts: attempt + 1,
      });

      // ── Log usage + release node + dequeue ──
      loadBalancer.releaseNode(currentNodeId);
      tryDequeue(model);
      if (req.apiKey) {
        try {
          db.logUsage({
            apiKeyId: req.apiKey.id,
            requestId,
            model,
            tokensCompletion: totalTokens,
            latencyMs: latency,
            nodeId: currentNodeId,
            status: "success",
          });
          db.updateProviderStats(currentNodeId, totalTokens);

          // ── Billing Integration ──
          const billing = require("./billing");
          if (req.apiKey.razorpay_customer_id) {
            billing.chargeCustomer(req.apiKey.razorpay_customer_id, totalTokens * 0.0002);
          }
          billing.payProvider(currentNodeId, totalTokens * 0.0001);

        } catch (_) { /* non-critical */ }
      }
      return;
    }

    // ── Failure — prepare for retry ──
    const latency = Date.now() - startTime;
    log.error(`[${requestId}] Node [${currentNodeId}] failed: ${result.reason}`, {
      latency: `${latency}ms`,
      attempt: attempt + 1,
      tokens_before_failure: result.chunks?.length || 0,
    });

    // Clean up tracking for this request so we can re-dispatch
    wsHandler.clearRequestTracking(requestId);

    // If headers already sent, we need to inform the client about retry
    if (headersSent && result.chunks && result.chunks.length > 0) {
      // We already sent some partial tokens — notify about retry
      log.warn(`[${requestId}] Partial tokens were already streamed, restarting from backup node`);
    }

    attempt++;

    if (attempt <= MAX_RETRIES) {
      log.info(`[${requestId}] Retrying on backup node (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
    }
  }

  // All retries exhausted
  const latency = Date.now() - startTime;
  log.error(`[${requestId}] All ${MAX_RETRIES + 1} attempts failed`, { latency: `${latency}ms` });

  if (!headersSent) {
    res.status(502).json({
      error: {
        message: `Inference failed after ${MAX_RETRIES + 1} attempts. All provider nodes failed.`,
        type: "server_error",
        param: null,
        code: "all_nodes_failed",
      },
    });
  } else {
    res.write(`data: ${JSON.stringify({
      id: requestId, object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta: { content: "\n\n[Error: All provider nodes failed after retries.]" }, finish_reason: "error" }],
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

// ──────────────────────────────────────────────
// Non-Streaming Response with Failover
// ──────────────────────────────────────────────

/**
 * Non-streaming inference with automatic failover.
 * Buffers all tokens, retries on failure, returns complete response.
 */
async function handleNonStreamingWithFailover(req, res, requestId, model, messages, startTime) {
  let attempt = 0;
  let clientDisconnected = false;

  res.on("close", () => { clientDisconnected = true; });

  while (attempt <= MAX_RETRIES) {
    if (clientDisconnected) {
      log.warn(`[${requestId}] Client disconnected, aborting (attempt ${attempt})`);
      return;
    }

    const { node, error, queued } = await acquireOrQueue(model);
    if (queued) log.info(`[${requestId}] Request was queued, now dequeued`);

    if (!node) {
      if (attempt === 0) {
        log.warn(`[${requestId}] No node available: ${error}`);
        return res.status(503).json({
          error: { message: error, type: "server_error", param: null, code: "no_available_nodes" },
        });
      }
      log.error(`[${requestId}] Failover failed — no backup nodes (attempt ${attempt})`);
      return res.status(502).json({
        error: {
          message: `Inference failed after ${attempt} attempts. No backup nodes available.`,
          type: "server_error", param: null, code: "all_nodes_failed",
        },
      });
    }

    const nodeId = node.nodeId;
    log.info(`[${requestId}] Routed to node [${nodeId}]`, { attempt: attempt + 1 });

    const sent = wsHandler.sendInferenceRequest(nodeId, requestId, messages);

    if (!sent) {
      log.error(`[${requestId}] Failed to send to node [${nodeId}], trying next...`);
      loadBalancer.releaseNode(nodeId);
      attempt++;
      continue;
    }

    const result = await waitForInference(requestId, nodeId);

    if (result.status === "success") {
      const fullContent = result.chunks
        .map((c) => c.choices?.[0]?.delta?.content || "")
        .join("");

      const latency = Date.now() - startTime;

      res.json({
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: fullContent },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: -1,
          completion_tokens: result.chunks.length,
          total_tokens: -1,
        },
      });

      log.info(`[${requestId}] Non-streaming response sent`, {
        node: nodeId,
        content_length: fullContent.length,
        latency: `${latency}ms`,
        attempts: attempt + 1,
      });

      // ── Log usage + release node + dequeue ──
      loadBalancer.releaseNode(nodeId);
      tryDequeue(model);
      if (req.apiKey) {
        try {
          db.logUsage({
            apiKeyId: req.apiKey.id,
            requestId,
            model,
            tokensCompletion: result.chunks.length,
            latencyMs: latency,
            nodeId,
            status: "success",
          });
          db.updateProviderStats(nodeId, result.chunks.length);
        } catch (_) { /* non-critical */ }
      }
      return;
    }

    // Failure — retry
    const latency = Date.now() - startTime;
    log.error(`[${requestId}] Node [${nodeId}] failed: ${result.reason}`, {
      latency: `${latency}ms`,
      attempt: attempt + 1,
    });

    wsHandler.clearRequestTracking(requestId);
    attempt++;

    if (attempt <= MAX_RETRIES) {
      log.info(`[${requestId}] Retrying on backup node (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
    }
  }

  // All retries exhausted
  const latency = Date.now() - startTime;
  log.error(`[${requestId}] All ${MAX_RETRIES + 1} attempts failed`, { latency: `${latency}ms` });
  res.status(502).json({
    error: {
      message: `Inference failed after ${MAX_RETRIES + 1} attempts.`,
      type: "server_error", param: null, code: "all_nodes_failed",
    },
  });
}

// ──────────────────────────────────────────────
// Core: Wait for inference with timeouts
// ──────────────────────────────────────────────

/**
 * Wait for a single inference attempt to complete, fail, or timeout.
 *
 * Returns a result object:
 *   { status: "success", chunks: [...] }
 *   { status: "failed", reason: "...", chunks: [...partial...] }
 *
 * Timeouts:
 *   - First token must arrive within FIRST_TOKEN_TIMEOUT (2s)
 *   - Total inference must complete within TOTAL_TIMEOUT (30s)
 *
 * @param {string} requestId
 * @param {string} nodeId
 * @returns {Promise<{status: string, reason?: string, chunks: object[]}>}
 */
function waitForInference(requestId, nodeId) {
  return new Promise((resolve) => {
    const chunks = [];
    let firstTokenReceived = false;
    let resolved = false;
    let firstTokenTimer = null;
    let totalTimer = null;

    function cleanup() {
      if (resolved) return;
      resolved = true;
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      if (totalTimer) clearTimeout(totalTimer);
      wsHandler.events.removeListener("inference_chunk", onChunk);
      wsHandler.events.removeListener("inference_done", onDone);
      wsHandler.events.removeListener("inference_error", onError);
      wsHandler.events.removeListener("node_disconnect", onDisconnect);
    }

    // ── First-token timeout ──
    firstTokenTimer = setTimeout(() => {
      if (!firstTokenReceived && !resolved) {
        cleanup();
        log.error(`[${requestId}] First-token timeout (${FIRST_TOKEN_TIMEOUT}ms) on node [${nodeId}]`);
        resolve({ status: "failed", reason: `first_token_timeout (${FIRST_TOKEN_TIMEOUT}ms)`, chunks });
      }
    }, FIRST_TOKEN_TIMEOUT);

    // ── Total request timeout ──
    totalTimer = setTimeout(() => {
      if (!resolved) {
        cleanup();
        log.error(`[${requestId}] Total timeout (${TOTAL_TIMEOUT}ms) on node [${nodeId}]`);
        resolve({ status: "failed", reason: `total_timeout (${TOTAL_TIMEOUT}ms)`, chunks });
      }
    }, TOTAL_TIMEOUT);

    // ── Event Handlers ──

    function onChunk(data) {
      if (data.requestId !== requestId || resolved) return;

      if (!firstTokenReceived) {
        firstTokenReceived = true;
        if (firstTokenTimer) {
          clearTimeout(firstTokenTimer);
          firstTokenTimer = null;
        }
        log.info(`[${requestId}] First token received from node [${nodeId}]`, {
          ttft: `${Date.now() - (Date.now() - (chunks.length === 0 ? 0 : 1))}ms`,
        });
      }

      chunks.push(data.chunk);
    }

    function onDone(data) {
      if (data.requestId !== requestId || resolved) return;
      cleanup();
      resolve({ status: "success", chunks });
    }

    function onError(data) {
      if (data.requestId !== requestId || resolved) return;
      cleanup();
      resolve({
        status: "failed",
        reason: `inference_error: ${data.error || "unknown"}`,
        chunks,
      });
    }

    function onDisconnect(data) {
      if (data.activeRequestId !== requestId || resolved) return;
      cleanup();
      log.error(`[${requestId}] Node [${data.nodeId}] disconnected mid-inference`);
      resolve({
        status: "failed",
        reason: `node_disconnected: ${data.nodeId}`,
        chunks,
      });
    }

    // ── Subscribe ──
    wsHandler.events.on("inference_chunk", onChunk);
    wsHandler.events.on("inference_done", onDone);
    wsHandler.events.on("inference_error", onError);
    wsHandler.events.on("node_disconnect", onDisconnect);
  });
}

module.exports = router;
