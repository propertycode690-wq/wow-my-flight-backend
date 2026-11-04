const express = require('express');
const { prisma } = require('../db');
const Telnyx = require('telnyx');
const router = express.Router();
const pendingCredentials = new Map();

async function telnyxRequest(path, method = 'GET', body, attempt = 0) {
  const response = await fetch(`https://api.telnyx.com/v2/${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!response.ok) {
    if (path.endsWith('/token') && response.status >= 500 && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      return telnyxRequest(path, method, body, attempt + 1);
    }
    const error = new Error('Telnyx request failed');
    error.status = response.status;
    try { error.message = JSON.parse(text).errors?.[0]?.detail || error.message; } catch {}
    throw error;
  }
  try { return JSON.parse(text); } catch { return text; }
}

async function getAgent(req) {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user || user.status !== 'active' || !user.phone) throw new Error('No active phone assignment for this account');
  return user;
}

async function credentialFor(user) {
  if (user.telnyxCredentialId && user.telnyxSipUsername) return user;
  if (!pendingCredentials.has(user.id)) {
    pendingCredentials.set(user.id, (async () => {
      const connection = process.env.TELNYX_CREDENTIAL_CONNECTION_ID;
      if (!connection) throw new Error('Calling connection is not configured');
      const { data } = await telnyxRequest('telephony_credentials', 'POST', { connection_id: connection, name: `WowMyFlight ${user.id}` });
      return prisma.user.update({ where: { id: user.id }, data: { telnyxCredentialId: data.id, telnyxSipUsername: data.sip_username } });
    })().finally(() => pendingCredentials.delete(user.id)));
  }
  return pendingCredentials.get(user.id);
}

router.get('/numbers', async (req, res) => {
  try {
    const user = await getAgent(req);
    const { data } = await telnyxRequest('phone_numbers?page[size]=100');
    const numbers = data.filter(n => n.phone_number === user.phone && n.status === 'active');
    if (!numbers.length) return res.status(409).json({ success: false, error: 'Assigned number is unavailable on Telnyx' });
    res.json({ success: true, data: numbers.map(n => ({ id: n.id, number: n.phone_number, type: n.phone_number_type, status: n.status })) });
  } catch (error) { res.status(502).json({ success: false, error: error.message }); }
});

router.post('/token', async (req, res) => {
  try {
    const agent = await credentialFor(await getAgent(req));
    const token = await telnyxRequest(`telephony_credentials/${agent.telnyxCredentialId}/token`, 'POST');
    if (typeof token !== 'string' || token.split('.').length !== 3) throw new Error('Invalid calling token received');
    res.set('Cache-Control', 'no-store').json({ success: true, data: { token, fromNumber: agent.phone } });
  } catch (error) { res.status(502).json({ success: false, error: error.message }); }
});

router.post('/calls/dial', (req, res) => res.status(409).json({ success: false, error: 'Connect the browser phone and dial from Calls & SMS to establish audio.' }));

router.get('/calls/logs', async (req, res) => {
  try {
    const where = req.user.role === 'sales_executive' ? { agentId: req.user.id } : (req.query.agentId ? { agentId: req.query.agentId } : {});
    const data = await prisma.callLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(200, Math.max(1, Number(req.query.limit) || 50)) });
    res.json({ success: true, data, count: data.length });
  } catch { res.status(503).json({ success: false, error: 'Could not load call logs' }); }
});

router.get('/sms', async (req, res) => {
  try {
    const agent = await getAgent(req);
    const data = await prisma.sMSLog.findMany({ where: { OR: [{ fromNumber: agent.phone }, { toNumber: agent.phone }] }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ success: true, data });
  } catch { res.status(503).json({ success: false, error: 'Could not load messages' }); }
});

router.post('/sms/send', async (req, res) => {
  try {
    const agent = await getAgent(req);
    const { to, text, from } = req.body || {};
    if (!/^\+[1-9]\d{7,14}$/.test(to || '') || typeof text !== 'string' || !text.trim() || text.length > 1600) {
      return res.status(400).json({ success: false, error: 'Enter an international phone number and a message of 1–1600 characters' });
    }
    if (from && from !== agent.phone) return res.status(403).json({ success: false, error: 'Use your assigned phone number' });
    const { data } = await telnyxRequest('messages', 'POST', { from: agent.phone, to, text, messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID });
    const status = data.to?.[0]?.status || 'queued';
    await prisma.sMSLog.create({ data: { telnyxMessageId: data.id, direction: 'outbound', fromNumber: agent.phone, toNumber: to, text, status, agentId: agent.id } });
    res.json({ success: true, data: { messageId: data.id, from: agent.phone, to, status } });
  } catch (error) { res.status(502).json({ success: false, error: error.message }); }
});

let publicKey;
async function verifyWebhook(req, res, next) {
  try {
    publicKey ||= process.env.TELNYX_PUBLIC_KEY || (await telnyxRequest('public_key')).data.public;
    const timestamp = req.get('telnyx-timestamp');
    if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error('Invalid timestamp');
    Telnyx(process.env.TELNYX_API_KEY).webhooks.constructEvent(req.rawBody, req.get('telnyx-signature-ed25519'), timestamp, publicKey);
    next();
  } catch { res.status(401).json({ success: false, error: 'Invalid webhook signature' }); }
}

router.post('/webhooks/voice', verifyWebhook, async (req, res) => {
  try {
    const event = req.body.data;
    const p = event?.payload;
    if (!p?.call_control_id) return res.status(400).json({ error: 'Invalid call event' });
    const id = p.call_control_id;
    const io = req.app.get('io');
    if (event.event_type === 'call.initiated') {
      const inbound = p.direction === 'incoming' || p.direction === 'inbound';
      const user = await prisma.user.findFirst({ where: { phone: inbound ? p.to : p.from, status: 'active' } });
      // Only process the PSTN leg, not the SIP transfer leg.
      if (!user || (inbound && !/^\+\d+$/.test(p.to))) return res.json({ received: true });
      await prisma.callLog.upsert({ where: { callControlId: id }, update: {}, create: { callControlId: id, direction: inbound ? 'inbound' : 'outbound', fromNumber: p.from, toNumber: p.to, agentId: user.id, agentName: user.name, status: 'ringing' } });
      if (inbound && user.telnyxSipUsername) {
        await telnyxRequest(`calls/${encodeURIComponent(id)}/actions/answer`, 'POST', { command_id: `answer-${event.id}` });
      } else if (inbound) {
        await telnyxRequest(`calls/${encodeURIComponent(id)}/actions/hangup`, 'POST', { command_id: `offline-${event.id}` });
      }
    } else {
      const log = await prisma.callLog.findUnique({ where: { callControlId: id } });
      if (!log) return res.json({ received: true });
      if (event.event_type === 'call.answered') {
        if (log.direction === 'inbound' && log.status === 'ringing') {
          const agent = await prisma.user.findUnique({ where: { id: log.agentId } });
          if (agent?.telnyxSipUsername) await telnyxRequest(`calls/${encodeURIComponent(id)}/actions/transfer`, 'POST', { to: `sip:${agent.telnyxSipUsername}@sip.telnyx.com`, from: log.fromNumber, timeout_secs: 30, command_id: `route-${event.id}` });
        }
        await prisma.callLog.update({ where: { id: log.id }, data: { status: 'answered', answeredAt: new Date(event.occurred_at || Date.now()) } });
      } else if (event.event_type === 'call.hangup') {
        const endedAt = new Date(event.occurred_at || Date.now());
        const seconds = log.answeredAt ? Math.max(0, Math.round((endedAt - log.answeredAt) / 1000)) : 0;
        await prisma.callLog.update({ where: { id: log.id }, data: { status: 'completed', endedAt, durationSeconds: seconds } });
        io?.to(`agent:${log.agentId}`).emit('telnyx:call_ended', { callControlId: id, callLogId: log.id, durationSeconds: seconds });
      } else if (event.event_type === 'call.recording.saved') {
        const url = p.recording_urls?.mp3 || p.public_recording_urls?.mp3;
        if (url) await prisma.callLog.update({ where: { id: log.id }, data: { recordingUrl: url } });
      }
    }
    res.json({ received: true });
  } catch (error) { console.error('[Voice webhook]', error.message); res.status(503).json({ error: 'Event could not be processed' }); }
});

router.post('/webhooks/messaging', verifyWebhook, async (req, res) => {
  try {
    const event = req.body.data;
    const p = event?.payload;
    if (!p?.id) return res.status(400).json({ error: 'Invalid messaging event' });
    if (event.event_type === 'message.received') {
      const to = p.to?.[0]?.phone_number;
      const agent = await prisma.user.findFirst({ where: { phone: to, status: 'active' } });
      const data = { direction: 'inbound', fromNumber: p.from.phone_number, toNumber: to, text: p.text || '', status: 'received', agentId: agent?.id };
      const message = await prisma.sMSLog.upsert({ where: { telnyxMessageId: p.id }, update: {}, create: { ...data, telnyxMessageId: p.id } });
      if (agent) req.app.get('io')?.to(`agent:${agent.id}`).emit('telnyx:sms_received', message);
    } else if (event.event_type === 'message.finalized') {
      await prisma.sMSLog.updateMany({ where: { telnyxMessageId: p.id }, data: { status: p.to?.[0]?.status || 'unknown' } });
    }
    res.json({ received: true });
  } catch { res.status(503).json({ error: 'Message could not be saved' }); }
});
module.exports = router;
