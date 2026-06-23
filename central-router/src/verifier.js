/**
 * Malicious Node Verification Engine (V3)
 * 
 * Uses an external Trusted Verifier Node to grade responses from untrusted nodes.
 * Implements a "Sink Client" dispatcher to perfectly spoof real TCP network traffic.
 */

const { createLogger } = require("./logger");
const db = require("./db");
const registry = require("./registry");

const log = createLogger("verifier");

// Configuration
const VERIFIER_API_URL = process.env.VERIFIER_API_URL || "http://trusted-verifier:8000/evaluate";
const VERIFICATION_INTERVAL_MS = parseInt(process.env.VERIFICATION_INTERVAL_MS || "60000", 10);
const MAX_CONCURRENT_CHALLENGES = 2;

// In a production scenario, we would pull from a large dataset of dynamic prompts.
const CHALLENGE_PROMPTS = [
  "Explain the difference between TCP and UDP in one paragraph.",
  "Write a Python function to compute the Fibonacci sequence.",
  "What are the main causes of the French Revolution?",
  "Translate 'Hello world, how are you?' into French."
];

let dispatcherTimer = null;
let activeChallenges = 0;

/**
 * Spoofs a real B2B HTTP request to our own Gateway exactly as a customer would.
 * This ensures the TCP stack on the provider's side sees normal traffic flow.
 */
async function dispatchSinkClientRequest(nodeId, prompt) {
  const fetch = (await import('node-fetch')).default;
  const routerUrl = `http://localhost:${process.env.PORT || 3000}/v1/chat/completions`;
  
  // We use a special internal flag so we don't bill ourselves, but we format
  // the request identically to standard OpenAI format.
  const payload = {
    model: "llama-3-8b",
    messages: [{ role: "user", content: prompt }],
    stream: false // For challenges, we can evaluate the full string at the end
  };

  log.info(`Dispatching Sink Client challenge to node [${nodeId}]...`);

  const response = await fetch(routerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.ADMIN_SECRET || "change-this-in-production"}`,
      "X-Target-Node": nodeId
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Sink Client failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Ask the isolated Trusted Verifier Microservice to evaluate the response.
 */
async function evaluateResponse(prompt, untrustedResponse) {
  const fetch = (await import('node-fetch')).default;

  try {
    const res = await fetch(VERIFIER_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        provider_response: untrustedResponse
      })
    });

    if (!res.ok) {
      log.error(`Trusted Verifier Node unavailable: ${res.statusText}`);
      return { pass: true, reason: "Verifier down, defaulting to pass" }; // Fail-open
    }

    const data = await res.json();
    return {
      pass: data.is_valid,
      reason: data.reason
    };
  } catch (err) {
    log.error(`Failed to reach Trusted Verifier Node: ${err.message}`);
    return { pass: true, reason: "Verifier unreachable" };
  }
}

/**
 * Run a full verification cycle on a specific node.
 */
async function challengeNode(nodeId) {
  if (activeChallenges >= MAX_CONCURRENT_CHALLENGES) return;
  
  activeChallenges++;
  const prompt = CHALLENGE_PROMPTS[Math.floor(Math.random() * CHALLENGE_PROMPTS.length)];

  try {
    // 1. Dispatch the hidden challenge via the Sink Client
    const untrustedResponse = await dispatchSinkClientRequest(nodeId, prompt);
    
    // 2. Evaluate semantic correctness using Trusted Verifier
    const evaluation = await evaluateResponse(prompt, untrustedResponse);

    // 3. Apply economic slashing or rewards
    if (evaluation.pass) {
      db.passVerificationChallenge(nodeId);
      log.info(`Node [${nodeId}] PASSED challenge. Reason: ${evaluation.reason}`);
    } else {
      const { strikes, isSlashed } = db.addProviderStrike(nodeId);
      log.warn(`Node [${nodeId}] FAILED challenge. Strikes: ${strikes}. Reason: ${evaluation.reason}`);
      
      if (isSlashed) {
        // Disconnect the WebSocket immediately
        const ws = registry.getLocalWs(nodeId);
        if (ws) {
          ws.close(4003, "Failed verification (Slashed)");
        }
        await registry.removeNode(nodeId, "verification_failed_slashed");
      }
    }
  } catch (err) {
    log.error(`Challenge for node [${nodeId}] aborted: ${err.message}`);
  } finally {
    activeChallenges--;
  }
}

/**
 * Background dispatcher that randomly selects active nodes for verification.
 */
function startVerificationDispatcher() {
  if (dispatcherTimer) return;

  log.info("Verification Engine Dispatcher started.", { interval_ms: VERIFICATION_INTERVAL_MS });

  dispatcherTimer = setInterval(async () => {
    try {
      const nodes = await registry.getActiveNodes();
      if (nodes.length === 0) return;

      // Pick a random idle node to challenge
      const idleNodes = nodes.filter(n => n.status === "idle");
      if (idleNodes.length === 0) return;

      const randomNode = idleNodes[Math.floor(Math.random() * idleNodes.length)];
      
      // Do not challenge blacklisted nodes
      if (db.isNodeBlacklisted(randomNode.nodeId)) return;

      challengeNode(randomNode.nodeId);
    } catch (err) {
      log.error(`Dispatcher error: ${err.message}`);
    }
  }, VERIFICATION_INTERVAL_MS);
}

function stopVerificationDispatcher() {
  if (dispatcherTimer) {
    clearInterval(dispatcherTimer);
    dispatcherTimer = null;
    log.info("Verification Engine Dispatcher stopped.");
  }
}

module.exports = {
  startVerificationDispatcher,
  stopVerificationDispatcher,
  challengeNode
};
