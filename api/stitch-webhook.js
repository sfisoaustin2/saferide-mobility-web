import crypto from 'crypto';
import { db } from '../src/firebase.js';

export const config = {
  api: {
    bodyParser: false, // Required for raw body signature verification
  },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers['x-stitch-signature'];
    const secret = process.env.STITCH_WEBHOOK_SECRET;

    // Verify webhook signature if secret is present
    if (secret && signature) {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

      if (signature !== expectedSignature) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const { externalReference, status, id: stitchTransactionId } = payload;

    if (externalReference) {
      const isSuccess = status === 'completed' || status === 'paid';
      
      await db.ref(`transactions/${externalReference}`).update({
        status: isSuccess ? 'success' : status.toLowerCase(),
        stitchTransactionId: stitchTransactionId || null,
        updatedAt: new Date().toISOString(),
      });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook Handler Error:', error);
    return res.status(500).json({ error: 'Webhook handler processing error' });
  }
}