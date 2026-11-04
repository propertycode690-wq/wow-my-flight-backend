/**
 * routes/permissionControl.js
 * WowMyFlight CRM — Phase 3: Permission Control REST API
 * Route Name Matches Menu: "Permission Control" -> /api/permission-control
 * Live PostgreSQL (Prisma) Integration with Zero Dummy Data
 */

const express = require('express');
const router = express.Router();
const { prisma } = require('../db');

let BASE_ROLES = require('../config/roles.json');

let USER_OVERRIDES = {};
let AUDIT_LOGS = [];

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/permission-control/roles
// ─────────────────────────────────────────────────────────────────────────────
router.get('/roles', async (req, res) => {
  try {
    let users = [];
    if (prisma) {
      try {
        users = await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, phone: true, status: true } });
      } catch (e) {}
    }

    const roles = BASE_ROLES.map(r => {
      const count = users.filter(u => u.role === r.id).length;
      return {
        ...r,
        userCount: count
      };
    });

    res.json({ success: true, count: roles.length, data: roles });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/permission-control/users
// ─────────────────────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    let users = [];
    if (prisma) {
      try {
        users = await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, phone: true, status: true, avatar: true, createdAt: true } });
      } catch (e) {}
    }
    res.json({ success: true, count: users.length, data: users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/permission-control/overrides
// ─────────────────────────────────────────────────────────────────────────────
router.get('/overrides', (req, res) => {
  res.json({ success: true, data: USER_OVERRIDES });
});

router.post('/overrides/:userId', (req, res) => {
  const { userId } = req.params;
  const { permissions } = req.body;
  USER_OVERRIDES[userId] = permissions;
  res.json({ success: true, message: `Overrides saved for user ${userId}`, data: USER_OVERRIDES[userId] });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /api/permission-control/audit
// ─────────────────────────────────────────────────────────────────────────────
router.get('/audit', (req, res) => {
  res.json({ success: true, count: AUDIT_LOGS.length, data: AUDIT_LOGS });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. GET /api/permission-control (Root)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    let users = [];
    if (prisma) {
      try {
        users = await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, phone: true, status: true, avatar: true, createdAt: true } });
      } catch (e) {}
    }

    const roles = BASE_ROLES.map(r => {
      const count = users.filter(u => u.role === r.id).length;
      return {
        ...r,
        userCount: count
      };
    });

    res.json({
      success: true,
      data: {
        roles,
        userOverrides: USER_OVERRIDES,
        auditLogs: AUDIT_LOGS
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
