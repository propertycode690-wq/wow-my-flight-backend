/**
 * server/routes/clients.js
 * WowMyFlight CRM — Confirmed Travelers / Customer 360 REST API (PostgreSQL Prisma + Resilient Persistent Storage)
 * 
 * Features:
 *   - Real PostgreSQL persistence via Prisma (with upsert protection)
 *   - Persistent metadata storage (city, country, passport, preferences) - NO DUMMY FALLBACKS!
 *   - Search, status, and tier filtering
 *   - Real-time Socket.io broadcasting on create / update / delete
 * 
 * Endpoints:
 *   GET    /api/clients       - Fetch all clients
 *   GET    /api/clients/:id   - Fetch single client by ID
 *   POST   /api/clients       - Create new client & broadcast via Socket.io
 *   PUT    /api/clients/:id   - Update client profile
 *   DELETE /api/clients/:id   - Delete client
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { prisma, isDbConnected } = require('../db');

// Persistent metadata file
const METADATA_FILE = path.join(__dirname, '../store/clients_metadata.json');

function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('⚠️ [Clients API] Could not load clients_metadata.json:', e.message);
  }
  return {};
}

function saveMetadata(data) {
  try {
    const dir = path.dirname(METADATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ [Clients API] Could not save clients_metadata.json:', e.message);
  }
}

let metadataStore = loadMetadata();

// In-memory fallback cache if PostgreSQL is unreachable (initialized from persistent metadata)
let memoryClients = Object.values(metadataStore).map(m => ({
  id: m.id,
  firstName: m.firstName,
  lastName: m.lastName,
  email: m.email,
  phone: m.phone,
  nationality: m.nationality || m.country || '',
  tier: m.tier || 'Standard',
  totalSpent: m.totalSpent || 0,
  status: m.status || 'Active',
  createdAt: m.createdAt || new Date(),
  updatedAt: m.updatedAt || new Date()
})).filter(c => c.id && c.firstName);

/**
 * Format client record using ONLY real entered data (NO HARDCODED DUMMY FALLBACKS)
 */
