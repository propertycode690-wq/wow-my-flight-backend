/**
 * callStore.js
 * In-memory store + Prisma PostgreSQL persistence for Call Logs, Dispositions, and Active Calls.
 * Resilient design: fast in-memory operations with asynchronous database synchronization.
 */

const { v4: uuidv4 } = require('uuid');
const { prisma, isDbConnected } = require('../db');

// Active calls map: callControlId -> call object
const activeCalls = new Map();

// In-memory call logs cache
const callLogs = [];

// Call dispositions cache
const dispositions = [];

/**
 * Create a new call log entry when a call is initiated
 */
function createCallLog({ callControlId, direction, fromNumber, toNumber, agentId, agentName }) {
  const log = {
    id: uuidv4(),
    callControlId,
    direction: direction || 'outbound',
    fromNumber,
    toNumber,
    agentId: agentId || null,
    agentName: agentName || 'Agent',
    status: 'initiated',
    startedAt: new Date().toISOString(),
    answeredAt: null,
    endedAt: null,
    durationSeconds: 0,
    recordingUrl: null,
    disposition: null,
    notes: '',
    createdAt: new Date().toISOString(),
  };

  callLogs.push(log);
  if (callControlId) {
    activeCalls.set(callControlId, log);
  }

  // Asynchronously persist to PostgreSQL
  if (prisma) {
    prisma.callLog.upsert({
      where: { callControlId: callControlId || log.id },
      update: {
        status: log.status,
        durationSeconds: log.durationSeconds,
      },
      create: {
        id: log.id,
        callControlId: log.callControlId,
        direction: log.direction,
        fromNumber: log.fromNumber,
        toNumber: log.toNumber,
        agentId: log.agentId,
        agentName: log.agentName,
        status: log.status,
        startedAt: new Date(log.startedAt),
        durationSeconds: log.durationSeconds,
      },
    }).catch((err) => {
      console.warn('[PostgreSQL] Async callLog create warning:', err.message);
    });
  }

  return log;
}

/**
 * Update an existing call log by callControlId
 */
function updateCallLog(callControlId, updates) {
  const log = callLogs.find((l) => l.callControlId === callControlId);
  if (log) {
    Object.assign(log, updates);
    if (activeCalls.has(callControlId)) {
      activeCalls.set(callControlId, log);
    }

    // Asynchronously update in PostgreSQL
    if (prisma && callControlId) {
      const dbUpdates = {};
      if (updates.status) dbUpdates.status = updates.status;
      if (updates.answeredAt) dbUpdates.answeredAt = new Date(updates.answeredAt);
      if (updates.endedAt) dbUpdates.endedAt = new Date(updates.endedAt);
      if (updates.durationSeconds !== undefined) dbUpdates.durationSeconds = updates.durationSeconds;
      if (updates.recordingUrl) dbUpdates.recordingUrl = updates.recordingUrl;
      if (updates.disposition) dbUpdates.disposition = updates.disposition;
      if (updates.notes !== undefined) dbUpdates.notes = updates.notes;

      prisma.callLog.updateMany({
        where: { callControlId },
        data: dbUpdates,
      }).catch((err) => {
        console.warn('[PostgreSQL] Async callLog update warning:', err.message);
      });
    }
  }
  return log;
}

/**
 * Mark a call as answered
 */
function markCallAnswered(callControlId) {
  return updateCallLog(callControlId, {
    status: 'answered',
    answeredAt: new Date().toISOString(),
  });
}

/**
 * Mark a call as ended and calculate duration
 */
function markCallEnded(callControlId) {
  const log = callLogs.find((l) => l.callControlId === callControlId);
  if (log) {
    const endedAt = new Date().toISOString();
    const startTime = new Date(log.answeredAt || log.startedAt);
    const durationSeconds = Math.max(0, Math.floor((new Date(endedAt) - startTime) / 1000));
    updateCallLog(callControlId, {
      status: 'completed',
      endedAt,
      durationSeconds,
    });
    activeCalls.delete(callControlId);
  }
  return log;
}

/**
 * Save recording URL against a call
 */
function saveRecording(callControlId, recordingUrl) {
  return updateCallLog(callControlId, { recordingUrl });
}

/**
 * Save a call disposition after the call ends
 */
function saveDisposition({ callId, callControlId, agentId, disposition, notes }) {
  const entry = {
    id: uuidv4(),
    callId,
    callControlId,
    agentId,
    disposition,
    notes: notes || '',
    createdAt: new Date().toISOString(),
  };
  dispositions.push(entry);

  // Update memory log
  const log = callLogs.find((l) => l.id === callId || l.callControlId === (callControlId || callId));
  if (log) {
    updateCallLog(log.callControlId, { disposition, notes });
  }

  // Persist to PostgreSQL
  if (prisma) {
    prisma.callDisposition.create({
      data: {
        id: entry.id,
        callId: log?.id || callId,
        callControlId: callControlId || log?.callControlId || null,
        agentId: agentId || null,
        disposition,
        notes: notes || '',
        createdAt: new Date(entry.createdAt),
      },
    }).catch((err) => {
      console.warn('[PostgreSQL] Async disposition save warning:', err.message);
    });
  }

  return entry;
}

/**
 * Get all call logs (newest first), optionally filtered by agentId
 */
function getCallLogs({ agentId, limit = 50 } = {}) {
  let logs = [...callLogs].reverse();
  if (agentId) {
    logs = logs.filter((l) => l.agentId === agentId);
  }
  return logs.slice(0, limit);
}

/**
 * Get a single call log by callControlId
 */
function getCallByControlId(callControlId) {
  return callLogs.find((l) => l.callControlId === callControlId);
}

/**
 * Get currently active call for a given agent
 */
function getActiveCall(agentId) {
  for (const call of activeCalls.values()) {
    if (call.agentId === agentId) return call;
  }
  return null;
}

function deleteCallLog(idOrControlId) {
  if (!idOrControlId) return false;
  const target = String(idOrControlId);

  // Remove from in-memory callLogs
  for (let i = callLogs.length - 1; i >= 0; i--) {
    const l = callLogs[i];
    if (String(l.id) === target || String(l.callControlId) === target) {
      callLogs.splice(i, 1);
    }
  }

  // Remove from activeCalls
  if (activeCalls.has(target)) {
    activeCalls.delete(target);
  }

  // Remove from PostgreSQL
  if (prisma) {
    prisma.callLog.deleteMany({
      where: {
        OR: [
          { id: target },
          { callControlId: target }
        ]
      }
    }).catch((err) => {
      console.warn('[PostgreSQL] Async callLog delete warning:', err.message);
    });
  }

  return true;
}

module.exports = {
  createCallLog,
  updateCallLog,
  markCallAnswered,
  markCallEnded,
  saveRecording,
  saveDisposition,
  getCallLogs,
  getCallByControlId,
  getActiveCall,
  deleteCallLog,
  activeCalls,
};
