import admin from 'firebase-admin';

// 1. Initialize Firebase Admin SDK
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

// 2. Stitch Token Manager (Caching & Automatic 15-min Refresh)
async function getStitchAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const clientId = process.env.STITCH_EXPRESS_CLIENT_ID;
  const clientSecret = process.env.STITCH_EXPRESS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("STITCH_CREDENTIALS_MISSING: Verify Vercel Environment Variables");
  }

  const response = await fetch(`${STITCH_BASE_URL}/api/v1/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      scope: "client_paymentrequest"
    })
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.success || !result.data?.accessToken) {
    console.error("Stitch Auth Error:", { status: response.status, response: result });
    throw new Error(result.message || "STITCH_AUTHENTICATION_FAILED");
  }

  cachedToken = result.data.accessToken;
  // Tokens expire in 15 minutes; refresh at 14 minutes
  tokenExpiresAt = Date.now() + (14 * 60 * 1000); 
  return cachedToken;
}

// 3. Main Serverless Route Handler
export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
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
      return res.status(400).json({ error: 'Missing required parameters: amount, userId' });
    }

    // Convert amount to South African Cents (e.g. 299.00 -> 29900)
    const amountInCents = Math.round(parseFloat(amount) * 100);
    const merchantReference = `SRM-${Date.now()}-${userId.substring(0, 5)}`;

    // Get short-lived Stitch API access token
    const accessToken = await getStitchAccessToken();

    // Create Payment Link via official POST /api/v1/payment-links endpoint
    const paymentResponse = await fetch(`${STITCH_BASE_URL}/api/v1/payment-links`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        amount: amountInCents,
        merchantReference: merchantReference,
        description: `SafeRide Mobility Tier Subscription #${rideId || 'General'}`
      })
    });

    const paymentResult = await paymentResponse.json().catch(() => ({}));

    if (!paymentResponse.ok || !paymentResult.success || !paymentResult.data?.url) {
      console.error("Stitch Payment Link Error:", paymentResult);
      throw new Error(paymentResult.generalErrors?.[0] || paymentResult.message || "STITCH_PAYMENT_CREATION_FAILED");
    }

    const paymentUrl = paymentResult.data.url;
    const paymentLinkId = paymentResult.data.id;

    // Record pending transaction in Firebase Realtime Database
    await adminDb.ref(`transactions/${merchantReference}`).set({
      userId,
      rideId: rideId || null,
      paymentLinkId,
      amountInCents,
      amountInRands: parseFloat(amount),
      status: 'pending',
      paymentUrl,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      reference: merchantReference,
      paymentUrl: paymentUrl,
    });
  } catch (error) {
    console.error('Create Payment Handler Failure:', error);
    return res.status(500).json({
      error: 'Failed to initiate Stitch Express payment',
      details: error.message || String(error),
    });
  }
}