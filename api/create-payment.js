const admin = require('firebase-admin');
const serviceAccount = require('../saferide-mobility-c545a-firebase-adminsdk-fbsvc-3dac23a90d.json');

// Initialize Firebase Admin securely
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://saferide-mobility-c545a-default-rtdb.europe-west1.firebasedatabase.app"
    });
}

const db = admin.database();

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const { reference, driverPhone } = req.body;

    if (!reference) {
        return res.status(400).json({ success: false, message: 'Missing transaction reference' });
    }

    try {
        // Verify transaction with Paystack API using your Secret Key from environment variables
        const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const result = await paystackResponse.json();

        if (result.status && result.data.status === 'success') {
            const metadata = result.data.metadata || {};
            const driverId = metadata.driver_id;
            const tier = metadata.tier || 'Standard EVO7B (R300/mo)';

            if (driverId) {
                // Update driver subscription status to ACTIVE in Firebase Realtime Database
                await db.ref('drivers/' + driverId).update({
                    subscriptionStatus: 'ACTIVE',
                    tier: tier,
                    lastPaymentRef: reference,
                    paidAt: Date.now()
                });
            }

            return res.status(200).json({ 
                success: true, 
                message: 'Subscription verified and active in Firebase.' 
            });
        } else {
            return res.status(400).json({ 
                success: false, 
                message: 'Payment verification failed or was not completed.' 
            });
        }

    } catch (error) {
        console.error('Paystack verification error:', error);
        return res.status(500).json({ success: false, message: 'Server error during payment verification.' });
    }
};