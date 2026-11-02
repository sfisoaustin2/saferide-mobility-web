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

// 2. Fetch Stitch Access Token with Correct Secure Token Endpoint
async function getStitchToken() {
  const clientId = process.env.STITCH_CLIENT_ID;
  const clientSecret = process.env.STITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('STITCH_CLIENT_ID or STITCH_CLIENT_SECRET environment variable is missing on Vercel.');
  }

  const bodyParams = new URLSearchParams();
  bodyParams.append('grant_type', 'client_credentials');
  bodyParams.append('client_id', clientId.trim());
  bodyParams.append('client_secret', clientSecret.trim());
  bodyParams.append('scope', 'client_paymentrequest');

  // Corrected Stitch token URL
  const tokenRes = await fetch('https://secure.stitch.money/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'SafeRideMobility/1.0'
    },
    body: bodyParams.toString()
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    const errorMsg = tokenData.error_description || tokenData.error || 'Failed to authenticate with Stitch API';
    throw new Error(`Stitch OAuth Token Error (${tokenRes.status}): ${errorMsg}`);
  }

  return tokenData.access_token;
}

// 3. Vercel Serverless Function Handler
export default async function handler(req, res) {
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
        console.warn('Could not parse PAYMENT_PLANS_JSON, falling back to standard plan pricing.');
      }
    }

    const amountInRands = planPrices[planName] || 299;
    const formattedAmount = amountInRands.toFixed(2);

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
      amount: { quantity: formattedAmount, currency: 'ZAR' },
      payerRef: `DRV-${driverId}`.substring(0, 18),
      beneficiaryRef: `SRM-${planName.replace(/\s+/g, '')}`.substring(0, 18),
    };

    const stitchRes = await fetch('https://api.stitch.money/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'SafeRideMobility/1.0'
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

    const redirectUrl = stitchData?.data?.clientPaymentInitiationRequestCreate?.paymentInitiationRequest?.url;

    if (!redirectUrl) {
      return res.status(500).json({ error: 'Stitch did not return a checkout redirect URL.' });
    }

    if (admin.apps.length) {
      try {
        await admin.database().ref(`payments/${driverId}`).push({
          planName,
          amountInRands,
          status: 'initiated',
          timestamp: new Date().toISOString(),
        });
      } catch (dbErr) {
        console.warn('Database logging note:', dbErr.message);
      }
    }

    return res.status(200).json({ success: true, redirectUrl });

  } catch (err) {
    console.error('Stitch Checkout Handler Error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}