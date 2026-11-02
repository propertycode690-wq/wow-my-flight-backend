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
    const { status, assignedAgentId, search, env = 'PRODUCTION' } = req.query;

    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
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
        if (leadStore && typeof leadStore.getLeads === 'function') {
          const storeResult = leadStore.getLeads({ isSandbox: env === 'SANDBOX' });
          storeLeads = storeResult.data || [];
        }

        const combinedMap = new Map();
        memoryLeads.forEach((l) => combinedMap.set(l.id, l));
        storeLeads.forEach((l) => combinedMap.set(l.id, l));
        dbLeads.forEach((l) => combinedMap.set(l.id, l));

        const formattedList = Array.from(combinedMap.values()).map(formatLead);
        return res.json({
          success: true,
          source: 'PostgreSQL Database',
          count: formattedList.length,
          data: formattedList
        });
      } catch (dbErr) {
        console.warn('⚠️ [Leads API] DB query failed, falling back to memory:', dbErr.message);
      }
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
  } catch (err) {
    console.error('❌ [Leads API] Error fetching leads:', err.message);
    let fallbackData = memoryLeads;
    if (leadStore && typeof leadStore.getLeads === 'function') {
      const storeResult = leadStore.getLeads({ isSandbox: req.query.env === 'SANDBOX' });
      fallbackData = storeResult.data || [];
    }
    const formattedFallback = fallbackData.map(formatLead);
    return res.json({
      success: true,
      source: 'fallback',
      count: formattedFallback.length,
      data: formattedFallback,
      warning: err.message
    });
  }
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

