import admin from 'firebase-admin';

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

const db = admin.database();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const event = req.body;

    if (event.event_type === 'payment.paid' || event.status === 'paid') {
      const driverId = event.external_reference || event.data?.external_reference;
      const amountInCents = event.amount || event.data?.amount;
      const amountInRands = amountInCents ? amountInCents / 100 : 0;

      if (driverId) {
        let subscriptionTier = 'Standard Defender';
        if (amountInRands >= 499) subscriptionTier = 'Fleet Commander';
        else if (amountInRands >= 299) subscriptionTier = 'Pro Defender';

        // Instant Realtime Database Update
        await db.ref(`drivers/${driverId}`).update({
          subscriptionStatus: 'ACTIVE',
          subscriptionTier: subscriptionTier,
          lastPaymentDate: new Date().toISOString(),
          paymentGateway: 'Stitch Express',
          updatedAt: admin.database.ServerValue.TIMESTAMP,
        });

        console.log(`Driver ${driverId} subscription activated via Stitch Webhook.`);
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Stitch Webhook Error:', error);
    return res.status(500).send('Webhook Handler Error');
  }
}