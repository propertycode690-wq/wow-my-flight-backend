/**
 * server/routes/documents.js
 * WowMyFlight CRM — Traveler Documents & KYC/Verification REST API
 */

const express = require('express');
const router = express.Router();
const { prisma } = require('../db');
const { recordAccess, scopedIo } = require('../middleware/recordAccess');
router.use(recordAccess("document", "agentId", [], []));


let memoryDocuments = [];

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/documents
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, category, clientId, search } = req.query;

    if (prisma) {
      const where = {};
      if (req.query.agentId) where.agentId = req.query.agentId;
      if (status && status !== 'all') where.status = status;
      if (category && category !== 'all') where.category = category;
      if (clientId) where.clientId = clientId;
      if (search) {
        where.OR = [
          { customerName: { contains: search, mode: 'insensitive' } },
          { fileName: { contains: search, mode: 'insensitive' } },
        ];
      }

      const dbDocs = await prisma.document.findMany({
        where,
        orderBy: { createdAt: 'desc' }
      });

      return res.json({
        success: true,
        count: dbDocs.length,
        data: dbDocs
      });
    }

    return res.json({
      success: true,
      count: memoryDocuments.length,
      data: memoryDocuments
    });
  } catch (err) { return res.status(503).json({ success: false, error: 'Database query failed. Please retry.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/documents/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (prisma) {
      const doc = await prisma.document.findUnique({ where: { id } });
      if (doc) return res.json({ success: true, data: doc });
    }

    const mem = memoryDocuments.find(d => d.id === id);
    if (!mem) return res.status(404).json({ success: false, error: 'Document not found' });
    return res.json({ success: true, data: mem });
  } catch (err) {
    console.error('❌ [Documents API] Error fetching document:', err.message);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/documents
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (!(body.customerName || body.clientName)?.trim() || !(body.fileName || body.name)?.trim() || !body.fileUrl) return res.status(400).json({ success: false, error: 'Customer, filename and uploaded document are required' });
    const newDoc = {
      agentId: body.agentId,
      customerEmail: body.customerEmail || null,
      bookingRef: body.bookingRef || null,
      pnr: body.pnr || null,
      expiryDate: body.expiryDate || null,
      clientId: body.clientId || null,
      customerName: body.customerName || body.clientName || 'Traveler',
      fileName: body.fileName || body.name || 'Document.pdf',
      fileType: body.fileType || 'application/pdf',
      fileSize: body.fileSize || null,
      fileUrl: body.fileUrl,
      category: body.category || 'Passport',
      status: body.status || 'Pending',
      comment: body.comment || null,
      uploadedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    let saved = null;
    if (prisma) {
      try {
        saved = await prisma.document.create({ data: newDoc });
      } catch (dbErr) { throw dbErr; }
    }

    const finalRecord = saved || { id: `doc-${Date.now()}`, ...newDoc };
    memoryDocuments.unshift(finalRecord);

    const io = scopedIo(req);
    if (io) {
      io.to('agents_group').emit('document:new', finalRecord);
    }

    return res.status(201).json({
      success: true,
      message: 'Document recorded successfully',
      data: finalRecord
    });
  } catch (err) {
    console.error('❌ [Documents API] Error recording document:', err.message);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PATCH /api/documents/:id/status
// Verify or Reject Document
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, comment, reviewedBy } = req.body;

    const updates = {
      status,
      comment: comment || null,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      updatedAt: new Date()
    };

    let updated = null;
    if (prisma) {
      try {
        updated = await prisma.document.update({
          where: { id },
          data: updates
        });
      } catch (dbErr) { throw dbErr; }
    }

    const idx = memoryDocuments.findIndex(d => d.id === id);
    if (idx !== -1) {
      memoryDocuments[idx] = { ...memoryDocuments[idx], ...updates };
    }

    const result = updated || (idx !== -1 ? memoryDocuments[idx] : { id, ...updates });

    const io = scopedIo(req);
    if (io) {
      io.to('agents_group').emit('document:reviewed', result);
    }

    return res.json({
      success: true,
      message: `Document status changed to ${status}`,
      data: result
    });
  } catch (err) {
    console.error('❌ [Documents API] Error reviewing document:', err.message);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DELETE /api/documents/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (prisma) {
      try {
        await prisma.document.delete({ where: { id } });
      } catch (dbErr) { throw dbErr; }
    }

    memoryDocuments = memoryDocuments.filter(d => d.id !== id);

    return res.json({ success: true, message: 'Document deleted successfully' });
  } catch (err) {
    console.error('❌ [Documents API] Error deleting document:', err.message);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

module.exports = router;
