const admin = require('firebase-admin');

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

  const event = req.body;

  try {
    if (event.event === 'charge.success') {
      const driverUid = event.data.metadata ? event.data.metadata.driver_uid : null;
      if (driverUid) {
        await admin.database().ref(`drivers/${driverUid}`).update({
          subscriptionStatus: 'ACTIVE',
          lastPaidAt: admin.database.ServerValue.TIMESTAMP
        });
      }
    }

    if (event.event === 'invoice.payment_failed') {
      const driverUid = event.data.metadata ? event.data.metadata.driver_uid : null;
      if (driverUid) {
        await admin.database().ref(`drivers/${driverUid}`).update({
          subscriptionStatus: 'PAST_DUE'
        });
      }
    }

    return res.status(200).send('Webhook received');
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).send('Server error');
  }
};