import admin from 'firebase-admin';

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY
        ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        : undefined,
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

export default async function handler(req, res) {
  // 1. Enable CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { driverId, amountInRands, planName } = req.body;

  if (!driverId || !amountInRands) {
    return res.status(400).json({ error: 'Missing driverId or amount' });
  }

  try {
    // 2. Fetch Bearer Token from Stitch Secure Authentication API
    const tokenRes = await fetch('https://secure.stitch.money/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: process.env.STITCH_CLIENT_ID,
        client_secret: process.env.STITCH_CLIENT_SECRET,
        audience: 'https://api.stitch.money/'
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Stitch Token Error:', tokenData);
      throw new Error(tokenData.error_description || tokenData.message || 'Token authentication failed');
    }

    const accessToken = tokenData.access_token;

    // 3. Call Stitch GraphQL API to initialize client payment
    const graphqlRes = await fetch('https://api.stitch.money/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: `
          mutation CreateClientPayment($input: ClientPaymentInitInput!) {
            clientPaymentInit(input: $input) {
              paymentId
              checkoutUrl
            }
          }
        `,
        variables: {
          input: {
            amount: {
              quantity: parseFloat(amountInRands),
              currency: 'ZAR'
            },
            reference: `SafeRide-${driverId}-${Date.now()}`
          }
        }
      }),
    });

    const graphqlData = await graphqlRes.json();

    if (graphqlData.errors) {
      console.error('Stitch GraphQL Errors:', graphqlData.errors);
      throw new Error(graphqlData.errors[0].message || 'Payment link creation failed');
    }

    const paymentResult = graphqlData.data.clientPaymentInit;

    return res.status(200).json({
      success: true,
      paymentUrl: paymentResult.checkoutUrl,
      paymentId: paymentResult.paymentId,
    });

  } catch (error) {
    console.error('Stitch API Exception:', error);
    return res.status(500).json({ error: error.message || 'Failed to connect to backend payment service' });
  }
}