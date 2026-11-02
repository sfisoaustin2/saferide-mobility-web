import admin from 'firebase-admin';
import https from 'https';

// Safe Firebase Admin Initialization
if (!admin.apps.length) {
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  const privateKey = rawKey ? rawKey.replace(/\\n/g, '\n') : undefined;

  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && privateKey) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: privateKey,
        }),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
      });
    } catch (err) {
      console.error('Firebase Admin initialization error:', err.message);
    }
  }
}

// HTTPS Helper for Vercel Serverless
function makeHttpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', (err) => { reject(err); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });

    if (postData) req.write(postData);
    req.end();
  });
}

// Get Stitch Express Token
async function getExpressToken() {
  const clientId = (process.env.STITCH_CLIENT_ID || '').trim();
  const clientSecret = (process.env.STITCH_CLIENT_SECRET || '').trim();

  if (!clientId || !clientSecret) {
    throw new Error('STITCH_CLIENT_ID or STITCH_CLIENT_SECRET is missing on Vercel.');
  }

  const postData = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials'
  });

  const options = {
    hostname: 'express.stitch.money',
    path: '/api/v1/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Accept': 'application/json',
      'User-Agent': 'SafeRideMobility/1.0'
    },
    timeout: 10000
  };

  const response = await makeHttpsRequest(options, postData);

  if (response.status !== 200) {
    throw new Error(`Stitch Express Token Error (${response.status}): ${JSON.stringify(response.data)}`);
  }

  return response.data.access_token || response.data.data?.access_token;
}

// Vercel Serverless Function Handler
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { planName, driverId } = req.body || {};
    if (!planName || !driverId) {
      return res.status(400).json({ error: 'Missing planName or driverId in request body.' });
    }

    // Pricing in South African Cents (e.g. R299.00 = 29900 cents)
    const planPricesCents = {
      'Standard': 19900,
      'Pro Defender': 29900,
      'Fleet Commander': 49900,
    };

    const amountInCents = planPricesCents[planName] || 29900;

    // Get Express Token
    const token = await getExpressToken();

    // Create Payment Link via Stitch Express REST API
    const paymentLinkPayload = JSON.stringify({
      amount: amountInCents,
      payerName: `Driver ${driverId}`,
      merchantReference: `SRM-${driverId}-${Date.now().toString().slice(-4)}`
    });

    const paymentLinkOptions = {
      hostname: 'express.stitch.money',
      path: '/api/v1/payment-links',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(paymentLinkPayload),
        'Accept': 'application/json',
        'User-Agent': 'SafeRideMobility/1.0'
      },
      timeout: 10000
    };

    const linkRes = await makeHttpsRequest(paymentLinkOptions, paymentLinkPayload);

    if (linkRes.status !== 200 && linkRes.status !== 201) {
      throw new Error(`Stitch Payment Link Creation Failed (${linkRes.status}): ${JSON.stringify(linkRes.data)}`);
    }

    // Extract checkout link from Stitch Express response schema
    const redirectUrl = linkRes.data?.data?.payment?.link || linkRes.data?.link;

    if (!redirectUrl) {
      return res.status(500).json({ error: 'Stitch Express did not return a valid payment URL.' });
    }

    return res.status(200).json({ success: true, redirectUrl });

  } catch (err) {
    console.error('Stitch Express Checkout Error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}