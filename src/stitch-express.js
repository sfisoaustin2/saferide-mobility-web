const BASE_URL = "https://express.stitch.money";

const TOKEN_URL = `${BASE_URL}/api/v1/token`;

const tokenCache = new Map();

async function readResponse(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Stitch returned an invalid JSON response.");
  }
}

async function getStitchToken(
  scope = "client_recurringpaymentconsentrequest",
  forceRefresh = false
) {
  const cached = tokenCache.get(scope);

  if (
    !forceRefresh &&
    cached &&
    Date.now() < cached.expiresAt
  ) {
    return cached.token;
  }

  const clientId = process.env.STITCH_CLIENT_ID;
  const clientSecret = process.env.STITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing Stitch credentials in Vercel.");
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      clientId,
      clientSecret,
      scope
    })
  });

  const result = await readResponse(response);

  if (!response.ok || !result.success) {
    throw new Error(
      `Stitch authentication failed (${response.status}): ${
        result.message || result.error || "Unable to get token"
      }`
    );
  }

  const token = result.data?.accessToken;

  if (!token) {
    throw new Error("Stitch did not return an access token.");
  }

  tokenCache.set(scope, {
    token,
    expiresAt: Date.now() + 14 * 60 * 1000
  });

  return token;
}

async function stitchRequest(
  path,
  options = {},
  scope = "client_recurringpaymentconsentrequest"
) {
  let token = await getStitchToken(scope);

  async function sendRequest(accessToken) {
    return fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
        Authorization: `Bearer ${accessToken}`
      }
    });
  }

  let response = await sendRequest(token);

  if (response.status === 401) {
    token = await getStitchToken(scope, true);
    response = await sendRequest(token);
  }

  const result = await readResponse(response);

  if (!response.ok || result.success === false) {
    throw new Error(
      `Stitch API error (${response.status}): ${
        result.message || result.error || "Request failed"
      }`
    );
  }

  return result;
}

/**
 * Create a recurring subscription.
 *
 * Requires Stitch to enable:
 * client_recurringpaymentconsentrequest
 */
async function createExpressSubscription(payload) {
  const requiredFields = [
    "amount",
    "email",
    "initialAmount",
    "merchantReference",
    "payerFullName",
    "payerId",
    "recurrence",
    "startDate"
  ];

  for (const field of requiredFields) {
    if (
      payload?.[field] === undefined ||
      payload?.[field] === null ||
      payload?.[field] === ""
    ) {
      throw new Error(`Missing subscription field: ${field}`);
    }
  }

  if (
    !Number.isInteger(payload.amount) ||
    !Number.isInteger(payload.initialAmount) ||
    payload.amount < 100 ||
    payload.initialAmount < 100
  ) {
    throw new Error(
      "Subscription amounts must be integer cents and at least 100."
    );
  }

  if (payload.merchantReference.length > 50) {
    throw new Error("Merchant reference cannot exceed 50 characters.");
  }

  if (payload.payerFullName.length > 20) {
    throw new Error("Payer full name cannot exceed 20 characters.");
  }

  if (
    !payload.recurrence ||
    typeof payload.recurrence !== "object"
  ) {
    throw new Error("A valid recurrence object is required.");
  }

  return stitchRequest(
    "/api/v1/subscriptions",
    {
      method: "POST",
      body: JSON.stringify(payload)
    },
    "client_recurringpaymentconsentrequest"
  );
}

/**
 * Retrieve a payment by its Stitch payment ID.
 */
async function getExpressPayment(paymentId) {
  if (!paymentId || typeof paymentId !== "string") {
    throw new Error("A valid Stitch payment ID is required.");
  }

  return stitchRequest(
    `/api/v1/payment/${encodeURIComponent(paymentId)}`,
    { method: "GET" },
    "client_recurringpaymentconsentrequest"
  );
}

/**
 * Verify a retrieved payment.
 */
async function verifyExpressPayment(
  paymentId,
  expectedAmount,
  expectedReference
) {
  const result = await getExpressPayment(paymentId);
  const payment = result.data?.payment;

  if (!payment) {
    throw new Error("Stitch payment details were not returned.");
  }

  if (payment.status !== "PAID") {
    return {
      verified: false,
      reason: "Payment is not marked PAID."
    };
  }

  if (Number(payment.amount) !== Number(expectedAmount)) {
    throw new Error("Payment amount does not match.");
  }

  if (
    expectedReference &&
    payment.merchantReference !== expectedReference
  ) {
    throw new Error("Payment reference does not match.");
  }

  return {
    verified: true,
    payment
  };
}

module.exports = {
  getStitchToken,
  createExpressSubscription,
  getExpressPayment,
  verifyExpressPayment
};