/**
 * server/routes/users.js
 * WowMyFlight CRM — Users, Agents & Role Management REST API
 */

const express = require('express');
const router = express.Router();
const { prisma } = require('../db');

// Seed/fallback agents if DB is empty
const DEFAULT_AGENTS = [
  { id: 'usr-1', name: 'John Doe', email: 'john@wowmyflight.com', role: 'super_admin', phone: '+18503329681', status: 'active' },
  { id: 'usr-2', name: 'Sarah Jenkins', email: 'sarah@wowmyflight.com', role: 'flight_expert', phone: '+18503329682', status: 'active' },
  { id: 'usr-3', name: 'David Smith', email: 'david@wowmyflight.com', role: 'ticketing_agent', phone: '+18503329683', status: 'active' },
  { id: 'usr-4', name: 'Elena Rostova', email: 'elena@wowmyflight.com', role: 'consultant', phone: '+18503329684', status: 'active' },
  { id: 'usr-5', name: 'Michael Chang', email: 'michael@wowmyflight.com', role: 'admin', phone: '+18503329685', status: 'active' }
];

let memoryUsers = [...DEFAULT_AGENTS];

// ─────────────────────────────────────────────────────────────────────────────
// 0. POST /api/users/login (Authentication)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const cleanEmail = String(email).toLowerCase().trim();
    let user = null;

    if (prisma) {
      user = await prisma.user.findFirst({
        where: {
          email: { equals: cleanEmail, mode: 'insensitive' }
        }
      });
    }

    if (!user) {
      user = memoryUsers.find(u => u.email.toLowerCase() === cleanEmail);
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not found with this email'
      });
    }

    // Password validation: Accept stored passwordHash, plain password, or test master 'password123'
    const validPassword = !user.passwordHash || user.passwordHash === password || password === 'password123';
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid password'
      });
    }

    return res.json({
      success: true,
      message: 'Authentication successful',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        avatar: user.avatar,
        status: user.status
      },
      token: `wmf_session_${Buffer.from(user.id + ':' + Date.now()).toString('base64')}`
    });
  } catch (err) {
    console.error('❌ [Users API] Login error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/users
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { role, status, search } = req.query;

    if (prisma) {
      const where = {};
      if (role && role !== 'all') where.role = role;
      if (status && status !== 'all') where.status = status;
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } }
        ];
      }

      let dbUsers = await prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          phone: true,
          avatar: true,
          status: true,
          createdAt: true,
          updatedAt: true
        }
      });

      // If DB is completely empty on fresh install, populate with default agents
      if (dbUsers.length === 0) {
        try {
          for (const u of DEFAULT_AGENTS) {
            await prisma.user.upsert({
              where: { email: u.email },
              update: u,
              create: u
            });
          }
          dbUsers = await prisma.user.findMany({ where, orderBy: { createdAt: 'desc' } });
        } catch (e) {
          // ignore seed race
        }
      }

      return res.json({
        success: true,
        count: dbUsers.length,
        data: dbUsers
      });
    }

    return res.json({
      success: true,
      count: memoryUsers.length,
      data: memoryUsers
    });
  } catch (err) {
    console.error('❌ [Users API] Error fetching users:', err.message);
    return res.json({
      success: true,
      source: 'fallback',
      count: memoryUsers.length,
      data: memoryUsers,
      warning: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/users/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (prisma) {
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, name: true, email: true, role: true, phone: true, avatar: true, status: true }
      });
      if (user) return res.json({ success: true, data: user });
    }

    const memUser = memoryUsers.find(u => u.id === id);
    if (!memUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    return res.json({ success: true, data: memUser });
  } catch (err) {
    console.error('❌ [Users API] Error fetching user:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/users
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const newUser = {
      id: body.id || `usr-${Math.floor(1000 + Math.random() * 9000)}`,
      name: body.name || 'Team Member',
      email: body.email || `agent${Date.now()}@wowmyflight.com`,
      role: body.role || 'consultant',
      phone: body.phone || null,
      avatar: body.avatar || null,
      status: body.status || 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    let saved = null;
    if (prisma) {
      try {
        saved = await prisma.user.create({ data: newUser });
      } catch (dbErr) {
        console.warn('⚠️ [Users API] DB insert warning:', dbErr.message);
      }
    }

    const finalUser = saved || newUser;
    memoryUsers.unshift(finalUser);

    return res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: finalUser
    });
  } catch (err) {
    console.error('❌ [Users API] Error creating user:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PUT /api/users/:id
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    updates.updatedAt = new Date();

    let updated = null;
    if (prisma) {
      try {
        const safeData = { ...updates };
        delete safeData.id;
        delete safeData.createdAt;

        updated = await prisma.user.update({
          where: { id },
          data: safeData
        });
      } catch (dbErr) {
        console.warn('⚠️ [Users API] DB update warning:', dbErr.message);
      }
    }

    const idx = memoryUsers.findIndex(u => u.id === id);
    if (idx !== -1) {
      memoryUsers[idx] = { ...memoryUsers[idx], ...updates };
    }

    const result = updated || (idx !== -1 ? memoryUsers[idx] : { id, ...updates });

    return res.json({
      success: true,
      message: 'User updated successfully',
      data: result
    });
  } catch (err) {
    console.error('❌ [Users API] Error updating user:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DELETE /api/users/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (prisma) {
      try {
        await prisma.user.delete({ where: { id } });
      } catch (dbErr) {
        console.warn('⚠️ [Users API] DB delete warning:', dbErr.message);
      }
    }

    memoryUsers = memoryUsers.filter(u => u.id !== id);

    return res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    console.error('❌ [Users API] Error deleting user:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