function formatClient(c) {
  if (!c) return null;
  const store = loadMetadata();
  let meta = store[c.id] || metadataStore[c.id];
  if (!meta) {
    const values = Object.values(store);
    meta = values.find(m => (m.email && c.email && m.email.toLowerCase() === c.email.toLowerCase()) || (m.phone && c.phone && m.phone === c.phone)) || {};
  }

  const city = meta.city || c.city || '';
  const country = meta.country || c.country || c.nationality || '';
  const nationality = meta.nationality || c.nationality || country || '';
  const preferredCabinClass = meta.preferredCabinClass || c.preferredCabinClass || '';
  const passportNumber = meta.passportNumber || c.passportNumber || '';
  const passportExpiry = meta.passportExpiry || c.passportExpiry || '';
  const seatPreference = meta.seatPreference || c.seatPreference || '';
  const mealPreference = meta.mealPreference || c.mealPreference || '';
  const timezone = meta.timezone || c.timezone || '';
  const preferredLanguage = meta.preferredLanguage || c.preferredLanguage || '';
  const tier = meta.tier || c.tier || 'Standard';

  let totalSpentFormatted = '$0';
  if (typeof c.totalSpent === 'number') {
    totalSpentFormatted = `$${c.totalSpent.toLocaleString()}`;
  } else if (c.totalSpent !== undefined && c.totalSpent !== null && c.totalSpent !== '') {
    totalSpentFormatted = String(c.totalSpent).startsWith('$') ? String(c.totalSpent) : `$${c.totalSpent}`;
  }

  return {
    ...c,
    city,
    country,
    nationality,
    preferredCabinClass,
    passportNumber,
    passportExpiry,
    seatPreference,
    mealPreference,
    timezone,
    preferredLanguage,
    tier,
    totalSpent: totalSpentFormatted,
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. GET /api/clients
 * Fetch all clients with optional filters: search, status, tier
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.get('/', async (req, res) => {
  try {
    metadataStore = loadMetadata();
    const { search, status, tier } = req.query;

    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
      try {
        const where = {};
        if (status && status !== 'all' && status !== 'All') {
          where.status = status;
        }
        if (tier && tier !== 'all' && tier !== 'All') {
          where.tier = tier;
        }
        if (search) {
          where.OR = [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
          ];
        }

        const dbClients = await prisma.client.findMany({
          where,
          orderBy: { createdAt: 'desc' },
        });

        return res.json({
          success: true,
          source: 'PostgreSQL Database',
          count: dbClients.length,
          data: dbClients.map(formatClient),
        });
      } catch (dbErr) {
        console.warn('⚠️ [Clients API] DB query failed, falling back to memory:', dbErr.message);
      }
    }

    // Filter memory cache
    let filteredMem = [...memoryClients];
    if (status && status !== 'all' && status !== 'All') {
      filteredMem = filteredMem.filter((c) => c.status?.toLowerCase() === status.toLowerCase());
    }
    if (tier && tier !== 'all' && tier !== 'All') {
      filteredMem = filteredMem.filter((c) => c.tier?.toLowerCase() === tier.toLowerCase());
    }
    if (search) {
      const q = search.toLowerCase();
      filteredMem = filteredMem.filter((c) =>
        `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone?.includes(q)
      );
    }

    return res.json({
      success: true,
      source: 'Memory Cache',
      count: filteredMem.length,
      data: filteredMem.map(formatClient),
    });
  } catch (err) {
    console.error('❌ [Clients API] Error fetching clients:', err.message);
    return res.json({
      success: true,
      source: 'fallback',
      count: memoryClients.length,
      data: memoryClients.map(formatClient),
      warning: err.message,
    });
  }
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. GET /api/clients/:id
 * Fetch single client by ID
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
      try {
        const dbClient = await prisma.client.findUnique({
          where: { id },
        });
        if (dbClient) {
          return res.json({ success: true, data: formatClient(dbClient) });
        }
      } catch (dbErr) {
        console.warn(`⚠️ [Clients API] Could not fetch client ${id} from DB:`, dbErr.message);
      }
    }

    const memClient = memoryClients.find((c) => c.id === id);
    if (memClient) {
      return res.json({ success: true, data: formatClient(memClient) });
    }

    return res.status(404).json({ success: false, error: 'Client not found' });
  } catch (err) {
    console.error(`❌ [Clients API] Error fetching client ${id}:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 3. POST /api/clients
 * Create new client & broadcast via Socket.io
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.post('/', async (req, res) => {
  try {
    metadataStore = loadMetadata();
    const body = req.body || {};
    const clientId = body.id || `CL-${Math.floor(1000 + Math.random() * 9000)}`;
    const now = new Date();

    const firstName = body.firstName || (body.name ? body.name.split(' ')[0] : '');
    const lastName = body.lastName || (body.name && body.name.split(' ').length > 1 ? body.name.split(' ').slice(1).join(' ') : '');
    const email = body.email || null;
    const phone = body.phone || null;
    const nationality = body.country || body.nationality || '';
    const tier = body.tier || 'Standard';
    const totalSpent = typeof body.totalSpent === 'number'
      ? body.totalSpent
      : parseFloat(String(body.totalSpent || '0').replace(/[^0-9.]/g, '')) || 0;
    const status = body.status || 'Active';

    // Store all custom entered fields in persistent metadata store
    metadataStore[clientId] = {
      id: clientId,
      firstName,
      lastName,
      email,
      phone,
      city: body.city || '',
      country: body.country || nationality || '',
      nationality: body.nationality || nationality || '',
      timezone: body.timezone || '',
      preferredLanguage: body.preferredLanguage || '',
      passportNumber: body.passportNumber || '',
      passportExpiry: body.passportExpiry || '',
      preferredCabinClass: body.preferredCabinClass || '',
      seatPreference: body.seatPreference || '',
      mealPreference: body.mealPreference || '',
      tier,
      totalSpent,
      status,
      createdAt: body.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
    };
    saveMetadata(metadataStore);

    const clientRecord = {
      id: clientId,
      firstName,
      lastName,
      email,
      phone,
      country: body.country || nationality || '',
      city: body.city || '',
      timezone: body.timezone || '',
      nationality,
      passportNumber: body.passportNumber || '',
      passportExpiry: body.passportExpiry || '',
      preferredCabinClass: body.preferredCabinClass || '',
      seatPreference: body.seatPreference || '',
      mealPreference: body.mealPreference || '',
      preferredLanguage: body.preferredLanguage || '',
      tier,
      totalSpent,
      status,
      createdAt: body.createdAt ? new Date(body.createdAt) : now,
      updatedAt: now,
    };

    let createdRecord = null;

    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
      try {
        createdRecord = await prisma.client.upsert({
          where: { id: clientId },
          update: clientRecord,
          create: clientRecord,
        });
        console.log(`✅ [PostgreSQL] Saved client: ${createdRecord.id} (${firstName} ${lastName})`);
      } catch (dbErr) {
        console.warn('⚠️ [PostgreSQL] prisma.client.upsert failed, falling back to memory:', dbErr.message);
      }
    }

    const finalClient = createdRecord || clientRecord;
    memoryClients.unshift(finalClient);

    const formatted = formatClient(finalClient);

    const io = req.app.get('io');
    if (io) {
      io.to('agents_group').emit('client:new', formatted);
      console.log(`📡 [Socket.io] Broadcasted client:new (${formatted.id})`);
    }

    return res.status(201).json({
      success: true,
      message: 'Client created successfully',
      data: formatted,
    });
  } catch (err) {
    console.error('❌ [Clients API] Error creating client:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to create client',
      message: err.message,
    });
  }
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 4. PUT /api/clients/:id
 * Update an existing client
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body || {};

  try {
    const existingMeta = metadataStore[id] || {};
    metadataStore[id] = { ...existingMeta, ...updates };
    saveMetadata(metadataStore);

    const updateData = {};
    if (updates.firstName !== undefined) updateData.firstName = updates.firstName;
    if (updates.lastName !== undefined) updateData.lastName = updates.lastName;
    if (updates.email !== undefined) updateData.email = updates.email;
    if (updates.phone !== undefined) updateData.phone = updates.phone;
    if (updates.nationality !== undefined || updates.country !== undefined) {
      updateData.nationality = updates.nationality || updates.country;
    }
    if (updates.tier !== undefined) updateData.tier = updates.tier;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.totalSpent !== undefined) {
      updateData.totalSpent = typeof updates.totalSpent === 'number'
        ? updates.totalSpent
        : parseFloat(String(updates.totalSpent).replace(/[^0-9.]/g, '')) || 0;
    }
    updateData.updatedAt = new Date();

    let updatedRecord = null;

    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
      try {
        updatedRecord = await prisma.client.update({
          where: { id },
          data: updateData,
        });
        console.log(`✅ [PostgreSQL] Updated client: ${id}`);
      } catch (dbErr) {
        console.warn(`⚠️ [PostgreSQL] prisma.client.update failed for ${id}:`, dbErr.message);
      }
    }

    const memIndex = memoryClients.findIndex((c) => c.id === id);
    if (memIndex !== -1) {
      memoryClients[memIndex] = { ...memoryClients[memIndex], ...updateData };
      if (!updatedRecord) updatedRecord = memoryClients[memIndex];
    } else if (!updatedRecord) {
      updatedRecord = { id, ...updateData };
      memoryClients.unshift(updatedRecord);
    }

    const formatted = formatClient(updatedRecord);

    const io = req.app.get('io');
    if (io) {
      io.to('agents_group').emit('client:updated', formatted);
    }

    return res.json({
      success: true,
      message: 'Client updated successfully',
      data: formatted,
    });
  } catch (err) {
    console.error(`❌ [Clients API] Error updating client ${id}:`, err);
    return res.status(500).json({
      success: false,
      error: 'Failed to update client',
      message: err.message,
    });
  }
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 5. DELETE /api/clients/:id
 * Delete a client
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
      try {
        await prisma.client.delete({ where: { id } });
        console.log(`✅ [PostgreSQL] Deleted client: ${id}`);
      } catch (dbErr) {
        console.warn(`⚠️ [PostgreSQL] prisma.client.delete failed for ${id}:`, dbErr.message);
      }
    }

    delete metadataStore[id];
    saveMetadata(metadataStore);
    memoryClients = memoryClients.filter((c) => c.id !== id);

    const io = req.app.get('io');
    if (io) {
      io.to('agents_group').emit('client:deleted', { id });
    }

    return res.json({
      success: true,
      message: `Client ${id} deleted successfully`,
    });
  } catch (err) {
    console.error(`❌ [Clients API] Error deleting client ${id}:`, err);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete client',
      message: err.message,
    });
  }
});

module.exports = router;
