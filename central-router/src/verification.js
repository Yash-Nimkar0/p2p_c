/**
 * Malicious Node Verification Engine
 *
 * Randomly duplicates a small percentage of inference requests to a second node.
 * Compares the generated outputs to detect if a provider is returning garbage
 * text to farm tokens without actually running the model.
 */

const { createLogger } = require("./logger");

const log = createLogger("verification");

// Probability of a request being flagged for verification (0.01 = 1%)
const VERIFICATION_RATE = parseFloat(process.env.VERIFICATION_RATE || "0.01");

/**
 * Determine if a request should be duplicated for verification.
 */
function shouldVerifyRequest() {
  return Math.random() < VERIFICATION_RATE;
}

/**
 * Compare two inference responses for similarity.
 * Since LLMs are non-deterministic (even at temp=0), we don't expect 100% exact match,
 * but the Jaccard similarity of the words should be very high.
 *
 * @param {string} output1
 * @param {string} output2
 * @returns {number} Similarity score between 0.0 and 1.0
 */
function calculateSimilarity(output1, output2) {
  if (!output1 || !output2) return 0;

  const set1 = new Set(output1.toLowerCase().match(/\w+/g) || []);
  const set2 = new Set(output2.toLowerCase().match(/\w+/g) || []);

  if (set1.size === 0 && set2.size === 0) return 1;
  if (set1.size === 0 || set2.size === 0) return 0;

  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  return intersection.size / union.size;
}

/**
 * Process the verification results.
 * @param {string} requestId
 * @param {string} primaryNodeId
 * @param {string} verifyNodeId
 * @param {string} outputPrimary
 * @param {string} outputVerify
 */
function processVerification(requestId, primaryNodeId, verifyNodeId, outputPrimary, outputVerify) {
  const similarity = calculateSimilarity(outputPrimary, outputVerify);
  
  log.info(`[VERIFY ${requestId}] Similarity score between ${primaryNodeId} and ${verifyNodeId}: ${(similarity * 100).toFixed(1)}%`);

  // If similarity is below 30%, it's highly suspicious (since we enforce temp=0 for verify requests)
  if (similarity < 0.3) {
    log.warn(`🚨 MALICIOUS NODE DETECTED! Large divergence on request ${requestId}`);
    log.warn(`Node 1 (${primaryNodeId}): "${outputPrimary.slice(0, 100)}..."`);
    log.warn(`Node 2 (${verifyNodeId}): "${outputVerify.slice(0, 100)}..."`);
    
    // In a real system, we'd flag both nodes in the DB for manual review
    // and suspend their payouts temporarily.
    const db = require("./db");
    // db.flagNodeSuspicious(primaryNodeId);
    // db.flagNodeSuspicious(verifyNodeId);
  }
}

module.exports = {
  shouldVerifyRequest,
  processVerification,
  calculateSimilarity
};
