const axios = require('axios');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { reference } = req.query;

  if (!reference) {
    return res.status(400).json({ success: false, error: 'Missing transaction reference' });
  }

  try {
    // Query Paystack API to check transaction status
    const paystackRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` // Uses your secret key
        }
      }
    );

    const txData = paystackRes.data.data;

    return res.status(200).json({
      success: true,
      status: txData.status, // e.g., 'success', 'failed', 'pending'
      amount: txData.amount / 100, // Convert cents back to ZAR
      customer: txData.customer.email,
      reference: txData.reference
    });

  } catch (error) {
    console.error('Paystack status check error:', error.response ? error.response.data : error.message);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve payment status from Paystack' 
    });
  }
};