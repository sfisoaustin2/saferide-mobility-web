import admin from 'firebase-admin';
import https from 'https';

// 1. Safe Firebase Admin Initialization
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

// 2. HTTPS Request Helper
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

// 3. Get Stitch Token (Using Sandbox / Test URLs)
async function getStitchToken() {
  const clientId = (process.env.STITCH_CLIENT_ID || '').trim();
  const clientSecret = (process.env.STITCH_CLIENT_SECRET || '').trim();

  if (!clientId || !clientSecret) {
    throw new Error('STITCH_CLIENT_ID or STITCH_CLIENT_SECRET environment variable is missing on Vercel.');
  }

  const postData = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'client_paymentrequest'
  }).toString();

  // FIX: Use secure.stitch.money (or test sandbox URL if specified by Stitch)
  const options = {
    hostname: 'secure.stitch.money',
    path: '/connect/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
      'Accept': 'application/json',
      'User-Agent': 'SafeRideMobility/1.0'
    },
    timeout: 10000
  };

  const response = await makeHttpsRequest(options, postData);

  if (response.status !== 200) {
    const errObj = response.data;
    const errMsg = errObj.error_description || errObj.error || JSON.stringify(errObj) || 'Authentication failed';
    throw new Error(`Stitch Token Error (${response.status}): ${errMsg}`);
  }

  return response.data.access_token;
}

// 4. Main Serverless Function Handler
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

    const planPrices = { 'Standard': 199, 'Pro Defender': 299, 'Fleet Commander': 499 };
    const amountInRands = planPrices[planName] || 299;

    const token = await getStitchToken();

    const graphqlPayload = JSON.stringify({
      query: `
        mutation CreatePayment($amount: MoneyInput!, $payerRef: String!, $beneficiaryRef: String!) {
          clientPaymentInitiationRequestCreate(input: {
            amount: $amount,
            payerReference: $payerRef,
            beneficiaryReference: $beneficiaryRef
          }) {
            paymentInitiationRequest {
              id
              url
            }
          }
        }
      `,
      variables: {
        amount: { quantity: amountInRands.toFixed(2), currency: 'ZAR' },
        payerRef: `DRV-${driverId}`.substring(0, 18),
        beneficiaryRef: `SRM-${planName.replace(/\s+/g, '')}`.substring(0, 18)
      }
    });

    // FIX: Use Stitch API GraphQL endpoint
    const graphqlOptions = {
      hostname: 'api.stitch.money',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(graphqlPayload),
        'User-Agent': 'SafeRideMobility/1.0'
      },
      timeout: 10000
    };

    const stitchRes = await makeHttpsRequest(graphqlOptions, graphqlPayload);
    const stitchData = stitchRes.data;

    if (stitchData.errors && stitchData.errors.length > 0) {
      return res.status(400).json({ error: stitchData.errors[0].message });
    }

    const redirectUrl = stitchData?.data?.clientPaymentInitiationRequestCreate?.paymentInitiationRequest?.url;
    if (!redirectUrl) {
      return res.status(500).json({ error: 'Stitch did not return a valid payment redirect URL.' });
    }

    return res.status(200).json({ success: true, redirectUrl });

  } catch (err) {
    console.error('Checkout Error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}