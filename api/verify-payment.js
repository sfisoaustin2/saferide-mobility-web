const admin = require('firebase-admin');
const axios = require('axios');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Handle private key newline formatting securely
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
    }),
    databaseURL: "https://saferide-mobility-c545a-default-rtdb.europe-west1.firebasedatabase.app"
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { reference, driverUid } = req.body;

  if (!reference || !driverUid) {
    return res.status(400).json({ success: false, error: 'Missing payment reference or driver ID' });
  }

  try {
    // Verify transaction with Paystack Secret Key
    const paystackRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` // Your sk_test_... key
        }
      }
    );

    const paymentData = paystackRes.data.data;

    if (paymentData.status === 'success') {
      // Update driver record in Firebase Realtime Database
      await admin.database().ref(`drivers/${driverUid}`).update({
        subscriptionStatus: 'ACTIVE',
        paystackCustomerCode: paymentData.customer.customer_code,
        paystackSubscriptionCode: paymentData.subscription_code || null,
        lastPaymentRef: reference,
        lastPaidAt: admin.database.ServerValue.TIMESTAMP
      });

      return res.status(200).json({ 
        success: true, 
        message: 'Payment verified successfully and subscription activated.' 
      });
    } else {
      return res.status(400).json({ 
        success: false, 
        error: 'Transaction status was: ' + paymentData.status 
      });
    }

  } catch (error) {
    console.error('Paystack verification error:', error.response ? error.response.data : error.message);
    return res.status(500).json({ 
      success: false, 
      error: 'Server error verifying Paystack transaction.' 
    });
  }
};s