import admin from 'firebase-admin';

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
  } else {
    console.warn('Firebase configuration missing in environment variables.');
  }
}

// 2. Fetch Stitch OAuth Client Token
async function getStitchToken() {
  const clientId = process.env.STITCH_CLIENT_ID;
  const clientSecret = process.env.STITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Stitch environment credentials (STITCH_CLIENT_ID / STITCH_CLIENT_SECRET) are missing.');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('scope', 'client_paymentrequest');

  const response = await fetch('https://connect.stitch.money/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Failed to obtain Stitch access token.');
  }

  return data.access_token;
}

// 3. Main Vercel Serverless Function Handler
export default async function handler(req, res) {
  // Global CORS headers to clear browser options preflight
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  // Instantly resolve CORS Preflight (OPTIONS) requests
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

    // Resolve subscription price from environment variables
    let planPrices = {
      'Standard': 199,
      'Pro Defender': 299,
      'Fleet Commander': 499,
    };

    if (process.env.PAYMENT_PLANS_JSON) {
      try {
        planPrices = JSON.parse(process.env.PAYMENT_PLANS_JSON);
      } catch (e) {
        console.warn('Could not parse PAYMENT_PLANS_JSON env var, falling back to defaults.');
      }
    }

    const amountInRands = planPrices[planName];
    if (!amountInRands) {
      return res.status(400).json({ error: `Invalid subscription plan specified: ${planName}` });
    }

    // Amount formatted in cents for integer currency calculations
    const amountInCents = Math.round(amountInRands * 100);

    // Fetch Token and Initiate Stitch Payment Mutation
    const token = await getStitchToken();

    const graphqlQuery = `
      mutation CreatePayment($amount: MoneyInput!, $payerRef: String!, $beneficiaryRef: String!) {
        clientPaymentInitiationRequestCreate(input: {
          amount: $amount,
          payerReference: $payerRef,
          beneficiaryReference: $beneficiaryRef,
          expireAt: "2026-12-31"
        }) {
          paymentInitiationRequest {
            id
            url
          }
        }
      }
    `;

    const graphqlVariables = {
      amount: { quantity: (amountInCents / 100).toFixed(2), currency: 'ZAR' },
      payerRef: `DRV-${driverId}`.substring(0, 18),
      beneficiaryRef: `SRM-${planName.replace(/\s+/g, '')}`.substring(0, 18),
    };

    const stitchRes = await fetch('https://api.stitch.money/graphql', {
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
      console.error('Stitch GraphQL Errors:', stitchData.errors);
      return res.status(400).json({ error: stitchData.errors[0].message });
    }

    const paymentUrl = stitchData?.data?.clientPaymentInitiationRequestCreate?.paymentInitiationRequest?.url;

    if (!paymentUrl) {
      return res.status(500).json({ error: 'Stitch did not return a checkout redirect URL.' });
    }

    // Optional: Log payment initiation state in Firebase
    if (admin.apps.length) {
      try {
        await admin.database().ref(`payments/${driverId}`).push({
          planName,
          amountInRands,
          status: 'initiated',
          timestamp: new Date().toISOString(),
        });
      } catch (dbErr) {
        console.error('Firebase DB log warning:', dbErr.message);
      }
    }

    return res.status(200).json({ success: true, redirectUrl: paymentUrl });

  } catch (err) {
    console.error('Backend execution crash:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}