/**
 * Billing & Monetization — Razorpay API Integration.
 *
 * Handles charging API users for inference, and tracking payouts to providers.
 */

const Razorpay = require("razorpay");
const { createLogger } = require("./logger");

const log = createLogger("billing");

let razorpay;

// Initialize Razorpay
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  log.info("Razorpay billing initialized");
} else {
  log.warn("RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set. Running in MOCK billing mode.");
  
  // Mock Razorpay instance for dev testing
  razorpay = {
    customers: {
      create: async (data) => {
        log.info("[MOCK] Created Razorpay customer", data);
        return { id: `cust_mock_${Math.random().toString(36).substring(7)}` };
      }
    },
    orders: {
      create: async (data) => {
        log.info("[MOCK] Created Razorpay order", data);
        return { id: `order_mock_${Math.random().toString(36).substring(7)}`, status: "created" };
      }
    }
  };
}

/**
 * Charge an API user for their token usage.
 * @param {string} customerId
 * @param {number} amountInr
 */
async function chargeCustomer(customerId, amountInr) {
  try {
    // In a real usage-based billing setup, we would create an invoice or an order.
    // For MVP, we simply log the charge.
    if (amountInr <= 0) return;
    
    log.info(`Charging customer ${customerId} ₹${amountInr}`);
    
    // Simulate order creation
    const order = await razorpay.orders.create({
      amount: amountInr * 100, // Amount in paise
      currency: "INR",
      receipt: `receipt_${Date.now()}`
    });
    
    log.info(`Payment order created: ${order.id}`);
    return order;
  } catch (e) {
    log.error(`Failed to charge customer ${customerId}: ${e.message}`);
  }
}

/**
 * Pay out a provider node for their generated tokens.
 * @param {string} accountId - e.g. UPI ID or Razorpay Route account
 * @param {number} amountInr
 */
async function payProvider(accountId, amountInr) {
  try {
    if (amountInr <= 0) return;
    log.info(`Initiating UPI payout of ₹${amountInr} to provider ${accountId}`);
    // Simulate payout success
    return { status: "processing", payout_id: `payout_${Date.now()}` };
  } catch (e) {
    log.error(`Failed to pay provider ${accountId}: ${e.message}`);
  }
}

module.exports = {
  razorpay,
  chargeCustomer,
  payProvider
};
