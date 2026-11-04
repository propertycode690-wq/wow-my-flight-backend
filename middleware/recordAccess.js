const { prisma } = require('../db');

function recordAccess(model, ownerField = 'agentId', aliases = [], reserved = []) {
  return async (req, res, next) => {
    try {
      if (!prisma) return res.status(503).json({ success: false, error: 'Database unavailable' });
      const sales = req.user?.role === 'sales_executive';
      const parts = req.path.split('/').filter(Boolean);
      const id = parts[0];
      if (reserved.includes(id)) {
        if (sales && req.method !== 'GET') return res.status(403).json({ success: false, error: 'Administrator access required' });
        return next();
      }
      if (sales) req.query[ownerField] = req.user.id;
      if (id) {
        const where = aliases.length ? { OR: [{ id }, ...aliases.map(key => ({ [key]: id }))] } : { id };
        const existing = await prisma[model].findFirst({ where });
        if (!existing) return res.status(404).json({ success: false, error: 'Record not found' });
        if (sales && existing[ownerField] !== req.user.id) return res.status(403).json({ success: false, error: 'This record is assigned to another user' });
        req.record = existing;
        if (sales && ((parts[1] === 'assign') || (req.body?.[ownerField] !== undefined && req.body[ownerField] !== req.user.id))) {
          return res.status(403).json({ success: false, error: 'Only administrators can reassign records' });
        }
      } else if (req.method === 'POST') {
        req.body ||= {};
        if (req.body.id && await prisma[model].findUnique({ where: { id: req.body.id } })) return res.status(409).json({ success: false, error: 'Record ID already exists' });
        req.body[ownerField] = sales ? req.user.id : (req.body[ownerField] || req.user.id);
      }
      if (sales && !['GET', 'HEAD', 'DELETE'].includes(req.method)) {
        for (const [field, related, owner] of [['clientId', 'client', 'agentId'], ['leadId', 'lead', 'assignedAgentId']]) {
          if (!req.body?.[field]) continue;
          const linked = await prisma[related].findUnique({ where: { id: req.body[field] } });
          if (!linked || linked[owner] !== req.user.id) return res.status(403).json({ success: false, error: 'Related record is not assigned to you' });
        }
      }
      return next();
    } catch {
      return res.status(503).json({ success: false, error: 'Could not verify record access' });
    }
  };
}

function scopedIo(req) {
  const io = req.app.get('io');
  if (!io) return null;
  const emitter = {
    to() { return emitter; },
    emit(event, data) {
      const owner = data?.assignedAgentId || data?.agentId || req.record?.assignedAgentId || req.record?.agentId || req.body?.assignedAgentId || req.body?.agentId || req.user?.id;
      io.to(['crm:admins', ...(owner ? [`agent:${owner}`] : [])]).emit(event, data);
    },
  };
  return emitter;
}

module.exports = { recordAccess, scopedIo };
