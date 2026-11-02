/**
 * server/routes/consultations.js
 * WowMyFlight CRM — Consultations & Calendar Scheduling REST API
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { prisma } = require('../db');

const STORE_FILE = path.join(__dirname, '../store/consultations.json');

function loadConsultations() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('[Consultations] Failed to read store file:', e.message);
  }
  return [];
}

function saveConsultations(data) {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Consultations] Failed to write store file:', e.message);
  }
}

let memoryConsultations = loadConsultations();

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/consultations
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, agentId, search } = req.query;

    if (prisma && prisma.consultation) {
      const where = {};
      if (status && status !== 'all') where.status = status;
      if (agentId) where.agentId = agentId;
      if (search) {
        where.OR = [
          { clientName: { contains: search, mode: 'insensitive' } },
          { clientEmail: { contains: search, mode: 'insensitive' } },
          { agentName: { contains: search, mode: 'insensitive' } },
        ];
      }

      const dbCons = await prisma.consultation.findMany({
        where,
        orderBy: { createdAt: 'desc' }
      });

      return res.json({
        success: true,
        count: dbCons.length,
        data: dbCons
      });
    }

    let filtered = [...memoryConsultations];
    if (status && status !== 'all') {
      filtered = filtered.filter(c => c.status === status);
    }
    if (agentId) {
      filtered = filtered.filter(c => c.agentId === agentId || c.assignedConsultantId === agentId);
    }
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(c => 
        (c.clientName && c.clientName.toLowerCase().includes(s)) ||
        (c.clientEmail && c.clientEmail.toLowerCase().includes(s)) ||
        (c.agentName && c.agentName.toLowerCase().includes(s))
      );
    }

    return res.json({
      success: true,
      count: filtered.length,
      data: filtered
    });
  } catch (err) {
    console.error('❌ [Consultations API] Error fetching consultations:', err.message);
    return res.json({
      success: true,
      source: 'fallback',
      count: memoryConsultations.length,
      data: memoryConsultations,
      warning: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/consultations/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (prisma && prisma.consultation) {
      const cons = await prisma.consultation.findUnique({ where: { id } });
      if (cons) return res.json({ success: true, data: cons });
    }

    const mem = memoryConsultations.find(c => c.id === id);
    if (!mem) return res.status(404).json({ success: false, error: 'Consultation not found' });
    return res.json({ success: true, data: mem });
  } catch (err) {
    console.error('❌ [Consultations API] Error fetching consultation:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/consultations
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const newCons = {
      id: body.id || `cons-${Date.now()}`,
      leadId: body.leadId || null,
      clientName: body.clientName || 'Traveler',
      clientEmail: body.clientEmail || null,
      clientPhone: body.clientPhone || null,
      agentId: body.agentId || body.assignedConsultantId || null,
      agentName: body.agentName || 'Flight Consultant',
      assignedConsultantId: body.assignedConsultantId || body.agentId || null,
      serviceType: body.serviceType || 'Flight Consultation & Follow-up',
      meetingDate: body.meetingDate || (body.dateTime ? body.dateTime.split('T')[0] : new Date().toISOString().split('T')[0]),
      meetingTime: body.meetingTime || (body.dateTime && body.dateTime.includes('T') ? body.dateTime.split('T')[1].substring(0, 5) : '10:00'),
      dateTime: body.dateTime || `${body.meetingDate || new Date().toISOString().split('T')[0]}T${body.meetingTime || '10:00'}:00`,
      durationMinutes: body.durationMinutes || 30,
      status: body.status || 'Scheduled',
      meetingLink: body.meetingLink || `https://meet.jit.si/WowMyFlight-Consultation-${Math.random().toString(36).substring(2, 7)}`,
      notes: body.notes || null,
      outcome: body.outcome || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    let saved = null;
    if (prisma && prisma.consultation) {
      try {
        const prismaData = {
          clientName: newCons.clientName,
          clientEmail: newCons.clientEmail,
          clientPhone: newCons.clientPhone,
          agentId: newCons.agentId,
          agentName: newCons.agentName,
          serviceType: newCons.serviceType,
          dateTime: newCons.dateTime ? String(newCons.dateTime) : new Date().toISOString(),
          status: newCons.status,
          meetingLink: newCons.meetingLink,
          notes: newCons.notes,
          outcome: newCons.outcome
        };
        saved = await prisma.consultation.create({ data: prismaData });
      } catch (dbErr) {
        console.warn('⚠️ [Consultations API] DB insert warning:', dbErr.message);
      }
    }

    const finalRecord = saved || newCons;
    memoryConsultations.unshift(finalRecord);
    saveConsultations(memoryConsultations);

    const io = req.app.get('io');
    if (io) {
      io.to('agents_group').emit('consultation:new', finalRecord);
    }

    return res.status(201).json({
      success: true,
      message: 'Consultation scheduled successfully',
      data: finalRecord
    });
  } catch (err) {
    console.error('❌ [Consultations API] Error scheduling consultation:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PUT /api/consultations/:id
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    updates.updatedAt = new Date().toISOString();

    let updated = null;
    if (prisma && prisma.consultation) {
      try {
        const safeData = { ...updates };
        delete safeData.id;
        delete safeData.createdAt;

        updated = await prisma.consultation.update({
          where: { id },
          data: safeData
        });
      } catch (dbErr) {
        console.warn('⚠️ [Consultations API] DB update warning:', dbErr.message);
      }
    }

    const idx = memoryConsultations.findIndex(c => c.id === id);
    if (idx !== -1) {
      memoryConsultations[idx] = { ...memoryConsultations[idx], ...updates };
      saveConsultations(memoryConsultations);
    }

    const result = updated || (idx !== -1 ? memoryConsultations[idx] : { id, ...updates });

    return res.json({
      success: true,
      message: 'Consultation updated successfully',
      data: result
    });
  } catch (err) {
    console.error('❌ [Consultations API] Error updating consultation:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DELETE /api/consultations/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (prisma) {
      try {
        await prisma.consultation.delete({ where: { id } });
      } catch (dbErr) {
        console.warn('⚠️ [Consultations API] DB delete warning:', dbErr.message);
      }
    }

    memoryConsultations = memoryConsultations.filter(c => c.id !== id);

    return res.json({ success: true, message: 'Consultation cancelled/deleted' });
  } catch (err) {
    console.error('❌ [Consultations API] Error deleting consultation:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
