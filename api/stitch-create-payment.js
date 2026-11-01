import admin from 'firebase-admin';

// Initialize Firebase Admin safely
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

// Robust Helper Function to Fetch External APIs
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 8000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'SafeRideMobility/1.0',
        ...options.headers,
      },
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw new Error(`Fetch to ${resource} failed: ${error.message}`);
  }
}

// Get Stitch Access Token
async function getStitchToken() {
  const clientId = process.env.STITCH_CLIENT_ID;
  const clientSecret = process.env.STITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('STITCH_CLIENT_ID or STITCH_CLIENT_SECRET is not configured on Vercel.');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('scope', 'client_paymentrequest');

  const res = await fetchWithTimeout('https://connect.stitch.money/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Failed to fetch Stitch access token');
  }

  return data.access_token;
}

export default async function handler(req, res) {
  // CORS Headers
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

    const token = await getStitchToken();

    const graphqlQuery = `
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
    `;

    const graphqlVariables = {
      amount: { quantity: '299.00', currency: 'ZAR' },
      payerRef: `DRV-${driverId}`.substring(0, 18),
      beneficiaryRef: `SRM-${planName.replace(/\s+/g, '')}`.substring(0, 18),
    };

    const stitchRes = await fetchWithTimeout('https://api.stitch.money/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: graphqlVariables,
      }),
    });

    const stitchData = await stitchRes.json();

    if (stitchData.errors && stitchData.errors.length > 0) {
      return res.status(400).json({ error: stitchData.errors[0].message });
    }

    const paymentUrl = stitchData?.data?.clientPaymentInitiationRequestCreate?.paymentInitiationRequest?.url;

    if (!paymentUrl) {
      return res.status(500).json({ error: 'Stitch did not return a valid redirect URL.' });
    }

    return res.status(200).json({ success: true, redirectUrl: paymentUrl });

  } catch (err) {
    console.error('Fetch execution crash:', err.message);
    return res.status(500).json({ error: err.message || 'Fetch failed' });
  }
}