const express = require('express');
const { prisma } = require('../db');
const router = express.Router();
const admin = req => ['super_admin', 'admin'].includes(req.user.role);
const scope = req => admin(req) ? {} : { userId: req.user.id };
const safe = fn => (req, res) => Promise.resolve(fn(req, res)).catch(() => res.status(503).json({ success: false, error: 'Notification request failed' }));

async function addNotification(item) {
  const data = { title: item.title, message: item.message, type: item.type || 'system', link: item.link || null, userId: item.userId || null, read: false };
  if (item.id) return prisma.notification.upsert({ where: { id: item.id }, create: { id: item.id, ...data }, update: {} });
  return prisma.notification.create({ data });
}

async function syncEvents() {
  const [leads, bookings, documents, payments] = await Promise.all([
    prisma.lead.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.booking.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.document.findMany({ orderBy: { uploadedAt: 'desc' }, take: 20 }),
    prisma.payment.findMany({ where: { status: { in: ['Paid', 'Completed', 'Payment Confirmed'] } }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  const events = [
    ...leads.map(l => ({ id: `lead-${l.id}`, title: 'Lead recorded', message: `${l.firstName} ${l.lastName || ''}`, userId: l.assignedAgentId, type: 'lead', link: '/leads' })),
    ...bookings.map(b => ({ id: `booking-${b.id}`, title: 'Booking recorded', message: `${b.passenger}: ${b.pnr} (${b.ticketStatus})`, userId: b.agentId, type: 'booking', link: '/bookings' })),
    ...documents.map(d => ({ id: `document-${d.id}`, title: 'Document recorded', message: `${d.customerName}: ${d.fileName}`, userId: d.agentId, type: 'document', link: '/qa' })),
    ...payments.map(p => ({ id: `payment-${p.id}`, title: 'Payment marked paid', message: `${p.customerName}: ${p.currency} ${p.amount}`, userId: p.agentId, type: 'payment', link: '/payments' })),
  ];
  await Promise.all(events.map(addNotification));
}

router.get('/', safe(async (req, res) => {
  await syncEvents();
  const where = scope(req);
  if (req.query.type && req.query.type !== 'all') where.type = req.query.type;
  const data = await prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 60 });
  res.json({ success: true, data, unreadCount: data.filter(n => !n.read).length });
}));
router.post('/', safe(async (req, res) => {
  if (!admin(req)) return res.status(403).json({ success: false, error: 'Administrator access required' });
  if (!req.body.title || !req.body.message) return res.status(400).json({ success: false, error: 'Title and message are required' });
  res.status(201).json({ success: true, data: await addNotification(req.body) });
}));
router.post('/mark-all-read', safe(async (req, res) => {
  const result = await prisma.notification.updateMany({ where: { ...scope(req), read: false }, data: { read: true } });
  res.json({ success: true, count: result.count });
}));
router.patch('/:id/read', safe(async (req, res) => {
  const result = await prisma.notification.updateMany({ where: { id: req.params.id, ...scope(req) }, data: { read: true } });
  if (!result.count) return res.status(404).json({ success: false, error: 'Notification not found' });
  res.json({ success: true, data: { id: req.params.id, read: true } });
}));
router.delete('/:id', safe(async (req, res) => {
  const result = await prisma.notification.deleteMany({ where: { id: req.params.id, ...scope(req) } });
  if (!result.count) return res.status(404).json({ success: false, error: 'Notification not found' });
  res.json({ success: true });
}));
router.addNotification = item => addNotification(item).catch(() => null);
module.exports = router;
