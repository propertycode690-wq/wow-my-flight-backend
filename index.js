/**
 * server/index.js
 * WowMyFlight CRM — Main Backend Server
 * 
 * Responsibilities:
 *   - Express HTTP server
 *   - Socket.io real-time events (incoming calls, call status, SMS)
 *   - CORS configured for React frontend
 *   - Telnyx routes mounted at /api/telnyx
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const telnyxRoutes = require('./routes/telnyx');
const traveloproRoutes = require('./routes/travelopro');
const bookingRoutes = require('./routes/bookings');
const webhookRoutes = require('./routes/webhooks');
const leadsRoutes = require('./routes/leads');
const quotesRoutes = require('./routes/quotes');
const clientsRoutes = require('./routes/clients');
const paymentsRoutes = require('./routes/payments');
const usersRoutes = require('./routes/users');
const consultationsRoutes = require('./routes/consultations');
const documentsRoutes = require('./routes/documents');
const notificationsRoutes = require('./routes/notifications');
// Phase 3 — Management Routes (API names matching sidebar menu names)
const teamLeaderDashboardRoutes = require('./routes/teamLeaderDashboard');
const qaRoutes = require('./routes/qa');
const slaManagementRoutes = require('./routes/slaManagement');
const automationRoutes = require('./routes/automation');
const financeRoutes = require('./routes/finance');
const managementReportsRoutes = require('./routes/managementReports');
const permissionControlRoutes = require('./routes/permissionControl');
const auditTrailRoutes = require('./routes/auditTrail');
const afterSalesRoutes = require('./routes/afterSales');
const settingsRoutes = require('./routes/settings');
const chatStore = require('./store/chatStore');
const { prisma, isDbConnected, checkConnection } = require('./db');

const app = express();
const server = http.createServer(app);

// ─────────────────────────────────────────────────────────────────────────────
// Socket.io Setup — Real-time events to frontend
// ─────────────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://wow-my-flight-1.netlify.app',
  process.env.FRONTEND_URL || 'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
];

const corsOriginHandler = (origin, callback) => {
  if (!origin) return callback(null, true);
  if (
    allowedOrigins.includes(origin) ||
    origin.endsWith('.netlify.app') ||
    origin.includes('localhost')
  ) {
    return callback(null, true);
  }
  return callback(null, true);
};

const io = new Server(server, {
  cors: {
    origin: corsOriginHandler,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Make io accessible in route handlers via req.app.get('io')
app.set('io', io);

// Track connected agents: socket.id -> { agentId, agentName, role, status }
const connectedAgents = new Map();
const SUPPORT_ROLES = ['consultant', 'sales_agent', 'agent', 'team_leader', 'expert_team_leader', 'admin', 'super_admin', 'operations', 'marketing', 'finance', 'flight_expert', 'ticketing_agent'];

io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  // --- AGENT REGISTRATION & AVAILABILITY ---
  socket.on('agent:register', ({ agentId, agentName, role, status = 'available' }) => {
    socket.join(`agent:${agentId}`);
    
    // Store agent connection and availability
    connectedAgents.set(socket.id, {
      agentId,
      agentName,
      role: role || 'agent',
      status: status || 'available',
    });

    const isAuthorized = !role || SUPPORT_ROLES.includes(role);
    const isAvailable = status !== 'offline' && status !== 'unavailable';

    if (isAuthorized && isAvailable) {
      socket.join('agents_group');
      console.log(`[Socket.io] Available support agent registered: ${agentName} (${agentId}, ${role || 'agent'})`);
    } else {
      socket.leave('agents_group');
      console.log(`[Socket.io] Agent registered (non-available or restricted): ${agentName} (${agentId})`);
    }
  });

  // Update agent availability status dynamically
  socket.on('agent:set_status', ({ status }) => {
    const agent = connectedAgents.get(socket.id);
    if (agent) {
      agent.status = status;
      const isAuthorized = !agent.role || SUPPORT_ROLES.includes(agent.role);
      if (isAuthorized && status === 'available') {
        socket.join('agents_group');
      } else {
        socket.leave('agents_group');
      }
    }
  });

  // --- LIVE CHAT LOGIC ---

  // 1. Customer initiates a chat
  socket.on('chat:customer_join', (customerDetails, callback) => {
    const session = chatStore.createSession(customerDetails);
    socket.join(`chat_${session.id}`); // Customer joins their own chat room
    console.log(`[Socket.io] Chat session created: ${session.id}`);
    
    // Minimal incoming request payload (no private messages/sensitive data exposed)
    const incomingNotification = {
      chatRequestId: session.id,
      customerName: session.customerName || 'Website Visitor',
      requestTime: session.createdAt,
    };

    // Notify all currently available and authorized support agents
    io.to('agents_group').emit('chat:incoming_request', incomingNotification);
    
    // Maintain backwards compatibility with existing workspace list
    io.to('agents_group').emit('chat:new_session', session);

    // Persist real-time alert into notification system for Bell icon popover
    if (notificationsRoutes && typeof notificationsRoutes.addNotification === 'function') {
      notificationsRoutes.addNotification({
        id: `chat-${session.id}`,
        sessionId: session.id,
        title: 'Incoming Website Chat',
        message: `${session.customerName || 'Website Visitor'} initiated a live chat inquiry.`,
        type: 'chat',
        read: false,
        link: '/live-chat',
        createdAt: session.createdAt,
      });
    }
    
    if (callback) callback({ sessionId: session.id });
  });

  // 1.5 Customer rejoins a chat after refresh (strictly exclude internal staff notes)
  socket.on('chat:customer_rejoin', ({ sessionId }, callback) => {
    const session = chatStore.getSession(sessionId);
    if (session) {
      socket.join(`chat_${sessionId}`);
      const messages = chatStore.getMessagesForSession(sessionId, false);
      if (callback) callback({ success: true, session, messages });
    } else {
      if (callback) callback({ success: false, error: 'Session not found' });
    }
  });

  // 1.8 Accept incoming chat request (Atomic single-agent assignment)
  socket.on('chat:accept_request', ({ sessionId, agentId, agentName }, callback) => {
    if (!sessionId || !agentId) {
      if (callback) callback({ success: false, reason: 'INVALID_PARAMS', message: 'Session ID and Agent ID required.' });
      return;
    }

    const claimResult = chatStore.claimSession(sessionId, agentId);
    if (!claimResult.success) {
      // Chat already claimed by another agent or not active
      if (callback) callback(claimResult);
      return;
    }

    // Single winning agent joins the customer's chat room
    socket.join(`chat_${sessionId}`);
    
    // Notify customer in the room that this agent has joined
    io.to(`chat_${sessionId}`).emit('chat:agent_joined', { agentId, agentName });

    // Notify ALL other agents that this request is claimed so their notification dismisses
    io.to('agents_group').emit('chat:request_claimed', {
      chatRequestId: sessionId,
      assignedAgentId: agentId,
      assignedAgentName: agentName,
    });

    // Broadcast updated session state to agent workspaces
    io.to('agents_group').emit('chat:session_updated', claimResult.session);

    const messages = chatStore.getMessagesForSession(sessionId);
    if (callback) callback({ success: true, session: claimResult.session, messages });
  });

  // 2. Customer or Agent sends a message
  socket.on('chat:send_message', (messageData, callback) => {
    const { sessionId, senderType, senderId, senderName, text, type, attachment } = messageData;
    const session = chatStore.getSession(sessionId);

    // Authorization check: if an agent sends a message, verify they are the assigned agent (or chat is unassigned)
    if (senderType === 'agent' && session) {
      if (session.agentId && session.agentId !== senderId) {
        if (callback) callback({ success: false, error: 'Unauthorized: Chat is assigned to another agent.' });
        return;
      }
      if (!session.agentId) {
        // Automatically claim if sending first message
        chatStore.claimSession(sessionId, senderId);
      }
    }

    const msg = chatStore.addMessage({ sessionId, senderType, senderId, senderName, text, type, attachment });
    
    if (msg) {
      if (msg.type === 'note') {
        // Internal team note: strictly route ONLY to authorized staff (agents_group)
        // NEVER broadcast internal notes to customer socket in chat_${sessionId}
        io.to('agents_group').emit('chat:receive_message', msg);
      } else {
        // Public message: Send to the chat room for customer and agent
        io.to(`chat_${sessionId}`).emit('chat:receive_message', msg);
      }
      
      // Update session activity for agent's list
      io.to('agents_group').emit('chat:session_updated', chatStore.getSessionWithStats(sessionId));
      
      if (callback) callback({ success: true, message: msg });
    } else {
      if (callback) callback({ success: false, error: 'Session not found' });
    }
  });

  // 3. Typing indicator
  socket.on('chat:typing', ({ sessionId, isTyping, senderType, senderName }) => {
    // Broadcast to everyone in the room except the sender
    socket.to(`chat_${sessionId}`).emit('chat:typing_status', { sessionId, isTyping, senderType, senderName });
    // Also notify agents group so the sidebar can show typing indicator
    io.to('agents_group').emit('chat:session_typing', { sessionId, isTyping, senderType });
  });

  // 3.5 Mark messages as read
  socket.on('chat:mark_read', ({ sessionId, readerType }) => {
    const updated = chatStore.markMessagesAsRead(sessionId, readerType);
    if (updated) {
      // Broadcast back to the room so the sender can see the read ticks
      io.to(`chat_${sessionId}`).emit('chat:messages_read', { sessionId, readerType });
      // Notify agents group of updated session stats (unreadCount: 0)
      const updatedSession = chatStore.getSessionWithStats(sessionId);
      if (updatedSession) {
        io.to('agents_group').emit('chat:session_updated', updatedSession);
      }
    }
  });

  // 4. Agent joins a specific customer's chat room to reply
  socket.on('chat:agent_join_room', ({ sessionId, agentId }, callback) => {
    const session = chatStore.getSession(sessionId);
    if (!session) {
      if (callback) callback({ success: false, error: 'Session not found' });
      return;
    }

    // If chat is already assigned to another agent, prevent unauthorized joining
    if (session.agentId && session.agentId !== agentId) {
      if (callback) callback({
        success: false,
        reason: 'ALREADY_ASSIGNED',
        assignedAgentId: session.agentId,
        message: 'This chat is already assigned to another agent.'
      });
      return;
    }

    // Atomically claim session if unassigned
    if (!session.agentId) {
      const claimResult = chatStore.claimSession(sessionId, agentId);
      if (!claimResult.success) {
        if (callback) callback(claimResult);
        return;
      }
      io.to('agents_group').emit('chat:request_claimed', {
        chatRequestId: sessionId,
        assignedAgentId: agentId,
      });
    }

    socket.join(`chat_${sessionId}`);
    
    // Send previous messages to the agent
    const messages = chatStore.getMessagesForSession(sessionId);
    
    // Notify room that agent has joined
    io.to(`chat_${sessionId}`).emit('chat:agent_joined', { agentId });
    io.to('agents_group').emit('chat:session_updated', chatStore.getSessionWithStats(sessionId));

    if (callback) callback({ success: true, messages, session: chatStore.getSessionWithStats(sessionId) });
  });

  // 4.5 Get active sessions (requested by agent dashboard on mount)
  socket.on('chat:get_active_sessions', (data, callback) => {
    const sessions = chatStore.getAllSessions();
    if (typeof callback === 'function') {
      callback(sessions);
    } else if (typeof data === 'function') {
      data(sessions);
    }
  });

  // 5. Resolve a chat session
  socket.on('chat:resolve_session', ({ sessionId }, callback) => {
    const session = chatStore.resolveSession(sessionId);
    if (session) {
      io.to('agents_group').emit('chat:session_updated', session);
      if (callback) callback({ success: true, session });
    }
  });

  // 6. Transfer Chat (Unassign)
  socket.on('chat:transfer_session', ({ sessionId }, callback) => {
    const session = chatStore.unassignSession(sessionId);
    if (session) {
      io.to('agents_group').emit('chat:session_updated', session);
      if (callback) callback({ success: true, session });
    }
  });

  // 7. Block User
  socket.on('chat:block_session', ({ sessionId }, callback) => {
    const session = chatStore.blockSession(sessionId);
    if (session) {
      io.to('agents_group').emit('chat:session_updated', session);
      // Disconnect the customer socket from the room if needed
      io.to(`chat_${sessionId}`).emit('chat:blocked');
      if (callback) callback({ success: true, session });
    }
  });

  // 8. ─── INTERNAL TEAM CHAT (STAFF ONLY) ──────────────────────────────────
  socket.on('team:get_messages', ({ channelId }, callback) => {
    const msgs = chatStore.getTeamMessages(channelId);
    if (typeof callback === 'function') {
      callback({ success: true, messages: msgs });
    }
  });

  socket.on('team:send_message', (msgData, callback) => {
    const newMsg = chatStore.addTeamMessage(msgData);
    if (newMsg) {
      // Broadcast strictly to agents_group (customers never in this room)
      io.to('agents_group').emit('team:receive_message', newMsg);
      if (typeof callback === 'function') {
        callback({ success: true, message: newMsg });
      }
    } else {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Could not send team message' });
      }
    }
  });

  socket.on('disconnect', () => {
    connectedAgents.delete(socket.id);
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: corsOriginHandler,
  credentials: true,
}));

// Parse JSON — with 50mb limit for travel document file uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ─────────────────────────────────────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const dbLive = await checkConnection();
  res.json({
    status: 'ok',
    service: 'WowMyFlight CRM Backend',
    timestamp: new Date().toISOString(),
    database: {
      connected: dbLive,
      provider: 'PostgreSQL (Prisma)'
    },
    telnyx: {
      configured: !!process.env.TELNYX_API_KEY,
      connectionId: process.env.TELNYX_CONNECTION_ID,
      defaultNumber: process.env.TELNYX_DEFAULT_FROM_NUMBER,
    },
    travelopro: {
      configured: !!(process.env.TRAVELOPRO_USER_ID && process.env.TRAVELOPRO_PASSWORD),
      userId: process.env.TRAVELOPRO_USER_ID,
      apiBase: process.env.TRAVELOPRO_API_BASE,
      access: process.env.TRAVELOPRO_ACCESS || 'Test',
    },
    webhooks: {
      configured: true,
      ingestEndpoint: '/api/webhooks/website-leads',
      pollingEndpoint: '/api/webhooks/leads',
      authHeader: 'x-crm-api-key',
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/telnyx', telnyxRoutes);
app.use('/api/travelopro', traveloproRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/quotes', quotesRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/agents', usersRoutes);
app.use('/api/auth', usersRoutes);
app.use('/api/consultations', consultationsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/notifications', notificationsRoutes);

// Phase 3 — Management API Routes (Exact match to sidebar menu names)
app.use('/api/team-leader-dashboard', teamLeaderDashboardRoutes);
app.use('/api/team_leader_dashboard', teamLeaderDashboardRoutes);
app.use('/api/qa', qaRoutes);
app.use('/api/sla-management', slaManagementRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/management-reports', managementReportsRoutes);
app.use('/api/permission-control', permissionControlRoutes);
app.use('/api/permission-management', permissionControlRoutes);
app.use('/api/audit-trail', auditTrailRoutes);
app.use('/api/after-sales', afterSalesRoutes);
app.use('/api/after_sales', afterSalesRoutes);
app.use('/api/settings', settingsRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// 404 Handler
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ─────────────────────────────────────────────────────────────────────────────
// Global Error Handler
// ─────────────────────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   WowMyFlight Backend Server — LIVE   ║');
  console.log(`╠════════════════════════════════════════╣`);
  console.log(`║  URL:    http://localhost:${PORT}          ║`);
  console.log(`║  Health: http://localhost:${PORT}/health   ║`);
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Telnyx API Key: ${process.env.TELNYX_API_KEY ? '✓ Loaded' : '✗ MISSING!'}           ║`);
  console.log(`║  Default Number: ${process.env.TELNYX_DEFAULT_FROM_NUMBER} ║`);
  console.log('╚════════════════════════════════════════╝\n');
});