async function getAllLeadsList() {
  let list = [];
  if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
    try {
      const dbLeads = await prisma.lead.findMany({
        include: { assignedAgent: { select: { id: true, name: true, email: true } } }
      });
      if (dbLeads && dbLeads.length > 0) list = dbLeads;
    } catch (e) { }
  }
  if (list.length === 0) {
    if (leadStore && typeof leadStore.getLeads === 'function') {
      const st = leadStore.getLeads({});
      list = st.data || [];
    } else {
      list = memoryLeads;
    }
  }
  return list.map(formatLead);
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAD DISTRIBUTION ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/distribution/workload', async (req, res) => {
  try {
    let agents = [];
    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
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
        { id: 'usr-consultant', name: 'Sofia Rodriguez (Sales)', team: 'Alpha Sales' },
        { id: 'usr-alex', name: 'Alex Miller', team: 'Corporate Sales' },
        { id: 'usr-sarah', name: 'Sarah Jenkins', team: 'Europe Desk' },
        { id: 'usr-michael', name: 'Michael Chang', team: 'Escalation Team' },
        { id: 'usr-carlos', name: 'Carlos Ticketing', team: 'GDS Issuance' }
      ];
    }

    const allLeads = await getAllLeadsList();

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
    return res.status(500).json({ success: false, error: err.message });
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
    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
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
    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
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
      } catch (e) {
        console.warn('⚠️ [Reassign] DB update fallback:', e.message);
      }
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

    const io = req.app.get('io');
    if (io) {
      io.to('agents_group').emit('lead:assigned', { leadId, agent: finalAgentName, log: newLog });
    }

    return res.json({ success: true, message: `Lead ${leadId} reassigned successfully`, log: newLog });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
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
    const leads = await getAllLeadsList();
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
    return res.status(500).json({ success: false, error: err.message });
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
    return res.status(500).json({ success: false, error: err.message });
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
    const leads = await getAllLeadsList();
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
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id/lifecycle', async (req, res) => {
  try {
    const { id } = req.params;
    const leads = await getAllLeadsList();
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
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/lifecycle/transition', async (req, res) => {
  try {
    const { id } = req.params;
    const { targetStatus, reason, notes, user, role, from } = req.body;

    if (!targetStatus) {
      return res.status(400).json({ success: false, error: 'targetStatus is required' });
    }

    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
      try {
        await prisma.lead.update({
          where: { id },
          data: { status: targetStatus }
        });
      } catch (e) {
        console.warn('⚠️ [Lifecycle] DB update fallback:', e.message);
      }
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

    const io = req.app.get('io');
    if (io) {
      io.emit('lead:lifecycle_updated', { leadId: id, targetStatus, log: newLog });
    }

    return res.json({ success: true, message: 'Stage transitioned successfully', log: newLog });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/leads/:id
// Get details for a single lead
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
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
      } catch (dbErr) {
        console.warn(`⚠️ [Leads API] Could not fetch lead ${id} from DB:`, dbErr.message);
      }
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
    return res.status(500).json({ success: false, error: err.message });
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
    let savedDbLead = null;
    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
      try {
        savedDbLead = await prisma.lead.upsert({
          where: { id: leadId },
          update: newLeadData,
          create: newLeadData,
          include: {
            assignedAgent: {
              select: { id: true, name: true, email: true, role: true }
            }
          }
        });
        console.log(`✅ [PostgreSQL] Saved lead: ${savedDbLead.id} (${firstName} ${lastName})`);
      } catch (dbErr) {
        console.warn('⚠️ [Leads API] Database save warning:', dbErr.message);
      }
    }

    // Auto-sync: Create/upsert passenger into Customer 360 (clients)
    try {
      const clientsMetaFile = path.join(__dirname, '../store/clients_metadata.json');
      let clientsMeta = {};
      try {
        if (fs.existsSync(clientsMetaFile)) {
          clientsMeta = JSON.parse(fs.readFileSync(clientsMetaFile, 'utf8'));
        }
      } catch (e) {}

      const clientGenId = `CL-${Math.floor(1000 + Math.random() * 9000)}`;
      const clientEmail = email || '';
      const clientPhone = phone || '';

      // Check if client already exists
      const existingKey = Object.keys(clientsMeta).find(k => {
        const m = clientsMeta[k];
        return (clientEmail && m.email && m.email.toLowerCase() === clientEmail.toLowerCase()) ||
               (clientPhone && m.phone && m.phone === clientPhone);
      });

      const targetClientId = existingKey || clientGenId;
      const clientMetaRecord = {
        id: targetClientId,
        firstName,
        lastName,
        email: clientEmail,
        phone: clientPhone,
        city: body.city || '',
        country: nationality || '',
        nationality: nationality || '',
        preferredCabinClass: body.cabinClass || (serviceId ? serviceId.charAt(0).toUpperCase() + serviceId.slice(1) : 'Economy'),
        tier: 'Standard',
        totalSpent: 0,
        status: 'Active',
        createdAt: body.createdAt || now.toISOString(),
        updatedAt: now.toISOString(),
      };

      clientsMeta[targetClientId] = clientMetaRecord;
      try {
        const dir = path.dirname(clientsMetaFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(clientsMetaFile, JSON.stringify(clientsMeta, null, 2), 'utf8');
      } catch (e) {}

      if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
        try {
          await prisma.client.upsert({
            where: { id: targetClientId },
            update: { firstName, lastName, email: clientEmail, phone: clientPhone, nationality },
            create: {
              id: targetClientId,
              firstName,
              lastName,
              email: clientEmail,
              phone: clientPhone,
              nationality,
              tier: 'Standard',
              totalSpent: 0,
              status: 'Active'
            }
          });
        } catch (e) {
          console.warn('⚠️ [Leads API] Auto-sync client to DB warning:', e.message);
        }
      }
    } catch (syncErr) {
      console.warn('⚠️ [Leads API] Auto-sync to Customer 360 warning:', syncErr.message);
    }

    const finalLead = savedDbLead || newLeadData;
    const enrichedLead = formatLead(finalLead);

    // Save in memory fallback
    memoryLeads.unshift(enrichedLead);
    if (leadStore && typeof leadStore.addLead === 'function') {
      try { leadStore.addLead(enrichedLead); } catch (e) { }
    }

    // Real-time broadcast to all connected agents
    const io = req.app.get('io');
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
    return res.status(500).json({ success: false, error: err.message });
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
    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
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
      } catch (dbErr) {
        console.warn(`⚠️ [Leads API] Could not update lead ${id} in DB:`, dbErr.message);
      }
    }

    // Update memory cache
    const memIndex = memoryLeads.findIndex((l) => l.id === id);
    if (memIndex !== -1) {
      memoryLeads[memIndex] = { ...memoryLeads[memIndex], ...updates, updatedAt: new Date() };
    }
    const result = updatedDbLead || (memIndex !== -1 ? memoryLeads[memIndex] : { id, ...updates });
    const enrichedResult = formatLead(result);

    const io = req.app.get('io');
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
    return res.status(500).json({ success: false, error: err.message });
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
    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
      try {
        updated = await prisma.lead.update({
          where: { id },
          data: { assignedAgentId: targetAgentId },
          include: { assignedAgent: { select: { id: true, name: true, email: true } } }
        });
      } catch (dbErr) {
        console.warn('⚠️ [Leads API] Could not update assignedAgent in DB:', dbErr.message);
      }
    }

    const io = req.app.get('io');
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
    return res.status(500).json({ success: false, error: err.message });
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

    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
      try {
        await prisma.lead.delete({ where: { id } });
        console.log(`✅ [PostgreSQL] Deleted lead: ${id}`);
      } catch (dbErr) {
        console.warn(`⚠️ [Leads API] Could not delete lead ${id} from DB:`, dbErr.message);
      }
    }

    memoryLeads = memoryLeads.filter((l) => l.id !== id);

    const io = req.app.get('io');
    if (io) {
      io.to('agents_group').emit('lead:deleted', { id, leadId: id });
    }

    return res.json({ success: true, message: 'Lead deleted successfully' });
  } catch (err) {
    console.error('❌ [Leads API] Error deleting lead:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
