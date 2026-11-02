import { db } from '../src/firebase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { ref } = req.query;

  if (!ref) {
    return res.status(400).json({ error: 'Reference parameter (ref) is required' });
  }

  try {
    const snapshot = await db.ref(`transactions/${ref}`).once('value');
    if (!snapshot.exists()) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    return res.status(200).json({
      success: true,
      transaction: snapshot.val(),
    });
  } catch (error) {
    console.error('Fetch Status Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}