/**
 * routes/telnyx.js
 * All Telnyx-related API endpoints:
 *   - WebRTC Token generation
 *   - Call dial, hold, mute, transfer, hangup
 *   - Voice Webhook handler (call events)
 *   - SMS send + Messaging webhook
 *   - Call history & disposition
 *   - Phone numbers list
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const Telnyx = require('telnyx');
const { prisma, isDbConnected } = require('../db');
const callStore = require('../store/callStore');

const telnyx = Telnyx(process.env.TELNYX_API_KEY);

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/telnyx/numbers
//    Returns all active phone numbers on the account
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// 1b. GET /api/telnyx/calls/logs
//     Fetches call logs from PostgreSQL / memory store
// ─────────────────────────────────────────────────────────────────────────────
router.get('/calls/logs', async (req, res) => {
  try {
    const { agentId, limit = 50 } = req.query;
    if (prisma) {
      try {
        const where = agentId ? { agentId } : {};
        const logs = await prisma.callLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: parseInt(limit, 10),
        });
        if (logs.length > 0) {
          return res.json({ success: true, count: logs.length, data: logs });
        }
      } catch (dbErr) {
        console.warn('[Telnyx] callLog DB query fallback:', dbErr.message);
      }
    }
    const memLogs = callStore.getCallLogs({ agentId, limit: parseInt(limit, 10) });
    return res.json({ success: true, count: memLogs.length, data: memLogs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST /api/telnyx/token
//    Generates a short-lived WebRTC credential for a logged-in agent.
//    Frontend uses this token to initialize the Telnyx WebRTC SDK.
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/telnyx/calls/dial
// ─────────────────────────────────────────────────────────────────────────────
router.post('/calls/dial', async (req, res) => {
  const { to, from, agentId, agentName, clientName } = req.body;

  if (!to || !from) {
    return res.status(400).json({ success: false, error: 'to and from numbers are required' });
  }

  try {
    const callResponse = await telnyx.calls.create({
      connection_id: process.env.TELNYX_CONNECTION_ID,
      to,
      from,
      from_display_name: 'WowMyFlight',
      record_audio: true,
      record_audio_state: 'enabled',
    });

    const callControlId = callResponse.data?.call_control_id;
    const callLegId = callResponse.data?.call_leg_id;

    // Log the call in our store
    const log = callStore.createCallLog({
      callControlId,
      direction: 'outbound',
      fromNumber: from,
      toNumber: to,
      agentId,
      agentName,
    });

    console.log(`[Telnyx] Outbound call initiated: ${from} → ${to} (agent: ${agentName})`);

    // Start background poller to track call answered and call ended states in real-time
    // (This guarantees live updates even on localhost where Telnyx webhooks cannot reach directly)
    const io = req.app.get('io');
    let hasAnnouncedAnswer = false;
    let consecutiveFailures = 0;
    const pollInterval = setInterval(async () => {
      try {
        const callCheck = await telnyx.calls.retrieve(callControlId);
        const callData = callCheck?.data || {};
        const isAlive = callData.is_alive;

        if (isAlive) {
          consecutiveFailures = 0;
          if (!hasAnnouncedAnswer) {
            hasAnnouncedAnswer = true;
            callStore.markCallAnswered(callControlId);
            if (io) {
              io.emit('telnyx:call_answered', { callControlId, status: 'answered' });
            }
          }
        } else if (isAlive === false) {
          // Telnyx confirmed call is no longer alive / hung up
          clearInterval(pollInterval);
          const endedLog = callStore.markCallEnded(callControlId);
          if (io) {
            io.emit('telnyx:call_ended', {
              callControlId,
              callLogId: endedLog?.id,
              durationSeconds: endedLog?.durationSeconds || 0,
              dispositionRequired: true,
            });
          }
        }
      } catch (pollErr) { return res.status(502).json({success:false,error:'Call operation failed. Please check your phone connection.'}); }
    }, 2000);

    // Safety timeout: stop polling after 30 minutes
    setTimeout(() => clearInterval(pollInterval), 30 * 60 * 1000);

    res.json({
      success: true,
      data: {
        callControlId,
        callLegId,
        callLogId: log.id,
        status: 'dialing',
      },
    });
  } catch (err) { return res.status(502).json({success:false,error:'Call operation failed. Please check your phone connection.'}); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3b. GET /api/telnyx/calls/:callControlId/status
//     Returns real-time status of a live call directly from Telnyx
// ─────────────────────────────────────────────────────────────────────────────
router.get('/calls/:callControlId/status', async (req, res) => {
  const { callControlId } = req.params;

  if (!callControlId) {
    return res.status(400).json({ success: false, error: 'callControlId is required' });
  }

  if (callControlId.startsWith('call_')) {
    const log = callStore.getCallByControlId(callControlId);
    return res.json({
      success: true,
      data: {
        is_alive: log?.status !== 'completed',
        status: log?.status || 'active',
      }
    });
  }

  try {
    const call = await telnyx.calls.retrieve(callControlId);
    const isAlive = Boolean(call?.data?.is_alive);
    const state = isAlive ? 'answered' : 'ended';

    if (!isAlive && call?.data?.is_alive === false) {
      callStore.markCallEnded(callControlId);
    }

    res.json({
      success: true,
      data: {
        is_alive: isAlive,
        status: state,
        telnyxData: call?.data,
      }
    });
  } catch (err) { return res.status(502).json({success:false,error:'Call operation failed. Please check your phone connection.'}); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST /api/telnyx/calls/action
//    In-call controls: mute, hold, unhold, transfer, hangup, send_dtmf
// ─────────────────────────────────────────────────────────────────────────────
router.post('/calls/action', async (req, res) => {
  const { callControlId, action, params = {} } = req.body;

  if (!callControlId || !action) {
    return res.status(400).json({ success: false, error: 'callControlId and action are required' });
  }

  // If simulated call or fallback
  if (callControlId.startsWith('call_')) {
    if (action === 'hangup') callStore.markCallEnded(callControlId);
    if (action === 'hold') callStore.updateCallLog(callControlId, { status: 'on_hold' });
    if (action === 'unhold') callStore.updateCallLog(callControlId, { status: 'answered' });
    return res.json({ success: true, data: { action, status: 'ok', simulated: true } });
  }

  try {
    const call = new telnyx.Call({ id: callControlId });
    let result;

    switch (action) {
      case 'hangup':
        result = await call.hangup();
        callStore.markCallEnded(callControlId);
        break;
      case 'hold':
        result = await call.hold({ audio_url: '' });
        callStore.updateCallLog(callControlId, { status: 'on_hold' });
        break;
      case 'unhold':
        result = await call.unhold();
        callStore.updateCallLog(callControlId, { status: 'answered' });
        break;
      case 'mute':
        result = await call.muteAudio({ mute: true });
        break;
      case 'unmute':
        result = await call.muteAudio({ mute: false });
        break;
      case 'send_dtmf':
        result = await call.sendDTMF({ digits: params.digits });
        break;
      case 'transfer':
        result = await call.transfer({ to: params.to });
        break;
      case 'record_start':
        result = await call.recordStart({ format: 'mp3', channels: 'dual' });
        break;
      case 'record_stop':
        result = await call.recordStop();
        break;
      default:
        return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
    }

    console.log(`[Telnyx] Call action "${action}" on ${callControlId}`);
    res.json({ success: true, data: result });
  } catch (err) { return res.status(502).json({success:false,error:'Call operation failed. Please check your phone connection.'}); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. POST /api/telnyx/calls/disposition
//    Agent saves a mandatory call outcome after a call ends.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/calls/disposition', async (req, res) => {
  try {
    const { callId, agentId, disposition, notes } = req.body;

    if (!callId || !agentId || !disposition) {
      return res.status(400).json({
        success: false,
        error: 'callId, agentId, and disposition are required',
      });
    }

    const entry = callStore.saveDisposition({ callId, agentId, disposition, notes });
    console.log(`[Telnyx] Disposition saved: "${disposition}" for call ${callId} by agent ${agentId}`);

    res.json({ success: true, data: entry });
  } catch (err) {
    console.error('[Telnyx] POST /calls/disposition error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. GET /api/telnyx/calls/history
//    Returns call logs, optionally filtered by agent
// ─────────────────────────────────────────────────────────────────────────────
router.get('/calls/history', (req, res) => {
  try {
    const { agentId, limit } = req.query;
    const logs = callStore.getCallLogs({
      agentId: agentId || null,
      limit: parseInt(limit || 50),
    });
    res.json({ success: true, data: logs });
  } catch (err) {
    console.error('[Telnyx] GET /calls/history error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6.5. DELETE /api/telnyx/calls/:id
router.delete('/calls/:id', (req, res) => {
  try {
    const { id } = req.params;
    callStore.deleteCallLog(id);
    res.json({ success: true, message: 'Call log deleted successfully' });
  } catch (err) {
    console.error('[Telnyx] DELETE /calls/:id error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. POST /api/telnyx/sms/send
//    Sends an SMS to a customer using the messaging profile
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// 8. POST /api/telnyx/webhooks/voice
//    Receives all Telnyx Call Control webhook events.
//    IMPORTANT: This URL must be set in Telnyx portal under your Connection.
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// 9. POST /api/telnyx/webhooks/messaging
//    Receives SMS delivery status updates & inbound SMS messages
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// 10. CALL DISPOSITIONS: GET & POST /api/telnyx/dispositions
// ─────────────────────────────────────────────────────────────────────────────
const DISPOSITION_FILE = path.join(__dirname, '../store/disposition_logs.json');

const DISPOSITION_CONFIG = [
  { name: 'Interested', category: 'Positive', color: '#059669', icon: '👍', action: 'Create follow-up task and keep lead active.' },
  { name: 'Quote Sent', category: 'Positive', color: '#2563EB', icon: '📄', action: 'Update lead status to Quote Sent and save quote activity.' },
  { name: 'Payment Pending', category: 'Positive', color: '#059669', icon: '💳', action: 'Start payment reminder workflow and SLA timer.' },
  { name: 'Booked', category: 'Positive', color: '#16A34A', icon: '✈️', action: 'Convert lead into booking and notify ticketing team.' },
  { name: 'Callback Requested', category: 'Follow-up', color: '#D97706', icon: '⏰', action: 'Schedule callback with reminder and notification.' },
  { name: 'Busy', category: 'Follow-up', color: '#C59B27', icon: '⏳', action: 'Create retry task after configured interval.' },
  { name: 'No Answer', category: 'Follow-up', color: '#9CA3AF', icon: '📵', action: 'Increment contact attempt counter and schedule retry.' },
  { name: 'Not Interested', category: 'Negative', color: '#6B7280', icon: '❌', action: 'Move lead to Lost pipeline and require lost reason.' },
  { name: 'Wrong Number', category: 'Negative', color: '#DC2626', icon: '⚠️', action: 'Flag lead for verification and possible duplicate review.' },
  { name: 'Escalated', category: 'Escalation', color: '#7C3AED', icon: '🚨', action: 'Notify Team Leader and create escalation task.' },
  { name: 'Complaint', category: 'Escalation', color: '#B91C1C', icon: '👿', action: 'Create complaint case and notify customer support.' }
];

router.get('/dispositions', (req, res) => {
  try {
    let logs = [];
    if (fs.existsSync(DISPOSITION_FILE)) {
      logs = JSON.parse(fs.readFileSync(DISPOSITION_FILE, 'utf8'));
    }
    return res.json({
      success: true,
      categories: DISPOSITION_CONFIG,
      data: logs
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/dispositions', async (req, res) => {
  try {
    const { customer, phone, agent, disposition, notes, actionTaken, callbackDateTime, bookingValue } = req.body;
    if (!disposition) {
      return res.status(400).json({ success: false, error: 'disposition is required' });
    }

    let logs = [];
    if (fs.existsSync(DISPOSITION_FILE)) {
      try { logs = JSON.parse(fs.readFileSync(DISPOSITION_FILE, 'utf8')); } catch (e) { }
    }

    const now = new Date();
    const formattedTimestamp = now.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    const newLog = {
      id: `LOG-${Math.floor(100 + Math.random() * 900)}`,
      customer: customer || 'Customer',
      phone: phone || '',
      agent: agent || 'Sales Agent',
      disposition,
      notes: notes || '',
      createdAt: now.toISOString(),
      time: formattedTimestamp,
      actionTaken: actionTaken || `Updated Status to ${disposition}`,
      callbackDateTime: callbackDateTime || null,
      bookingValue: bookingValue ? Number(bookingValue) : null
    };

    logs.unshift(newLog);
    const dir = path.dirname(DISPOSITION_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DISPOSITION_FILE, JSON.stringify(logs, null, 2), 'utf8');

    // If phone or leadId matches a lead in DB, update lead status
    if (prisma && (typeof isDbConnected !== 'function' || isDbConnected())) {
      try {
        let matchingLead = null;
        if (req.body.leadId) {
          matchingLead = await prisma.lead.findUnique({
            where: { id: req.body.leadId }
          });
        }
        if (!matchingLead && phone) {
          const cleanPhone = phone.replace(/\D/g, '');
          if (cleanPhone.length >= 7) {
            matchingLead = await prisma.lead.findFirst({
              where: {
                OR: [
                  { phone: { contains: cleanPhone.slice(-10) } }
                ]
              }
            });
          }
        }
        if (matchingLead) {
          const leadStatusMap = {
            'Quote Sent': 'Proposal Sent',
            'Booked': 'Booked',
            'Payment Pending': 'Payment Pending',
            'Not Interested': 'Lost',
            'Interested': 'Contacted'
          };
          const nextStatus = leadStatusMap[disposition] || 'Contacted';
          await prisma.lead.update({
            where: { id: matchingLead.id },
            data: { status: nextStatus }
          });
          newLog.linkedLead = `${matchingLead.name} (${matchingLead.id})`;
        }
      } catch (e) {
        console.warn('⚠️ [Disposition] Could not auto-sync lead status:', e.message);
      }
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('telnyx:disposition_created', newLog);
    }

    return res.json({ success: true, message: 'Disposition recorded successfully', log: newLog });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/dispositions/:id', (req, res) => {
  try {
    const { id } = req.params;
    let logs = [];
    if (fs.existsSync(DISPOSITION_FILE)) {
      try { logs = JSON.parse(fs.readFileSync(DISPOSITION_FILE, 'utf8')); } catch (e) {}
    }
    const filtered = logs.filter(l => l.id !== id);
    fs.writeFileSync(DISPOSITION_FILE, JSON.stringify(filtered, null, 2), 'utf8');
    return res.json({ success: true, message: 'Disposition deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
