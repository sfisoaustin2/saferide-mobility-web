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

// 2. Native HTTPS Request Helper (Prevents Vercel Fetch Timeout Crashes)
function makeHttpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', (err) => { reject(err); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// 3. Obtain Stitch OAuth Token
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

  const options = {
    hostname: 'connect.stitch.money',
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
    const errMsg = response.data.error_description || response.data.error || 'Failed to authenticate with Stitch API';
    throw new Error(`Stitch OAuth Token Error (${response.status}): ${errMsg}`);
  }

  return response.data.access_token;
}

// 4. Main Vercel Serverless Function Handler
export default async function handler(req, res) {
  // Always set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
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
    const { planName, driverId } = req.body || {};

    if (!planName || !driverId) {
      return res.status(400).json({ error: 'Missing planName or driverId in request body.' });
    }

    let planPrices = {
      'Standard': 199,
      'Pro Defender': 299,
      'Fleet Commander': 499,
    };

    if (process.env.PAYMENT_PLANS_JSON) {
      try {
        planPrices = JSON.parse(process.env.PAYMENT_PLANS_JSON);
      } catch (e) {
        console.warn('Could not parse PAYMENT_PLANS_JSON env var.');
      }
    }

    const amountInRands = planPrices[planName] || 299;
    const formattedAmount = amountInRands.toFixed(2);

    // Get Token securely
    const token = await getStitchToken();

    // Stitch GraphQL Payment Initiation Request
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
        amount: { quantity: formattedAmount, currency: 'ZAR' },
        payerRef: `DRV-${driverId}`.substring(0, 18),
        beneficiaryRef: `SRM-${planName.replace(/\s+/g, '')}`.substring(0, 18)
      }
    });

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
      console.error('Stitch GraphQL Error:', stitchData.errors[0].message);
      return res.status(400).json({ error: stitchData.errors[0].message });
    }

    const redirectUrl = stitchData?.data?.clientPaymentInitiationRequestCreate?.paymentInitiationRequest?.url;

    if (!redirectUrl) {
      return res.status(500).json({ error: 'Stitch did not return a valid payment redirect URL.' });
    }

    // Firebase DB logging (optional)
    if (admin.apps.length) {
      try {
        await admin.database().ref(`payments/${driverId}`).push({
          planName,
          amountInRands,
          status: 'initiated',
          timestamp: new Date().toISOString(),
        });
      } catch (dbErr) {
        console.warn('DB Log Warning:', dbErr.message);
      }
    }

    return res.status(200).json({ success: true, redirectUrl });

  } catch (err) {
    console.error('Execution Error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}