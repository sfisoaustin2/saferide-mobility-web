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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { driverId, amountInRands, planName } = req.body;

  if (!driverId || !amountInRands) {
    return res.status(400).json({ error: 'Missing driverId or amount' });
  }

  try {
    // 1. Fetch 15-minute Bearer Token from Stitch Express API
    const tokenRes = await fetch('https://express.stitch.money/api/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STITCH_CLIENT_ID,
        client_secret: process.env.STITCH_CLIENT_SECRET,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokenData.message || 'Token authentication failed');

    const accessToken = tokenData.access_token;

    // 2. Convert Rands to integer South African Cents (e.g. R299.00 -> 29900)
    const amountInCents = Math.round(parseFloat(amountInRands) * 100);

    // 3. Create Payment Link
    const paymentRes = await fetch('https://express.stitch.money/api/v1/payment-links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        amount: amountInCents,
        currency: 'ZAR',
        description: `${planName} - SafeRide Protection`,
        external_reference: driverId,
        redirect_url: 'https://saferidemobility.co.za?payment=success',
      }),
    });

    const paymentData = await paymentRes.json();
    if (!paymentRes.ok) throw new Error(paymentData.message || 'Payment link creation failed');

    return res.status(200).json({
      success: true,
      paymentUrl: paymentData.url || paymentData.redirect_url,
      paymentId: paymentData.id,
    });
  } catch (error) {
    console.error('Stitch Express API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}