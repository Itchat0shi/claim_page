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

// Serve static files - Railway optimized
app.use(express.static(path.join(__dirname, 'public')));

// Explicit root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ======================
// REDIS CLIENT - Railway Optimized
// ======================
const redisClient = createClient({ 
  url: process.env.REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 100, 5000),
  }
});

redisClient.on('error', err => {
  console.error('❌ Redis Client Error:', err);
});

redisClient.on('connect', () => console.log('🔄 Connecting to Redis...'));
redisClient.on('ready', () => {
  console.log('✅ Redis connected successfully - using Set + Hashes for claims');
});

(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('❌ Failed to connect to Redis:', err.message);
  }
})();

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
    const isClaimed = await redisClient.sIsMember('claimed-addresses', address.toLowerCase());
    if (isClaimed) {
      return res.json({ verified: false, message: 'This wallet has already claimed.' });
    }

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
    const isClaimed = await redisClient.sIsMember('claimed-addresses', address.toLowerCase());
    if (isClaimed) return res.status(400).json({ error: 'Already claimed' });

    const inscriptions = await getUserInscriptions(address);
    const match = inscriptions.find(ins => allowedInscriptionIds.has(ins.inscriptionId));
    if (!match) return res.status(400).json({ error: 'Invalid inscription' });

    // Mark as claimed
    await redisClient.sAdd('claimed-addresses', address.toLowerCase());

    // Save claim data (with shipped field)
    const claimData = {
      address,
      name,
      shippingAddress,
      notes: notes || '',
      inscriptionId: match.inscriptionId,
      timestamp: new Date().toISOString(),
      shipped: 'false'
    };

    await redisClient.hSet(`claim:${address}`, claimData);

    console.log('✅ New claim saved:', claimData);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ======================
// ADMIN ROUTE (simple password protection)
// ======================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-in-railway';

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ======================
// ADMIN CLAIMS LIST (with shipped status)
// ======================
app.get('/api/admin/claims', async (req, res) => {
  const { pass } = req.query;
  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const claimKeys = await redisClient.keys('claim:*') || [];
    
    const claims = [];
    for (const key of claimKeys) {
      const data = await redisClient.hGetAll(key);
      if (Object.keys(data).length > 0) {
        claims.push({
          address: data.address,
          name: data.name,
          shippingAddress: data.shippingAddress,
          notes: data.notes || '',
          inscriptionId: data.inscriptionId,
          timestamp: data.timestamp,
          shipped: data.shipped || false   // ← Important for checkbox
        });
      }
    }

    // Sort newest first
    claims.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({ 
      total: claims.length, 
      claims 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ======================
// MARK AS SHIPPED
// ======================
app.post('/api/admin/mark-shipped', async (req, res) => {
  const { pass, address, shipped } = req.body;

  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!address) {
    return res.status(400).json({ error: 'Address required' });
  }

  try {
    const key = `claim:${address}`;
    await redisClient.hSet(key, 'shipped', shipped ? 'true' : 'false');
    console.log(`📦 Claim ${address} marked as shipped: ${shipped}`);
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
  console.log(`📁 Serving frontend from ${path.join(__dirname, 'public')}`);
});
