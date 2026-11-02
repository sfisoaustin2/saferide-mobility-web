import https from 'https';

function makeHttpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(parsed);
          }
        } catch (err) {
          reject({ error: 'Failed to parse JSON response', raw: data });
        }
      });
    });

    req.on('error', (err) => reject(err));
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

export async function getStitchAccessToken() {
  const payload = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.STITCH_CLIENT_ID,
    client_secret: process.env.STITCH_CLIENT_SECRET,
    scope: 'payment_initiation',
  }).toString();

  const options = {
    hostname: 'express.stitch.money',
    path: '/api/v1/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const response = await makeHttpsRequest(options, payload);
  return response.access_token;
}

export async function createStitchPaymentLink({ amountInCents, externalReference, description }) {
  const token = await getStitchAccessToken();

  const payload = JSON.stringify({
    amount: amountInCents, // Amount in South African Cents (e.g., 5000 = R50.00)
    currency: 'ZAR',
    externalReference: externalReference,
    description: description || 'SafeRide Mobility Payment',
    redirectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/payment-status?ref=${externalReference}`,
  });

  const options = {
    hostname: 'express.stitch.money',
    path: '/api/v1/payment-links',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  return await makeHttpsRequest(options, payload);
}