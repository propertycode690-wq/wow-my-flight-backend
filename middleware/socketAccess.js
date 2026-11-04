const jwt = require('jsonwebtoken');
const { prisma } = require('../db');

function installSocketAccess(socket, chatStore) {
  socket.use(async (packet, next) => {
    const [event, payload = {}] = packet;
    const ack = packet.findLast(value => typeof value === 'function');
    const deny = error => { if (ack) ack({ success: false, error }); };
    const customerEvent = ['chat:customer_join', 'chat:customer_rejoin'].includes(event);
    if (customerEvent) return next();
    const publicMessage = ['chat:send_message', 'chat:typing', 'chat:mark_read'].includes(event) && !socket.data.user;
    if (publicMessage) {
      if (!socket.rooms.has(`chat_${payload.sessionId}`) || payload.type === 'note' || payload.senderType === 'agent' || payload.readerType === 'agent') return deny('Unauthorized chat access');
      payload.senderType = 'customer';
      payload.readerType = 'customer';
      return next();
    }
    try {
      const claims = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
      const user = await prisma.user.findUnique({ where: { id: claims.id }, select: { id: true, name: true, role: true, status: true } });
      if (!user || user.status !== 'active') return deny('Account unavailable');
      socket.data.user = user;
      if (payload && typeof payload === 'object') {
        payload.agentId = user.id;
        payload.agentName = user.name;
        payload.senderId = user.id;
        payload.senderName = user.name;
        payload.senderRole = user.role;
        if (event === 'chat:send_message') payload.senderType = 'agent';
      }
      if (payload.sessionId) {
        const session = chatStore.getSession(payload.sessionId);
        if (session?.agentId && session.agentId !== user.id && !['admin', 'super_admin'].includes(user.role)) return deny('Chat is assigned to another user');
      }
      if (event === 'team:send_message') {
        if (typeof payload.text !== 'string' || !payload.text.trim()) return deny('Message text is required');
        if (payload.channelId !== 'general-desk') {
          const recipient = await prisma.user.findUnique({ where: { id: payload.channelId || '' }, select: { id: true, status: true } });
          if (!recipient || recipient.status !== 'active') return deny('Recipient unavailable');
        }
      }
      next();
    } catch { deny('Authentication required'); }
  });
}
module.exports = { installSocketAccess };
