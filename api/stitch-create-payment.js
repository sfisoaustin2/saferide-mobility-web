import admin from 'firebase-admin';
import crypto from 'crypto';

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

const db = admin.database();

// Only allow your actual website domain.
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || ''
).split(',').map(origin => origin.trim()).filter(Boolean);

// Define your actual subscription prices here.
// Configure PAYMENT_PLANS_JSON on your server.
// Example: {"Basic":100,"Premium":200}
function getPlans() {
  try {
    return JSON.parse(process.env.PAYMENT_PLANS_JSON || '{}');
  } catch {
    throw new Error('Invalid payment plan configuration');
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({
      error: 'Origin not allowed',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed',
    });
  }

  try {
    // 1. Verify Firebase authentication
    const authHeader = req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required',
      });
    }

    const idToken = authHeader.substring(7);

    const decodedToken = await admin.auth().verifyIdToken(idToken);

    // 2. Validate request
    const { driverId, planName } = req.body || {};

    if (
      typeof driverId !== 'string' ||
      typeof planName !== 'string'
    ) {
      return res.status(400).json({
        error: 'Invalid payment information',
      });
    }

    // The authenticated user must own this driver account.
    if (decodedToken.uid !== driverId) {
      return res.status(403).json({
        error: 'You are not authorized to pay for this driver',
      });
    }

    // 3. Get the price from server configuration.
    // Never trust amountInRands supplied by the frontend.
    const plans = getPlans();
    const amount = Number(plans[planName]);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isSafeInteger(Math.round(amount * 100))
    ) {
      return res.status(400).json({
        error: 'Invalid or unavailable subscription plan',
      });
    }

    // 4. Validate Stitch credentials
    const {
      STITCH_CLIENT_ID,
      STITCH_CLIENT_SECRET,
    } = process.env;

    if (!STITCH_CLIENT_ID || !STITCH_CLIENT_SECRET) {
      throw new Error('Stitch credentials are not configured');
    }

    // 5. Request Stitch access token
    const tokenBody = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: STITCH_CLIENT_ID,
      client_secret: STITCH_CLIENT_SECRET,
      audience: 'https://secure.stitch.money/connect/token',
      scope: 'client_paymentrequest',
    });

    const tokenRes = await fetch(
      'https://secure.stitch.money/connect/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: tokenBody.toString(),
      }
    );

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('Stitch authentication failed');
      throw new Error('Unable to authenticate with payment provider');
    }

    // 6. Create a unique payment reference
    const reference = `SafeRide-${crypto.randomUUID()}`;

    // 7. Initialize payment through your existing GraphQL mutation.
    // Confirm this mutation against your Stitch account's schema.
    const graphqlRes = await fetch(
      'https://api.stitch.money/graphql',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenData.access_token}`,
        },
        body: JSON.stringify({
          query: `
            mutation CreateClientPayment(
              $input: ClientPaymentInitInput!
            ) {
              clientPaymentInit(input: $input) {
                paymentId
                checkoutUrl
              }
            }
          `,
          variables: {
            input: {
              amount: {
                quantity: amount,
                currency: 'ZAR',
              },
              reference,
            },
          },
        }),
      }
    );

    const graphqlData = await graphqlRes.json();

    if (!graphqlRes.ok || graphqlData.errors) {
      console.error(
        'Stitch payment error:',
        JSON.stringify(graphqlData.errors || graphqlData)
      );

      throw new Error('Payment creation failed');
    }

    const paymentResult =
      graphqlData.data?.clientPaymentInit;

    if (
      !paymentResult?.paymentId ||
      !paymentResult?.checkoutUrl
    ) {
      throw new Error('Invalid payment response from provider');
    }

    // 8. Save pending payment in Firebase
    const paymentRecord = {
      driverId,
      planName,
      amount,
      currency: 'ZAR',
      paymentId: paymentResult.paymentId,
      reference,
      paymentUrl: paymentResult.checkoutUrl,
      status: 'pending',
      createdAt: admin.database.ServerValue.TIMESTAMP,
    };

    await db.ref(`payments/${paymentResult.paymentId}`)
      .set(paymentRecord);

    // 9. Return checkout information
    return res.status(200).json({
      success: true,
      paymentUrl: paymentResult.checkoutUrl,
      paymentId: paymentResult.paymentId,
      reference,
      status: 'pending',
    });

  } catch (error) {
    console.error('Payment handler error:', error.message);

    return res.status(500).json({
      success: false,
      error: 'Unable to initialize payment. Please try again.',
    });
  }
}