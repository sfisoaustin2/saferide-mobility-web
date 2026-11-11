const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
    }),
    databaseURL: "https://saferide-mobility-c545a-default-rtdb.europe-west1.firebasedatabase.app"
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // Optional: Verify Paystack signature if secret key is present in environment variables
  const paystackSecret = process.env.PAYSTACK_SECRET_KEY;
  if (paystackSecret) {
    const hash = crypto.createHmac('sha512', paystackSecret).update(JSON.stringify(req.body)).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(400).send('Invalid Paystack signature');
    }
  }

  const event = req.body;

  try {
    const metadata = event.data && event.data.metadata ? event.data.metadata : {};
    // Support both driver_id (from inline checkout) and driver_uid
    const driverId = metadata.driver_id || metadata.driver_uid;

    // 1. Handle Successful Charges / Subscriptions
    if (event.event === 'charge.success' || event.event === 'subscription.create' || event.event === 'invoice.payment_success') {
      if (driverId) {
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
        
        await admin.database().ref(`drivers/${driverId}`).update({
          subscriptionStatus: 'ACTIVE',
          tier: metadata.tier || 'Standard',
          lastPaidAt: admin.database.ServerValue.TIMESTAMP,
          subscriptionExpiresAt: Date.now() + thirtyDaysMs
        });
      }
    }

    // 2. Handle Failed Payments / Past Due
    if (event.event === 'invoice.payment_failed') {
      if (driverId) {
        await admin.database().ref(`drivers/${driverId}`).update({
          subscriptionStatus: 'PAST_DUE'
        });
      }
    }

    // 3. Handle Canceled or Disabled Subscriptions
    if (event.event === 'subscription.disable') {
      if (driverId) {
        await admin.database().ref(`drivers/${driverId}`).update({
          subscriptionStatus: 'EXPIRED'
        });
      }
    }

    return res.status(200).send('Webhook processed successfully');
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).send('Server error');
  }
};