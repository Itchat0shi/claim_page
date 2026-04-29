// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files (this must be before routes)
app.use(express.static('public'));

// Explicit root route (helps on Railway)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Redis Client
const redisClient = createClient({ 
  url: process.env.REDIS_URL 
});

redisClient.connect().catch(err => {
  console.error("Redis connection failed:", err.message);
});

redisClient.on('error', err => {
  console.error('Redis Client Error:', err);
});

// Your secret inscription IDs
const allowedInscriptionIds = new Set(
  (process.env.ALLOWED_INSCRIPTIONS || '').split(',').map(id => id.trim())
);

const UNISAT_API_KEY = process.env.UNISAT_API_KEY;

if (!UNISAT_API_KEY) {
  console.warn("⚠️ UNISAT_API_KEY is missing in environment variables!");
}

// Helper: Get user's inscriptions from UniSat
async function getUserInscriptions(address) {
  let cursor = 0;
  const size = 100;
  let all = [];

  while (true) {
    const res = await fetch(
      `https://open-api.unisat.io/v1/indexer/address/${address}/inscription-data?cursor=${cursor}&size=${size}`,
      {
        headers: { Authorization: `Bearer ${UNISAT_API_KEY}` },
      }
    );
    
    if (!res.ok) throw new Error(`UniSat API error: ${res.status}`);
    
    const json = await res.json();
    const list = json.data?.list || [];
    all = all.concat(list);

    if (list.length < size) break;
    cursor += size;
  }
  return all;
}

// ======================
// VERIFY ROUTE
// ======================
app.get('/api/verify', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  try {
    // Check if already claimed
    const isClaimed = await redisClient.sIsMember('claimed-addresses', address.toLowerCase());
    if (isClaimed) {
      return res.json({ verified: false, message: 'This wallet has already claimed.' });
    }

    // Check inscriptions
    const inscriptions = await getUserInscriptions(address);
    const match = inscriptions.find(ins => allowedInscriptionIds.has(ins.inscriptionId));

    if (match) {
      return res.json({
        verified: true,
        inscriptionId: match.inscriptionId,
      });
    }

    res.json({ verified: false, message: 'No matching inscription found.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ======================
// CLAIM ROUTE
// ======================
app.post('/api/claim', async (req, res) => {
  const { address, name, shippingAddress, notes } = req.body;

  if (!address || !name || !shippingAddress) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Double-check already claimed
    const isClaimed = await redisClient.sIsMember('claimed-addresses', address.toLowerCase());
    if (isClaimed) return res.status(400).json({ error: 'Already claimed' });

    // Double-check ownership
    const inscriptions = await getUserInscriptions(address);
    const match = inscriptions.find(ins => allowedInscriptionIds.has(ins.inscriptionId));
    if (!match) return res.status(400).json({ error: 'Invalid inscription' });

    // Mark as claimed
    await redisClient.sAdd('claimed-addresses', address.toLowerCase());

    // Save claim data
    const claimData = {
      address,
      name,
      shippingAddress,
      notes: notes || '',
      inscriptionId: match.inscriptionId,
      timestamp: new Date().toISOString(),
    };

    await redisClient.hSet(`claim:${address}`, claimData);

    console.log('✅ New claim saved:', claimData);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Serving frontend from /public`);
});