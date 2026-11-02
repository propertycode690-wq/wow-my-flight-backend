/**
 * server/routes/afterSales.js
 * WowMyFlight CRM — After-Sales Cases, Operational Workflows & Case History REST API
 * Persists Case History Logs, Agent Notes, Status Changes & Owner Reassignments
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { prisma } = require('../db');

const STORE_FILE = path.join(__dirname, '../store/after_sales_cases.json');

// Helper to safely load cases
function loadCases() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.warn('[AfterSales] Failed to read store file:', e.message);
  }
  return [];
}

// Helper to safely save cases
function saveCases(data) {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('[AfterSales] Failed to write store file:', e.message);
  }
}

// Synchronize with PostgreSQL real bookings
async function syncWithBookings(existingCases) {
  let cases = [...existingCases];
  if (!prisma) return cases;

  try {
    const dbBookings = await prisma.booking.findMany({
      orderBy: { createdAt: 'desc' }
    });

    if (Array.isArray(dbBookings) && dbBookings.length > 0) {
      let changed = false;

      dbBookings.forEach((b, idx) => {
        const caseId = `AS-${String(b.bookingId || b.id || (100 + idx)).slice(-4)}`;
        const existingIdx = cases.findIndex(c => c.id === caseId || c.bookingId === b.bookingId || c.pnr === b.pnr);

        if (existingIdx === -1) {
          // Create new case from live booking
          const newCase = {
            id: caseId,
            pnr: b.pnr || 'GDS-LIVE',
            bookingId: b.bookingId || b.id,
            customerName: b.passenger || b.customerName || b.name || 'Passenger',
            category: idx % 3 === 0 ? 'Changes' : (idx % 3 === 1 ? 'Refund' : 'Disruption'),
            subType: idx % 3 === 0 ? 'Date Change' : (idx % 3 === 1 ? 'Full Refund' : 'Schedule Change'),
            route: b.route || `${b.origin || 'DEL'} → ${b.destination || 'LHR'}`,
            airline: b.airlineCode ? `${b.airlineCode} Airways` : (b.supplier || 'GDS Airline'),
            owner: b.issuingAgent && b.issuingAgent !== 'Unassigned' ? b.issuingAgent : 'Maria Santos (Ops)',
            status: b.ticketStatus === 'Ready to Issue' ? 'In Progress' : 'Open',
            priority: b.isTtlUrgent ? 'Critical' : 'High',
            sla: b.timeLimit || '24h remaining',
            isSlaUrgent: b.isTtlUrgent || false,
            createdAt: b.createdAt ? new Date(b.createdAt).toLocaleString() : new Date().toLocaleString(),
            feeAmount: b.fare || '$316.00',
            history: [
              {
                id: `h-init-${b.id || idx}`,
                timestamp: b.createdAt ? new Date(b.createdAt).toLocaleString() : new Date().toLocaleString(),
                author: 'Live CRM & GDS Queue',
                action: 'Booking Synchronized into After-Sales Desk',
                notes: `Real booking ${b.bookingId || b.id} with PNR ${b.pnr || 'PNR'} active in queue.`
              }
            ]
          };
          cases.push(newCase);
          changed = true;
        } else {
          // Keep saved history & user notes, update booking fields if missing
          const existing = cases[existingIdx];
          let updated = false;
          if (!existing.pnr && b.pnr) { existing.pnr = b.pnr; updated = true; }
          if (!existing.customerName && b.passenger) { existing.customerName = b.passenger; updated = true; }
          if (!existing.feeAmount && b.fare) { existing.feeAmount = b.fare; updated = true; }
          if (updated) changed = true;
        }
      });

      if (changed) {
        saveCases(cases);
      }
    }
  } catch (err) {
    console.warn('[AfterSales] syncWithBookings warning:', err.message);
  }

  return cases;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/after-sales
// Fetch all cases with their full persistent history and notes
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    let cases = loadCases();
    cases = await syncWithBookings(cases);

    return res.json({
      success: true,
      source: 'PostgreSQL & Persistent Store',
      count: cases.length,
      data: cases
    });
  } catch (err) {
    console.error('❌ [AfterSales API] Error fetching cases:', err);
    return res.status(500).json({ error: 'Failed to fetch after-sales cases', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/after-sales/:id
// Fetch single case by ID with full history
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let cases = loadCases();
    cases = await syncWithBookings(cases);

    const found = cases.find(c => c.id === id || c.bookingId === id || c.pnr === id);
    if (!found) {
      return res.status(404).json({ error: `After-sales case ${id} not found` });
    }

    return res.json({ success: true, data: found });
  } catch (err) {
    console.error('❌ [AfterSales API] Error fetching case detail:', err);
    return res.status(500).json({ error: 'Failed to fetch case detail', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/after-sales/:id/history
// Add a persistent note or activity log to case history timeline
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/history', async (req, res) => {
  try {
    const { id } = req.params;
    const { author = 'Current Agent', notes = '', action = 'Agent Note Added' } = req.body;

    if (!notes.trim()) {
      return res.status(400).json({ error: 'Note text cannot be empty' });
    }

    let cases = loadCases();
    cases = await syncWithBookings(cases);

    let caseItem = cases.find(c => c.id === id || c.bookingId === id || c.pnr === id);

    if (!caseItem) {
      return res.status(404).json({ error: `Case ${id} not found` });
    }

    if (!Array.isArray(caseItem.history)) {
      caseItem.history = [];
    }

    const newEntry = {
      id: `h-${Date.now()}`,
      timestamp: new Date().toLocaleString(),
      author: String(author).trim() || 'Current Agent',
      action: String(action).trim() || 'Agent Note Added',
      notes: String(notes).trim()
    };

    caseItem.history.push(newEntry);
    saveCases(cases);

    // Also sync note into PostgreSQL booking if available
    if (prisma && (caseItem.bookingId || caseItem.pnr)) {
      try {
        await prisma.booking.updateMany({
          where: {
            OR: [
              ...(caseItem.bookingId ? [{ bookingId: caseItem.bookingId }] : []),
              ...(caseItem.pnr ? [{ pnr: caseItem.pnr }] : [])
            ]
          },
          data: {
            notes: `[After-Sales History ${newEntry.timestamp} by ${newEntry.author}]: ${newEntry.notes}`
          }
        });
      } catch (prismaErr) {
        console.warn('[AfterSales] Prisma booking notes sync warning:', prismaErr.message);
      }
    }

    console.log(`✅ [AfterSales API] Added persistent note to case ${caseItem.id} by ${newEntry.author}: "${newEntry.notes}"`);

    // Broadcast live event to socket listeners if available
    const io = req.app.get('io');
    if (io) {
      io.emit('after-sales:note_added', { caseId: caseItem.id, entry: newEntry, updatedCase: caseItem });
    }

    return res.status(201).json({
      success: true,
      message: 'Note successfully added and persisted to Case History',
      data: caseItem,
      newEntry
    });
  } catch (err) {
    console.error('❌ [AfterSales API] Error adding history note:', err);
    return res.status(500).json({ error: 'Failed to add history note', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PATCH /api/after-sales/:id
// Update Case status, owner, priority or SLA, and record audit log
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, owner, priority, sla, feeAmount, subType, category } = req.body;

    let cases = loadCases();
    cases = await syncWithBookings(cases);

    let caseItem = cases.find(c => c.id === id || c.bookingId === id || c.pnr === id);
    if (!caseItem) {
      return res.status(404).json({ error: `Case ${id} not found` });
    }

    if (!Array.isArray(caseItem.history)) {
      caseItem.history = [];
    }

    // Auto-generate audit history entries
    if (status && status !== caseItem.status) {
      caseItem.history.push({
        id: `h-stat-${Date.now()}`,
        timestamp: new Date().toLocaleString(),
        author: 'Current Agent',
        action: `Status Changed to ${status}`,
        notes: `Case status transitioned from "${caseItem.status}" to "${status}"`
      });
      caseItem.status = status;
    }

    if (owner && owner !== caseItem.owner) {
      caseItem.history.push({
        id: `h-own-${Date.now()}`,
        timestamp: new Date().toLocaleString(),
        author: 'Current Agent',
        action: 'Owner Reassigned',
        notes: `Case owner updated from "${caseItem.owner}" to "${owner}"`
      });
      caseItem.owner = owner;
    }

    if (priority) caseItem.priority = priority;
    if (sla) caseItem.sla = sla;
    if (feeAmount) caseItem.feeAmount = feeAmount;
    if (subType) caseItem.subType = subType;
    if (category) caseItem.category = category;

    saveCases(cases);

    const io = req.app.get('io');
    if (io) {
      io.emit('after-sales:updated', caseItem);
    }

    return res.json({
      success: true,
      message: `Case ${caseItem.id} updated successfully`,
      data: caseItem
    });
  } catch (err) {
    console.error('❌ [AfterSales API] Error updating case:', err);
    return res.status(500).json({ error: 'Failed to update after-sales case', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. POST /api/after-sales
// Create a new After-Sales case
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    let cases = loadCases();

    const generatedId = body.id || `AS-${900 + cases.length + 1}`;
    const newCase = {
      id: generatedId,
      pnr: body.pnr || 'PNR-REQ',
      bookingId: body.bookingId || `BK-${1000 + cases.length + 1}`,
      customerName: body.customerName || 'Passenger',
      category: body.category || 'Changes',
      subType: body.subType || 'Date Change',
      route: body.route || 'DEL → LHR',
      airline: body.airline || 'Partner Airline',
      owner: body.owner || 'Maria Santos (Ops)',
      status: body.status || 'Open',
      priority: body.priority || 'High',
      sla: body.sla || '2h 00m remaining',
      isSlaUrgent: body.priority === 'High' || body.priority === 'Critical',
      createdAt: new Date().toLocaleString(),
      feeAmount: body.feeAmount || '$0.00',
      history: body.history || [
        {
          id: `h-${Date.now()}`,
          timestamp: new Date().toLocaleString(),
          author: 'Ops Agent',
          action: 'Case Created',
          notes: body.notes || `Initial ${body.category || 'Changes'} (${body.subType || 'Date Change'}) case logged.`
        }
      ]
    };

    cases.unshift(newCase);
    saveCases(cases);

    return res.status(201).json({
      success: true,
      message: `After-sales case ${newCase.id} created successfully`,
      data: newCase
    });
  } catch (err) {
    console.error('❌ [AfterSales API] Error creating case:', err);
    return res.status(500).json({ error: 'Failed to create case', message: err.message });
  }
});

module.exports = router;
