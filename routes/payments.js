/**
 * server/routes/payments.js
 * WowMyFlight CRM — Invoices & Payment Gateway Tracking REST API
 */

const express = require('express');
const router = express.Router();
const { prisma } = require('../db');

let memoryPayments = [];

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/payments
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, method, search } = req.query;

    if (prisma) {
      const where = {};
      if (status && status !== 'all') where.status = status;
      if (method && method !== 'all') where.method = method;
      if (search) {
        where.OR = [
          { invoiceNumber: { contains: search, mode: 'insensitive' } },
          { customerName: { contains: search, mode: 'insensitive' } },
          { customerEmail: { contains: search, mode: 'insensitive' } },
        ];
      }

      const dbPayments = await prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' }
      });

      return res.json({
        success: true,
        count: dbPayments.length,
        data: dbPayments
      });
    }

    return res.json({
      success: true,
      count: memoryPayments.length,
      data: memoryPayments
    });
  } catch (err) {
    console.error('❌ [Payments API] Error fetching payments:', err.message);
    return res.json({
      success: true,
      source: 'fallback',
      count: memoryPayments.length,
      data: memoryPayments,
      warning: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/payments/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (prisma) {
      const payment = await prisma.payment.findFirst({
        where: { OR: [{ id }, { invoiceNumber: id }] }
      });
      if (payment) return res.json({ success: true, data: payment });
    }

    const memPayment = memoryPayments.find(p => p.id === id || p.invoiceNumber === id);
    if (!memPayment) {
      return res.status(404).json({ success: false, error: 'Payment record not found' });
    }

    return res.json({ success: true, data: memPayment });
  } catch (err) {
    console.error('❌ [Payments API] Error fetching payment:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/payments
// Create invoice / payment link
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const invoiceNumber = body.invoiceNumber || `INV-${Math.floor(10000 + Math.random() * 90000)}`;

    const newPayment = {
      invoiceNumber,
      clientId: body.clientId || null,
      customerName: body.customerName || body.clientName || 'Traveler',
      customerEmail: body.customerEmail || body.email || null,
      customerPhone: body.customerPhone || body.phone || null,
      amount: parseFloat(body.amount) || 0.0,
      currency: body.currency || 'USD',
      status: body.status || 'Pending',
      method: body.method || 'Stripe',
      serviceName: body.serviceName || 'Flight Booking',
      dueDate: body.dueDate || null,
      paidAt: body.status === 'Paid' ? new Date() : null,
      paymentLink: body.paymentLink || `https://pay.wowmyflight.com/${invoiceNumber}`,
      transactionId: body.transactionId || null,
      notes: body.notes || null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    let saved = null;
    if (prisma) {
      try {
        saved = await prisma.payment.create({ data: newPayment });
      } catch (dbErr) {
        console.warn('⚠️ [Payments API] DB insert warning:', dbErr.message);
      }
    }

    const finalPayment = saved || { id: invoiceNumber, ...newPayment };
    memoryPayments.unshift(finalPayment);

    const io = req.app.get('io');
    if (io) {
      io.to('agents_group').emit('payment:new', finalPayment);
    }

    return res.status(201).json({
      success: true,
      message: 'Invoice created successfully',
      data: finalPayment
    });
  } catch (err) {
    console.error('❌ [Payments API] Error creating payment:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PATCH /api/payments/:id/status
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, transactionId, method } = req.body;

    const updates = {
      status,
      updatedAt: new Date(),
      ...(status === 'Paid' ? { paidAt: new Date() } : {}),
      ...(transactionId ? { transactionId } : {}),
      ...(method ? { method } : {})
    };

    let updated = null;
    if (prisma) {
      try {
        const existing = await prisma.payment.findFirst({
          where: { OR: [{ id }, { invoiceNumber: id }] }
        });
        if (existing) {
          updated = await prisma.payment.update({
            where: { id: existing.id },
            data: updates
          });
        }
      } catch (dbErr) {
        console.warn('⚠️ [Payments API] DB update warning:', dbErr.message);
      }
    }

    const idx = memoryPayments.findIndex(p => p.id === id || p.invoiceNumber === id);
    if (idx !== -1) {
      memoryPayments[idx] = { ...memoryPayments[idx], ...updates };
    }

    const result = updated || (idx !== -1 ? memoryPayments[idx] : { id, ...updates });

    const io = req.app.get('io');
    if (io) {
      io.to('agents_group').emit('payment:updated', result);
    }

    return res.json({
      success: true,
      message: 'Payment status updated',
      data: result
    });
  } catch (err) {
    console.error('❌ [Payments API] Error updating status:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DELETE /api/payments/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (prisma) {
      try {
        const existing = await prisma.payment.findFirst({
          where: { OR: [{ id }, { invoiceNumber: id }] }
        });
        if (existing) {
          await prisma.payment.delete({ where: { id: existing.id } });
        }
      } catch (dbErr) {
        console.warn('⚠️ [Payments API] DB delete warning:', dbErr.message);
      }
    }

    memoryPayments = memoryPayments.filter(p => p.id !== id && p.invoiceNumber !== id);

    return res.json({ success: true, message: 'Payment record deleted' });
  } catch (err) {
    console.error('❌ [Payments API] Error deleting payment:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
