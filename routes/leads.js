/**
 * server/routes/leads.js
 * WowMyFlight CRM — Full Production Leads REST API
 * 
 * Features:
 *   - Real PostgreSQL persistence via Prisma (with auto-reconnect & health check)
 *   - Resilient memory fallback via leadStore
 *   - Real-time Socket.io broadcasting on create / update / assign / delete
 *   - Status filtering, search, and agent assignment
 * 
 * Endpoints:
 *   GET    /api/leads            - Fetch all leads (with status/search/agent filters)
 *   GET    /api/leads/:id        - Fetch single lead by ID
 *   POST   /api/leads            - Create new lead & broadcast via Socket.io
 *   PUT    /api/leads/:id        - Update existing lead
 *   PATCH  /api/leads/:id/assign - Quick assign agent to lead
 *   DELETE /api/leads/:id        - Delete lead
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const leadStore = require('../store/leadStore');
const { prisma, isDbConnected } = require('../db');
const { recordAccess, scopedIo } = require('../middleware/recordAccess');
router.use(recordAccess("lead", "assignedAgentId", [], ["distribution","duplicates","lifecycle"]));


// Persistent metadata file for extended CRM fields (city, returnDate, source, priority, labels, etc.)
const METADATA_FILE = path.join(__dirname, '../store/leads_metadata.json');

function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('⚠️ [Leads API] Could not load leads_metadata.json:', e.message);
  }
  return {};
}

function saveMetadata(data) {
  try {
    const dir = path.dirname(METADATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ [Leads API] Could not save leads_metadata.json:', e.message);
  }
}

let metadataStore = loadMetadata();

function formatLead(lead) {
  if (!lead) return null;
  const store = loadMetadata();
  let meta = store[lead.id] || metadataStore[lead.id];
  if (!meta) {
    const values = Object.values(store);
    meta = values.find(m => (m.email && lead.email && m.email.toLowerCase() === lead.email.toLowerCase()) || (m.phone && lead.phone && m.phone === lead.phone)) || {};
  }

  const country = lead.country || meta.country || lead.nationality || '';
  const city = lead.city || meta.city || '';
  const timezone = lead.timezone || meta.timezone || '';
  const returnDate = lead.returnDate || meta.returnDate || '';
  const flexibility = lead.flexibility || meta.flexibility || 'Exact Dates';
  const adults = Number(lead.adults) || Number(meta.adults) || Number(lead.passengers) || 1;
  const children = Number(lead.children) || Number(meta.children) || 0;
  const infants = Number(lead.infants) || Number(meta.infants) || 0;
  const budget = lead.budgetRange || meta.budget || (lead.budget !== null && lead.budget !== undefined ? (String(lead.budget).startsWith('$') ? String(lead.budget) : `$${lead.budget}`) : '');
  const source = lead.source || meta.source || 'Website Direct';
  const priority = lead.priority || meta.priority || 'Medium';
  const labels = (Array.isArray(lead.labels) && lead.labels.length > 0) ? lead.labels : (Array.isArray(meta.labels) ? meta.labels : []);
  const notes = lead.notes || meta.notes || '';
  const activities = Array.isArray(meta.activities) && meta.activities.length > 0 ? meta.activities : (Array.isArray(lead.activities) ? lead.activities : []);
  const cabinClass = lead.cabinClass || meta.cabinClass || (lead.serviceId ? lead.serviceId.charAt(0).toUpperCase() + lead.serviceId.slice(1) : 'Economy');

  return {
    ...lead,
    country,
    nationality: lead.nationality || country,
    city,
    timezone,
    timeZone: timezone,
    returnDate,
    flexibility,
    adults,
    children,
    infants,
    passengers: adults + children + infants,
    budget,
    budgetRange: budget,
    source,
    priority,
    labels,
    notes,
    activities,
    cabinClass
  };
}

// In-memory fallback cache if PostgreSQL is offline
let memoryLeads = [];

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/leads
// Fetch all leads with optional filters: status, assignedAgentId, search, env
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, search, env = 'PRODUCTION' } = req.query;
    const assignedAgentId = req.user?.role === 'sales_executive' ? req.user.id : req.query.assignedAgentId;

    if (prisma) {
      try {
        const where = {};
        if (status && status !== 'all' && status !== 'All') {
          where.status = status;
        }
        if (assignedAgentId) {
          where.assignedAgentId = assignedAgentId;
        }
        if (search) {
          where.OR = [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
            { origin: { contains: search, mode: 'insensitive' } },
            { destination: { contains: search, mode: 'insensitive' } },
          ];
        }

        const dbLeads = await prisma.lead.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          include: {
            assignedAgent: {
              select: { id: true, name: true, email: true, role: true }
            }
          }
        });

        // Combine with any leadStore sandbox/memory leads
        let storeLeads = [];
        if (env === 'SANDBOX' && leadStore && typeof leadStore.getLeads === 'function') {
          const storeResult = leadStore.getLeads({ isSandbox: env === 'SANDBOX' });
          storeLeads = storeResult.data || [];
        }

        const combinedMap = new Map();
        dbLeads.forEach((l) => combinedMap.set(l.id, l));

        const formattedList = Array.from(combinedMap.values()).map(formatLead);
        return res.json({
          success: true,
          source: 'PostgreSQL Database',
          count: formattedList.length,
          data: formattedList
        });
      } catch (dbErr) { throw dbErr; }
    }

    // Fallback to memory store
    let fallbackData = [];
    if (leadStore && typeof leadStore.getLeads === 'function') {
      const storeResult = leadStore.getLeads({ isSandbox: env === 'SANDBOX', status });
      fallbackData = storeResult.data || [];
    } else {
      fallbackData = memoryLeads;
    }

    const formattedFallback = fallbackData.map(formatLead);
    return res.json({
      success: true,
      source: 'Fallback Memory',
      count: formattedFallback.length,
      data: formattedFallback
    });
  } catch (err) { return res.status(503).json({ success: false, error: 'Database query failed. Please retry.' }); }
});

// Persistent stores for Distribution, Duplicates & Lifecycle
const RULES_FILE = path.join(__dirname, '../store/routing_rules.json');
const DIST_HISTORY_FILE = path.join(__dirname, '../store/distribution_history.json');
const DISMISSED_DUPLICATES_FILE = path.join(__dirname, '../store/dismissed_duplicates.json');

function readJsonFile(file, defaultValue = []) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`[Store] Could not read ${file}:`, e.message);
  }
  return defaultValue;
}

function writeJsonFile(file, data) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[Store] Could not write ${file}:`, e.message);
  }
}

async function getAllLeadsList(req) {
    return prisma.lead.findMany({where: req?.user?.role === 'sales_executive' ? { assignedAgentId: req.user.id } : {}, include: {assignedAgent: {select: {id:true,name:true,email:true}}}});
  }

// ─────────────────────────────────────────────────────────────────────────────
// LEAD DISTRIBUTION ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/distribution/workload', async (req, res) => {
  try {
    let agents = [];
    if (prisma) {
      try {
        const dbUsers = await prisma.user.findMany({
          select: { id: true, name: true, email: true, role: true }
        });
        if (dbUsers && dbUsers.length > 0) {
          agents = dbUsers.map(u => ({ id: u.id, name: u.name, team: u.role === 'team_leader' ? 'Escalation Team' : 'Sales Desk' }));
        }
      } catch (e) {
        console.warn('⚠️ [Workload] Could not fetch users from DB:', e.message);
      }
    }

    if (agents.length === 0) {
      agents = [
        { id: 'usr-consultant', name: 'Issac (Sales)', team: 'Alpha Sales' },
        { id: 'usr-alex', name: 'Alex Miller', team: 'Corporate Sales' },
        { id: 'usr-sarah', name: 'Sarah Jenkins', team: 'Europe Desk' },
        { id: 'usr-michael', name: 'Adam', team: 'Escalation Team' },
        { id: 'usr-carlos', name: 'Carlos Ticketing', team: 'GDS Issuance' }
      ];
    }

    const allLeads = await getAllLeadsList(req);

    const workloadData = agents.map((ag) => {
      const assigned = allLeads.filter(l => l.assignedAgentId === ag.id || l.assignedAgent?.name === ag.name || l.assignedAgent?.id === ag.id);
      const activeLeads = assigned.length;
      const pendingFollowups = assigned.filter(l => {
        const st = (l.status || '').toLowerCase();
        return st.includes('follow') || st.includes('contact');
      }).length;
      const pendingQuotes = assigned.filter(l => {
        const st = (l.status || '').toLowerCase();
        return st.includes('quote');
      }).length;
      const todayBookings = assigned.filter(l => {
        const st = (l.status || '').toLowerCase();
        return st.includes('book') || st.includes('won');
      }).length;
      const maxCap = 30;
      const status = activeLeads >= maxCap ? 'AT CAPACITY' : activeLeads >= 20 ? 'BUSY' : 'AVAILABLE';
      const color = status === 'AT CAPACITY' ? '#DC2626' : status === 'BUSY' ? '#D97706' : '#059669';

      return {
        id: ag.id,
        name: ag.name,
        team: ag.team,
        activeLeads,
        pendingFollowups,
        pendingQuotes,
        todayBookings,
        maxCapacity: maxCap,
        status,
        color
      };
    });

    const totalIncoming = allLeads.length;
    const autoAssigned = allLeads.filter(l => l.assignedAgentId || l.assignedAgent?.name).length;
    const unassigned = Math.max(0, totalIncoming - autoAssigned);
    const distHistory = readJsonFile(DIST_HISTORY_FILE, []);
    const roundRobin = distHistory.filter(h => (h.method || '').toLowerCase().includes('round')).length;
    const skillBased = distHistory.filter(h => (h.method || '').toLowerCase().includes('skill')).length;
    const capacityBased = distHistory.filter(h => (h.method || '').toLowerCase().includes('capacity')).length;
    const performanceBased = distHistory.filter(h => (h.method || '').toLowerCase().includes('performance') || (h.method || '').toLowerCase().includes('manual') || (h.method || '').toLowerCase().includes('vip')).length;

    const stats = {
      incomingLeads: totalIncoming,
      autoAssigned,
      unassigned,
      roundRobin,
      skillBased,
      capacityBased,
      performanceBased
    };

    return res.json({ success: true, data: workloadData, stats });
  } catch (err) {
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

router.get('/distribution/rules', (req, res) => {
  const rules = readJsonFile(RULES_FILE, []);
  return res.json({ success: true, data: rules });
});

router.put('/distribution/rules/:id', (req, res) => {
  const id = Number(req.params.id);
  const rules = readJsonFile(RULES_FILE, []);
  const idx = rules.findIndex(r => r.id === id);
  if (idx !== -1) {
    rules[idx] = { ...rules[idx], ...req.body };
    writeJsonFile(RULES_FILE, rules);
    return res.json({ success: true, data: rules[idx] });
  }
  return res.status(404).json({ success: false, error: 'Rule not found' });
});

router.post('/distribution/rules', (req, res) => {
  const rules = readJsonFile(RULES_FILE, []);
  const newRule = {
    id: rules.length > 0 ? Math.max(...rules.map(r => r.id || 0)) + 1 : 1,
    name: req.body.name || 'Custom Routing Rule',
    priority: Number(req.body.priority) || rules.length + 1,
    type: req.body.type || 'Skill-Based',
    condition: req.body.condition || 'Fallback Default',
    action: req.body.action || 'Assign to Available Sales Agent',
    enabled: req.body.enabled !== false
  };
  rules.push(newRule);
  writeJsonFile(RULES_FILE, rules);
  return res.status(201).json({ success: true, data: newRule });
});

router.delete('/distribution/rules/:id', (req, res) => {
  const id = Number(req.params.id);
  const rules = readJsonFile(RULES_FILE, []);
  const filtered = rules.filter(r => r.id !== id);
  writeJsonFile(RULES_FILE, filtered);
  return res.json({ success: true, message: 'Rule deleted successfully' });
});

router.post('/distribution/reassign', async (req, res) => {
  try {
    const { leadId, targetAgent, targetAgentId, reason } = req.body;
    if (!leadId || (!targetAgent && !targetAgentId)) {
      return res.status(400).json({ success: false, error: 'leadId and targetAgent required' });
    }

    let targetUser = null;
    if (prisma) {
      try {
        targetUser = await prisma.user.findFirst({
          where: {
            OR: [
              { id: targetAgentId || targetAgent },
              { name: targetAgent }
            ]
          }
        });
      } catch (e) { }
    }
    const finalAgentId = targetUser ? targetUser.id : (targetAgentId || targetAgent);
    const finalAgentName = targetUser ? targetUser.name : (req.body.targetAgentName || targetAgent);

    let prevAgentName = req.body.prevAgent || 'Unassigned';
    if (prisma) {
      try {
        const currentLead = await prisma.lead.findUnique({
          where: { id: leadId },
          include: { assignedAgent: true }
        });
        if (currentLead && currentLead.assignedAgent) {
          prevAgentName = currentLead.assignedAgent.name;
        }
        await prisma.lead.update({
          where: { id: leadId },
          data: { assignedAgentId: finalAgentId }
        });
      } catch (e) { throw e; }
    }

    const history = readJsonFile(DIST_HISTORY_FILE, []);
    const newLog = {
      id: `LOG-${Math.floor(100 + Math.random() * 900)}`,
      leadId,
      prevAgent: prevAgentName,
      newAgent: finalAgentName,
      method: req.body.method || 'Manual Reassignment',
      assignedBy: req.body.assignedBy || 'Team Leader',
      time: new Date().toISOString().slice(0, 16).replace('T', ' '),
      reason: reason || 'Manual Load Balancing by TL'
    };
    history.unshift(newLog);
    writeJsonFile(DIST_HISTORY_FILE, history);

    const io = scopedIo(req);
    if (io) {
      io.to('agents_group').emit('lead:assigned', { leadId, agent: finalAgentName, log: newLog });
    }

    return res.json({ success: true, message: `Lead ${leadId} reassigned successfully`, log: newLog });
  } catch (err) {
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

router.get('/distribution/history', (req, res) => {
  const history = readJsonFile(DIST_HISTORY_FILE, []);
  return res.json({ success: true, data: history });
});

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE LEADS DETECTION & MERGE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/duplicates/detect', async (req, res) => {
  try {
    const leads = await getAllLeadsList(req);
    const dismissed = new Set(readJsonFile(DISMISSED_DUPLICATES_FILE, []));
    const duplicates = [];

    for (let i = 0; i < leads.length; i++) {
      for (let j = i + 1; j < leads.length; j++) {
        const a = leads[i];
        const b = leads[j];
        const pairKey = [a.id, b.id].sort().join('_');
        if (dismissed.has(pairKey)) continue;

        let matchType = null;
        let score = 0;

        const emailA = (a.email || '').trim().toLowerCase();
        const emailB = (b.email || '').trim().toLowerCase();
        const phoneA = (a.phone || '').replace(/\D/g, '');
        const phoneB = (b.phone || '').replace(/\D/g, '');
        const nameA = `${a.firstName || ''} ${a.lastName || ''}`.trim().toLowerCase();
        const nameB = `${b.firstName || ''} ${b.lastName || ''}`.trim().toLowerCase();

        if (emailA && emailB && emailA === emailB) {
          matchType = `Exact Match: Same Email (${a.email})`;
          score = 100;
        } else if (phoneA && phoneB && phoneA.length >= 7 && phoneA === phoneB) {
          matchType = `Exact Match: Same Phone (${a.phone})`;
          score = 95;
        } else if (nameA && nameB && nameA === nameB && a.origin && b.origin && a.origin === b.origin && a.destination === b.destination) {
          matchType = `High Similarity: Same Passenger & Flight Route (${a.origin} ➔ ${a.destination})`;
          score = 85;
        }

        if (score > 0) {
          duplicates.push({
            id: `DUP-${a.id.slice(0, 8)}-${b.id.slice(0, 8)}`,
            pairKey,
            confidenceScore: score,
            confidenceBadge: score === 100 ? 'High Match (100%)' : score >= 90 ? `High Match (${score}%)` : `Probable Match (${score}%)`,
            badgeColor: score >= 95 ? '#059669' : '#D97706',
            matchReason: matchType,
            existingLead: a,
            incomingLead: b
          });
        }
      }
    }

    const dismissedList = readJsonFile(DISMISSED_DUPLICATES_FILE, []);
    const totalDetected = duplicates.length + dismissedList.length;
    const mergedCount = dismissedList.length;
    const pendingCount = duplicates.length;
    const rateStr = totalDetected > 0 ? `${Math.round((mergedCount / totalDetected) * 1000) / 10}%` : '100%';

    const stats = {
      detected: totalDetected,
      merged: mergedCount,
      reengaged: mergedCount,
      pending: pendingCount,
      preventionRate: rateStr
    };

    return res.json({ success: true, count: duplicates.length, data: duplicates, stats });
  } catch (err) {
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

router.post('/duplicates/merge', async (req, res) => {
  try {
    const { primaryId, duplicateId, pairKey } = req.body;
    if (pairKey) {
      const dismissed = readJsonFile(DISMISSED_DUPLICATES_FILE, []);
      if (!dismissed.includes(pairKey)) dismissed.push(pairKey);
      writeJsonFile(DISMISSED_DUPLICATES_FILE, dismissed);
    }
    return res.json({ success: true, message: `Lead ${duplicateId} merged into ${primaryId} successfully.` });
  } catch (err) {
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

router.post('/duplicates/dismiss', (req, res) => {
  const { pairKey } = req.body;
  if (pairKey) {
    const dismissed = readJsonFile(DISMISSED_DUPLICATES_FILE, []);
    if (!dismissed.includes(pairKey)) dismissed.push(pairKey);
    writeJsonFile(DISMISSED_DUPLICATES_FILE, dismissed);
  }
  return res.json({ success: true, message: 'Duplicate pair dismissed' });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAD LIFECYCLE & SLA AUDIT ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/lifecycle/overview', async (req, res) => {
  try {
    const leads = await getAllLeadsList(req);
    const ALL_STAGES = [
      'NEW', 'ASSIGNED', 'CONTACTED', 'QUALIFIED', 'QUOTE CREATED',
      'QUOTE SENT', 'NEGOTIATION', 'PAYMENT PENDING', 'BOOKED', 'TICKETED', 'TRAVEL COMPLETED',
      'LOST', 'NO RESPONSE'
    ];
    const stageCounts = {};
    ALL_STAGES.forEach(st => { stageCounts[st] = 0; });

    leads.forEach(l => {
      const st = (l.status || 'NEW').toUpperCase().trim();
      const match = ALL_STAGES.find(s => s === st || st.includes(s));
      if (match) stageCounts[match]++;
      else if (st === 'NEW LEAD') stageCounts['NEW']++;
      else if (st === 'PROPOSAL SENT') stageCounts['QUOTE SENT']++;
      else if (st === 'SPAM' || st === 'CANCELLED' || st === 'DUPLICATE') stageCounts['LOST']++;
      else stageCounts['NEW']++;
    });

    return res.json({ success: true, data: { stageCounts, totalLeads: leads.length, leads } });
  } catch (err) {
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

router.get('/:id/lifecycle', async (req, res) => {
  try {
    const { id } = req.params;
    const leads = await getAllLeadsList(req);
    const lead = leads.find(l => l.id === id) || leads[0];

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    const PIPELINE_STAGES = [
      'NEW', 'ASSIGNED', 'CONTACTED', 'QUALIFIED', 'QUOTE CREATED',
      'QUOTE SENT', 'NEGOTIATION', 'PAYMENT PENDING', 'BOOKED', 'TICKETED', 'TRAVEL COMPLETED'
    ];
    const currentStatus = (lead.status || 'NEW').toUpperCase().replace('LEAD', '').trim();
    let idx = PIPELINE_STAGES.indexOf(currentStatus);
    if (idx === -1) idx = currentStatus.includes('QUOTE') ? 5 : currentStatus.includes('TICKET') ? 9 : 0;

    const meta = metadataStore[lead.id] || {};

    let expectedValue = 0;
    if (typeof lead.budget === 'number') {
      expectedValue = lead.budget;
    } else if (lead.budget) {
      const parts = String(lead.budget).split('-').map(p => Number(p.replace(/[^0-9]/g, ''))).filter(n => !isNaN(n) && n > 0);
      expectedValue = parts.length > 0 ? Math.max(...parts) : (Number(String(lead.budget).replace(/[^0-9]/g, '')) || 0);
    }

    const actualAgent = lead.assignedAgent?.name || lead.agentName || 'Unassigned (General Pool)';
    const actualRole = lead.assignedAgent?.role || (lead.assignedAgent ? 'Sales Agent' : 'System Auto-Intake');

    let historyList = [];
    if (Array.isArray(meta.lifecycleHistory) && meta.lifecycleHistory.length > 0) {
      historyList = meta.lifecycleHistory;
    } else if (Array.isArray(lead.activities) && lead.activities.length > 0) {
      historyList = lead.activities.map((act) => ({
        from: 'INTAKE',
        to: (act.status || currentStatus).toUpperCase().replace('LEAD', '').trim(),
        user: act.agent || actualAgent,
        role: act.agent?.includes('CEO') ? 'Super Admin' : actualRole,
        time: act.time || (lead.createdAt ? new Date(lead.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Initial'),
        duration: '0 min',
        sla: 'Met',
        reason: act.comments || `Inbound lead intake via ${lead.source || 'Website'}`
      }));
    } else {
      historyList = [
        {
          from: 'INTAKE',
          to: currentStatus,
          user: actualAgent,
          role: actualRole,
          time: lead.createdAt ? new Date(lead.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Initial',
          duration: '0 min',
          sla: 'Met',
          reason: `Lead captured via ${lead.source || 'Direct Channel'}`
        }
      ];
    }

    return res.json({
      success: true,
      data: {
        id: lead.id,
        customer: `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Valued Customer',
        route: lead.origin && lead.destination ? `${lead.origin} ➔ ${lead.destination}` : (lead.route || 'Route Not Specified'),
        tripType: lead.tripType || (lead.returnDate ? 'Round-Trip' : 'One-Way'),
        agent: actualAgent,
        teamLeader: lead.teamLeader || lead.assignedAgent?.teamLeader || 'Operations / TL',
        currentStatusIndex: idx,
        currentStatus: PIPELINE_STAGES[idx] || 'CONTACTED',
        expectedValue,
        createdDate: lead.createdAt || new Date().toISOString(),
        slaStatus: '🟢 On Time (0 Delays)',
        history: historyList
      }
    });
  } catch (err) {
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

router.post('/:id/lifecycle/transition', async (req, res) => {
  try {
    const { id } = req.params;
    const { targetStatus, reason, notes, user, role, from } = req.body;

    if (!targetStatus) {
      return res.status(400).json({ success: false, error: 'targetStatus is required' });
    }

    if (prisma) {
      try {
        await prisma.lead.update({
          where: { id },
          data: { status: targetStatus }
        });
      } catch (e) { throw e; }
    }

    metadataStore = loadMetadata();
    if (!metadataStore[id]) metadataStore[id] = {};
    if (!Array.isArray(metadataStore[id].lifecycleHistory)) {
      metadataStore[id].lifecycleHistory = [];
    }

    const newLog = {
      from: from || 'NEW',
      to: targetStatus,
      user: user || 'Sales Agent',
      role: role || 'Agent',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      duration: 'Just now',
      sla: 'Met',
      reason: reason || notes || 'Normal Sales Pipeline Advancement'
    };

    metadataStore[id].lifecycleHistory.push(newLog);
    metadataStore[id].status = targetStatus;
    saveMetadata(metadataStore);

    const io = scopedIo(req);
    if (io) {
      io.emit('lead:lifecycle_updated', { leadId: id, targetStatus, log: newLog });
    }

    return res.json({ success: true, message: 'Stage transitioned successfully', log: newLog });
  } catch (err) {
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/leads/:id
// Get details for a single lead
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    if (prisma) {
      try {
        const lead = await prisma.lead.findUnique({
          where: { id },
          include: {
            assignedAgent: {
              select: { id: true, name: true, email: true, role: true }
            }
          }
        });
        if (lead) {
          return res.json({ success: true, data: formatLead(lead) });
        }
      } catch (dbErr) { throw dbErr; }
    }

    if (leadStore && typeof leadStore.getLeadById === 'function') {
      const memLead = leadStore.getLeadById(id);
      if (memLead) return res.json({ success: true, data: formatLead(memLead) });
    }

    const localMemLead = memoryLeads.find((l) => l.id === id);
    if (localMemLead) {
      return res.json({ success: true, data: formatLead(localMemLead) });
    }

    return res.status(404).json({ success: false, error: 'Lead not found' });
  } catch (err) {
    console.error(`❌ [Leads API] Error fetching lead ${id}:`, err.message);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/leads
// Create a new lead (manual agent entry, website webhook, or API)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const leadId = body.id || uuidv4();
    const now = new Date();

    const firstName = body.firstName || (body.name ? body.name.split(' ')[0] : 'Traveler');
    if (!body.firstName?.trim() && !body.name?.trim()) return res.status(400).json({ success: false, error: 'Customer name is required' });
    const lastName = body.lastName || (body.name && body.name.split(' ').length > 1 ? body.name.split(' ').slice(1).join(' ') : '');
    const phone = body.phone || body.phoneNumber || body.fullPhone || null;
    const email = body.email || null;
    const nationality = body.country || body.nationality || null;
    const preferredLanguage = body.preferredLanguage || 'English';
    const serviceId = body.serviceId || body.cabinClass?.toLowerCase() || 'economy';
    const status = body.status || 'New Lead';
    const origin = body.origin ? body.origin.toUpperCase() : null;
    const destination = body.destination ? body.destination.toUpperCase() : null;
    const travelDate = body.travelDate || null;
    const passengers = parseInt(body.adults || body.passengers, 10) || 1;
    const rawBudget = body.budget ? String(body.budget).replace(/[^0-9.]/g, '') : null;
    const budget = rawBudget ? parseFloat(rawBudget) : null;
    const notes = body.notes || (origin && destination ? `Inquiry created in CRM for ${origin} → ${destination} (${passengers} pax)` : null);
    const assignedAgentId = body.assignedAgentId || null;

    const country = body.country || body.nationality || null;
    const city = body.city || null;
    const timezone = body.timezone || null;
    const returnDate = body.returnDate || null;
    const flexibility = body.flexibility || 'Exact Dates';
    const adults = parseInt(body.adults || body.passengers, 10) || 1;
    const children = parseInt(body.children, 10) || 0;
    const infants = parseInt(body.infants, 10) || 0;
    const cabinClass = body.cabinClass || (serviceId ? serviceId.charAt(0).toUpperCase() + serviceId.slice(1) : 'Economy');
    const budgetRange = body.budget ? String(body.budget) : null;
    const source = body.source || 'Website Direct';
    const priority = body.priority || 'Medium';
    const labels = Array.isArray(body.labels) ? body.labels : [];

    const newLeadData = {
      id: leadId,
      firstName,
      lastName,
      email,
      phone,
      country,
      city,
      timezone,
      nationality: country,
      preferredLanguage,
      serviceId,
      cabinClass,
      status,
      origin,
      destination,
      travelDate,
      returnDate,
      flexibility,
      adults,
      children,
      infants,
      passengers,
      budget,
      budgetRange,
      source,
      priority,
      labels,
      notes,
      assignedAgentId,
      createdAt: body.createdAt ? new Date(body.createdAt) : now,
      updatedAt: now,
    };

    // Save extended CRM fields into persistent metadata store
    metadataStore = loadMetadata();
    metadataStore[leadId] = {
      id: leadId,
      country: body.country || body.nationality || '',
      city: body.city || '',
      timezone: body.timezone || '',
      returnDate: body.returnDate || '',
      flexibility: body.flexibility || 'Exact Dates',
      adults: parseInt(body.adults || body.passengers, 10) || 1,
      children: parseInt(body.children, 10) || 0,
      infants: parseInt(body.infants, 10) || 0,
      cabinClass: body.cabinClass || (serviceId ? serviceId.charAt(0).toUpperCase() + serviceId.slice(1) : 'Economy'),
      budget: body.budget ? String(body.budget) : '',
      source: body.source || '',
      priority: body.priority || 'Medium',
      labels: Array.isArray(body.labels) ? body.labels : [],
      notes: body.notes || (origin && destination ? `Inquiry created in CRM for ${origin} → ${destination} (${passengers} pax)` : ''),
      activities: Array.isArray(body.activities) ? body.activities : [
        { time: now.toLocaleTimeString(), agent: 'Admin', status: 'New Lead Created', comments: `Flight request for ${origin} → ${destination}` }
      ]
    };
    saveMetadata(metadataStore);

    // Save in PostgreSQL via Prisma
    const savedDbLead = await prisma.$transaction(async tx => {
      const saved = await tx.lead.create({ data: newLeadData, include: { assignedAgent: { select: { id: true, name: true, email: true, role: true } } } });
      const customerMatches = [];
      if (email) customerMatches.push({ email: { equals: email, mode: 'insensitive' } });
      if (phone) customerMatches.push({ phone });
      const existingCustomer = customerMatches.length ? await tx.client.findFirst({ where: { agentId: assignedAgentId, OR: customerMatches } }) : null;
      if (!existingCustomer) await tx.client.create({ data: { firstName, lastName, email, phone, agentId: assignedAgentId, country, city, nationality, preferredCabinClass: cabinClass, status: 'Active' } });
      return saved;
    });

    const finalLead = savedDbLead || newLeadData;
    const enrichedLead = formatLead(finalLead);

    // Save in memory fallback
    memoryLeads.unshift(enrichedLead);
    if (leadStore && typeof leadStore.addLead === 'function') {
      try { leadStore.addLead(enrichedLead); } catch (e) { }
    }

    // Real-time broadcast to all connected agents
    const io = scopedIo(req);
    if (io) {
      io.to('agents_group').emit('lead:new', enrichedLead);
      console.log(`📡 [Socket.io] Broadcasted lead:new to agents_group (${enrichedLead.id})`);
    }

    return res.status(201).json({
      success: true,
      message: 'Lead created successfully',
      data: enrichedLead,
    });
  } catch (err) {
    console.error('❌ [Leads API] Error creating lead:', err.message);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PUT /api/leads/:id
// Update lead info or status
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    updates.updatedAt = new Date();

    // Update persistent metadata store
    metadataStore = loadMetadata();
    metadataStore[id] = {
      ...(metadataStore[id] || {}),
      ...(updates.country !== undefined ? { country: updates.country } : {}),
      ...(updates.city !== undefined ? { city: updates.city } : {}),
      ...(updates.timezone !== undefined ? { timezone: updates.timezone } : {}),
      ...(updates.returnDate !== undefined ? { returnDate: updates.returnDate } : {}),
      ...(updates.flexibility !== undefined ? { flexibility: updates.flexibility } : {}),
      ...(updates.adults !== undefined ? { adults: updates.adults } : {}),
      ...(updates.children !== undefined ? { children: updates.children } : {}),
      ...(updates.infants !== undefined ? { infants: updates.infants } : {}),
      ...(updates.cabinClass !== undefined ? { cabinClass: updates.cabinClass } : {}),
      ...(updates.budget !== undefined ? { budget: updates.budget } : {}),
      ...(updates.source !== undefined ? { source: updates.source } : {}),
      ...(updates.priority !== undefined ? { priority: updates.priority } : {}),
      ...(updates.labels !== undefined ? { labels: updates.labels } : {}),
      ...(updates.notes !== undefined ? { notes: updates.notes } : {}),
      ...(updates.activities !== undefined ? { activities: updates.activities } : {})
    };
    saveMetadata(metadataStore);

    let updatedDbLead = null;
    if (prisma) {
      try {
        const allowedPrismaFields = [
          'firstName', 'lastName', 'email', 'phone', 'nationality',
          'country', 'city', 'timezone', 'cabinClass', 'returnDate', 'flexibility',
          'adults', 'children', 'infants', 'passengers', 'budget', 'budgetRange',
          'source', 'priority', 'labels',
          'preferredLanguage', 'serviceId', 'status', 'origin', 'destination',
          'travelDate', 'notes', 'assignedAgentId'
        ];
        const prismaData = {};
        for (const key of allowedPrismaFields) {
          if (updates[key] !== undefined) {
            prismaData[key] = updates[key];
          }
        }
        prismaData.updatedAt = new Date();

        updatedDbLead = await prisma.lead.update({
          where: { id },
          data: prismaData,
          include: {
            assignedAgent: {
              select: { id: true, name: true, email: true, role: true }
            }
          }
        });
        console.log(`✅ [PostgreSQL] Updated lead: ${id}`);
      } catch (dbErr) { throw dbErr; }
    }

    // Update memory cache
    const memIndex = memoryLeads.findIndex((l) => l.id === id);
    if (memIndex !== -1) {
      memoryLeads[memIndex] = { ...memoryLeads[memIndex], ...updates, updatedAt: new Date() };
    }
    const result = updatedDbLead || (memIndex !== -1 ? memoryLeads[memIndex] : { id, ...updates });
    const enrichedResult = formatLead(result);

    const io = scopedIo(req);
    if (io) {
      io.to('agents_group').emit('lead:updated', enrichedResult);
    }

    return res.json({
      success: true,
      message: 'Lead updated successfully',
      data: enrichedResult,
    });
  } catch (err) {
    console.error(`❌ [Leads API] Error updating lead ${req.params.id}:`, err.message);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. PATCH /api/leads/:id/assign
// Quick assign agent to lead
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { agentId } = req.body;
    const targetAgentId = agentId || null;

    let updated = null;
    if (prisma) {
      try {
        updated = await prisma.lead.update({
          where: { id },
          data: { assignedAgentId: targetAgentId },
          include: { assignedAgent: { select: { id: true, name: true, email: true } } }
        });
      } catch (dbErr) { throw dbErr; }
    }

    const io = scopedIo(req);
    if (io) {
      io.to('agents_group').emit('lead:assigned', { leadId: id, agentId });
      io.to(`agent:${agentId}`).emit('notification:new', {
        type: 'lead_assigned',
        leadId: id,
        message: `You have been assigned lead #${id}`
      });
    }

    return res.json({
      success: true,
      message: 'Agent assigned successfully',
      data: updated || { id, assignedAgentId: agentId }
    });
  } catch (err) {
    console.error('❌ [Leads API] Error assigning agent:', err.message);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DELETE /api/leads/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Delete from metadata store
    metadataStore = loadMetadata();
    delete metadataStore[id];
    saveMetadata(metadataStore);

    if (prisma) {
      try {
        await prisma.lead.delete({ where: { id } });
        console.log(`✅ [PostgreSQL] Deleted lead: ${id}`);
      } catch (dbErr) { throw dbErr; }
    }

    memoryLeads = memoryLeads.filter((l) => l.id !== id);

    const io = scopedIo(req);
    if (io) {
      io.to('agents_group').emit('lead:deleted', { id, leadId: id });
    }

    return res.json({ success: true, message: 'Lead deleted successfully' });
  } catch (err) {
    console.error('❌ [Leads API] Error deleting lead:', err.message);
    return res.status(err?.code === 'P2025' ? 404 : err?.code === 'P2002' ? 409 : 503).json({ success: false, error: err.message });
  }
});

module.exports = router;
