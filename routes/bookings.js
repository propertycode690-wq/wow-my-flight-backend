/**
 * server/routes/bookings.js
 * WowMyFlight CRM — Live PostgreSQL Database Bookings & Ticketing API
 */

const express = require('express');
const router = express.Router();
const { prisma, isDbConnected } = require('../db');
const { recordAccess, scopedIo } = require('../middleware/recordAccess');
router.use(recordAccess("booking", "agentId", ["bookingId", "pnr"], []));


// In-memory fallback cache (strictly real bookings only, no dummy data)
let memoryBookings = [];

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/bookings
// Fetch all real bookings from PostgreSQL Database
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    if (prisma) {
      const dbBookings = await prisma.booking.findMany({
        where: req.query.agentId ? { agentId: req.query.agentId } : {},
        orderBy: { createdAt: 'desc' }
      });
      return res.json({
        success: true,
        source: 'PostgreSQL Database',
        count: dbBookings.length,
        data: dbBookings
      });
    }

    return res.json({
      success: true,
      source: 'Memory Cache',
      count: memoryBookings.length,
      data: memoryBookings
    });
  } catch (err) { return res.status(503).json({ success: false, error: 'Database query failed. Please retry.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bookings
// Create a new booking in PostgreSQL Database
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const bookingId = body.bookingId || `BK-${Math.floor(1000 + Math.random() * 9000)}`;
    const pnr = body.pnr || body.pnrCode;
    if (!pnr || !(body.passenger || body.customerName)) return res.status(400).json({ success: false, error: 'A supplier PNR and passenger name are required' });
    
    const toCurrencyStr = (val, fallback) => {
      if (val === undefined || val === null || val === '') return fallback;
      if (typeof val === 'number') return `$${val.toFixed(2)}`;
      return String(val);
    };

    const newRecord = {
      agentId: body.agentId,
      bookingId,
      pnr,
      supplier: body.supplier || 'Travelopro GDS',
      ticketNumber: body.ticketNumber || 'Unissued',
      passenger: body.passenger || body.customerName || 'Lead Passenger',
      name: body.name || body.passenger || body.customerName || 'Lead Passenger',
      route: body.route || `${body.origin || ''} → ${body.destination || ''}`,
      origin: body.origin || '',
      destination: body.destination || '',
      fare: toCurrencyStr(body.fare ?? body.netFare, '$0.00'),
      taxes: toCurrencyStr(body.taxes, '$0.00'),
      commission: toCurrencyStr(body.commission, '$0.00'),
      amount: toCurrencyStr(body.amount ?? body.totalAmount ?? body.sellingPrice, '$0.00'),
      paymentStatus: body.paymentStatus || 'Payment Pending',
      ticketStatus: body.ticketStatus || 'Pending Ticketing',
      timeLimit: body.timeLimit || '24h remaining',
      ttl: body.ttl || body.timeLimit || '24h remaining',
      isTtlUrgent: Boolean(body.isTtlUrgent),
      issuingAgent: body.issuingAgent || 'Unassigned',
      issueDateTime: body.issueDateTime || '—',
      date: body.date || new Date().toLocaleDateString(),
      cabinClass: body.cabinClass || 'Economy',
      passengers: Number(body.passengers) || 1,
      airlineCode: body.airlineCode || body.airline || '',
      flightNumber: body.flightNumber || '',
      notes: typeof body.notes === 'string' ? body.notes : (body.notes ? JSON.stringify(body.notes) : '')
    };

    let createdBooking = null;
    if (prisma) {
      createdBooking = await prisma.booking.create({ data: newRecord });
      console.log(`✅ [PostgreSQL] Created new booking: ${createdBooking.bookingId} (${createdBooking.pnr})`);
    } else {
      newRecord.id = `mem-${Date.now()}`;
      newRecord.createdAt = new Date();
      memoryBookings.unshift(newRecord);
      createdBooking = newRecord;
    }

    // Broadcast live event to socket.io listeners
    const io = scopedIo(req);
    if (io) {
      io.emit('booking:created', createdBooking);
    }

    return res.status(201).json({
      success: true,
      message: 'Booking created successfully in Database',
      data: createdBooking
    });
  } catch (err) {
    console.error('❌ [Bookings API] Error creating booking:', err);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ error: 'Failed to create booking', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/bookings/:id/status
// Update status / ticket number in PostgreSQL Database
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { ticketStatus, paymentStatus, ticketNumber, issueDateTime, issuingAgent } = req.body;

    let updated = null;
    if (prisma) {
      // Find by id or bookingId or pnr
      const existing = await prisma.booking.findFirst({
        where: {
          OR: [{ id: id }, { bookingId: id }, { pnr: id }]
        }
      });

      if (existing) {
        updated = await prisma.booking.update({
          where: { id: existing.id },
          data: {
            ...(ticketStatus && { ticketStatus }),
            ...(paymentStatus && { paymentStatus }),
            ...(ticketNumber && { ticketNumber }),
            ...(issueDateTime && { issueDateTime }),
            ...(issuingAgent && { issuingAgent }),
          }
        });
        console.log(`✅ [PostgreSQL] Updated booking ${updated.bookingId} -> status: ${ticketStatus || existing.ticketStatus}`);
      }
    }

    if (!updated) {
      // Check memory
      const idx = memoryBookings.findIndex(b => b.id === id || b.bookingId === id || b.pnr === id);
      if (idx !== -1) {
        memoryBookings[idx] = {
          ...memoryBookings[idx],
          ...(ticketStatus && { ticketStatus }),
          ...(paymentStatus && { paymentStatus }),
          ...(ticketNumber && { ticketNumber }),
          ...(issueDateTime && { issueDateTime }),
          ...(issuingAgent && { issuingAgent }),
        };
        updated = memoryBookings[idx];
      }
    }

    if (!updated) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const io = scopedIo(req);
    if (io) {
      io.emit('booking:updated', updated);
    }

    return res.json({
      success: true,
      message: 'Booking status updated in Database',
      data: updated
    });
  } catch (err) {
    console.error('❌ [Bookings API] Error updating booking status:', err);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ error: 'Failed to update booking status', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bookings/:id/issue
// Full Issuance Workflow: Updates DB status to "Ticketed", records e-ticket
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/issue', async (req, res) => {
  try {
    const { id } = req.params;
    const { eTickets, issuingAgent = req.user.name } = req.body;
    if (!['admin', 'super_admin'].includes(req.user.role)) return res.status(403).json({success:false,error:'Only administrators can record supplier-issued tickets'});

    const formattedTicket = Array.isArray(eTickets) ? eTickets.join(', ') : eTickets;
    if (!formattedTicket) return res.status(400).json({ success: false, error: 'Confirmed supplier ticket numbers are required' });
    const issueDateTime = new Date().toLocaleString('en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    let updated = null;
    if (prisma) {
      const existing = await prisma.booking.findFirst({
        where: {
          OR: [{ id: id }, { bookingId: id }, { pnr: id }]
        }
      });

      if (existing) {
        updated = await prisma.booking.update({
          where: { id: existing.id },
          data: {
            ticketStatus: 'Ticketed',
            paymentStatus: 'Payment Confirmed',
            ticketNumber: formattedTicket,
            issueDateTime,
            issuingAgent,
            ttl: 'Ticketed'
          }
        });
        console.log(`✅ [PostgreSQL] Ticket issued in DB for ${updated.bookingId} (${updated.pnr}) -> ${formattedTicket}`);
      }
    }

    if (!updated) {
      const idx = memoryBookings.findIndex(b => b.id === id || b.bookingId === id || b.pnr === id);
      if (idx !== -1) {
        memoryBookings[idx] = {
          ...memoryBookings[idx],
          ticketStatus: 'Ticketed',
          paymentStatus: 'Payment Confirmed',
          ticketNumber: formattedTicket,
          issueDateTime,
          issuingAgent,
          ttl: 'Ticketed'
        };
        updated = memoryBookings[idx];
      }
    }

    const io = scopedIo(req);
    if (io) {
      io.emit('booking:ticketed', updated);
    }

    return res.json({
      success: true,
      message: 'Supplier ticket details recorded; no ticket was issued by this endpoint',
      data: updated,
      eTickets: Array.isArray(eTickets) ? eTickets : [formattedTicket],
      issueDateTime
    });
  } catch (err) {
    console.error('❌ [Bookings API] Error issuing ticket:', err);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ error: 'Failed to issue ticket in DB', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/bookings/:id
// Delete a booking from PostgreSQL Database
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let deleted = false;

    if (prisma) {
      const existing = await prisma.booking.findFirst({
        where: {
          OR: [{ id: id }, { bookingId: id }, { pnr: id }]
        }
      });
      if (existing) {
        await prisma.booking.delete({ where: { id: existing.id } });
        deleted = true;
      }
    }

    const idx = memoryBookings.findIndex(b => b.id === id || b.bookingId === id || b.pnr === id);
    if (idx !== -1) {
      memoryBookings.splice(idx, 1);
      deleted = true;
    }

    return res.json({ success: true, deleted, message: `Booking ${id} deleted.` });
  } catch (err) {
    console.error('❌ [Bookings API] Error deleting booking:', err);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ error: 'Failed to delete booking', message: err.message });
  }
});

module.exports = router;
