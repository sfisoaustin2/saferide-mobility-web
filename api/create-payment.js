import admin from 'firebase-admin';

// Initialize Firebase Admin securely
if (!admin.apps.length) {
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (serviceAccountBase64) {
    const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://saferide-mobility-c545a-default-rtdb.europe-west1.firebasedatabase.app"
    });
  } else {
    admin.initializeApp();
  }
}

const adminDb = admin.database();
const STITCH_BASE_URL = "https://express.stitch.money";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getStitchAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const clientId = process.env.STITCH_EXPRESS_CLIENT_ID;
  const clientSecret = process.env.STITCH_EXPRESS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("STITCH_CREDENTIALS_MISSING");
  }

  const response = await fetch(`${STITCH_BASE_URL}/api/v1/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      clientId,
      clientSecret,
      scope: "client_paymentrequest"
    })
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.success || !result.data?.accessToken) {
    console.error("Stitch token request failed:", { status: response.status, response: result });
    throw new Error("STITCH_AUTHENTICATION_FAILED");
  }

  cachedToken = result.data.accessToken;
  tokenExpiresAt = Date.now() + (14 * 60 * 1000); // 14 minutes
  return cachedToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { amount, userId, rideId } = req.body;

    if (!amount || !userId) {
      return res.status(400).json({ error: 'Missing required parameters (amount, userId)' });
    }

    const accessToken = await getStitchAccessToken();
    const amountInCents = Math.round(parseFloat(amount) * 100);
    const reference = `SRM-${Date.now()}-${userId.substring(0, 5)}`;

    // Request Payment Link from Stitch Express API
    const paymentResponse = await fetch(`${STITCH_BASE_URL}/api/v1/payment-requests`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        amount: {
          currency: "ZAR",
          quantity: parseFloat(amount)
        },
        reference: reference,
        externalReference: reference,
        description: `SafeRide Mobility Subscription #${rideId || 'General'}`
      })
    });

    const paymentResult = await paymentResponse.json().catch(() => ({}));

    if (!paymentResponse.ok || !paymentResult.success) {
      console.error("Stitch payment creation failed:", paymentResult);
      throw new Error(paymentResult.error?.message || "STITCH_PAYMENT_CREATION_FAILED");
    }

    const paymentUrl = paymentResult.data?.url || paymentResult.data?.paymentUrl;

    if (!paymentUrl) {
      throw new Error("STITCH_PAYMENT_URL_MISSING_IN_RESPONSE");
    }

    // Save pending transaction state in Firebase Realtime Database
    await adminDb.ref(`transactions/${reference}`).set({
      userId,
      rideId: rideId || null,
      amount: parseFloat(amount),
      amountInCents,
      status: 'pending',
      paymentUrl,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      reference,
      paymentUrl,
    });
  } catch (error) {
    console.error('Create Payment Error:', error);
    return res.status(500).json({
      error: 'Failed to initiate Stitch Express payment',
      details: error.message || String(error),
    });
  }
}