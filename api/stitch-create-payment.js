import { createStitchPaymentLink } from '../src/services/stitch.js';
import { db } from '../src/firebase.js';

export default async function handler(req, res) {
  // CORS setup
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
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
      return res.status(400).json({ error: 'Missing required parameters (amount, userId)' });
    }

    // Convert Rand to Cents
    const amountInCents = Math.round(parseFloat(amount) * 100);
    const reference = `SRM-${Date.now()}-${userId.substring(0, 5)}`;

    // Create Payment Link via Stitch Express API
    const paymentData = await createStitchPaymentLink({
      amountInCents,
      externalReference: reference,
      description: `SafeRide Mobility Ride #${rideId || 'General'}`,
    });

    // Save initial transaction state in Firebase Realtime Database
    await db.ref(`transactions/${reference}`).set({
      userId,
      rideId: rideId || null,
      amount: parseFloat(amount),
      amountInCents,
      status: 'pending',
      paymentUrl: paymentData.url || paymentData.paymentUrl,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      reference,
      paymentUrl: paymentData.url || paymentData.paymentUrl,
    });
  } catch (error) {
    console.error('Create Payment Error:', error);
    return res.status(500).json({
      error: 'Failed to initiate Stitch Express payment',
      details: error.message || error,
    });
  }
}