/**
 * server/routes/webhooks.js
 * WowMyFlight CRM — External Website Leads Ingestion & Polling Webhook API
 * 
 * Environments & Isolation:
 *   - PRODUCTION:
 *       POST /api/webhooks/website-leads       (Live leads into CRM pipeline & PostgreSQL)
 *       GET  /api/webhooks/leads               (Polling fallback for live leads)
 *       Auth: x-crm-api-key: wmf_live_sec_...
 * 
 *   - TEST / SANDBOX:
 *       POST /api/webhooks/test/website-leads  (100% isolated test sandbox, zero live pipeline pollution)
 *       GET  /api/webhooks/test/leads          (Polling fallback for test leads)
 *       Auth: x-crm-api-key: wmf_test_sec_...
 */

const express = require('express');
const router = express.Router();
const leadStore = require('../store/leadStore');

const DEFAULT_PROD_KEY = 'wmf_live_sec_8f9a2b4c1e7d0356ae829c417bfa0092d6e3c1a89b74ef201';
const DEFAULT_TEST_KEY = 'wmf_test_sec_3b7d19ef8a42c019d854e76a029c118f6e2b4a5d992100';

/**
 * Authentication Middleware Factory
 * @param {'production' | 'test'} envType
 */
function createAuthMiddleware(envType = 'production') {
  return function verifyWebhookAuth(req, res, next) {
    const isTest = envType === 'test';
    const prodKey = process.env.CRM_WEBHOOK_PROD_API_KEY || process.env.CRM_WEBHOOK_API_KEY || DEFAULT_PROD_KEY;
    const testKey = process.env.CRM_WEBHOOK_TEST_API_KEY || DEFAULT_TEST_KEY;
    const expectedKey = isTest ? testKey : prodKey;

    const providedKey = req.headers['x-crm-api-key'] || req.headers['x-api-key'] ||
      (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].split(' ')[1] : null);

    if (providedKey && providedKey === expectedKey) {
      req.webhookEnv = isTest ? 'SANDBOX' : 'PRODUCTION';
      return next();
    }

    // Also allow test key on test endpoint if test key matches
    if (isTest && providedKey === prodKey) {
      // If they accidentally used prod key on test endpoint, warn but allow with sandbox context
      req.webhookEnv = 'SANDBOX';
      return next();
    }

    console.warn(`🔒 [Webhook] Unauthorized attempt on ${isTest ? 'TEST' : 'PROD'} endpoint from IP: ${req.ip}`);
    return res.status(401).json({
      success: false,
      error: `Unauthorized: Invalid or missing API key for ${isTest ? 'Test' : 'Production'} environment. Please supply header "x-crm-api-key".`,
      expectedHeader: 'x-crm-api-key',
    });
  };
}

/**
 * Helper to process inbound leads
 */
async function processInboundLeads(req, res, { isSandbox = false }) {
  const payload = req.body;

  if (!payload) {
    return res.status(400).json({
      success: false,
      error: 'Bad Request: Missing request body',
    });
  }

  // Support single lead object, data object, or data array
  let leadsToProcess = [];
  if (Array.isArray(payload.data)) {
    leadsToProcess = payload.data;
  } else if (payload.data && typeof payload.data === 'object') {
    leadsToProcess = [payload.data];
  } else if (payload.leadId || payload.phoneNumber || payload.name) {
    leadsToProcess = [payload];
  }

  if (leadsToProcess.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Bad Request: No valid lead object found in "data" array or body',
    });
  }

  const io = req.app.get('io');
  const results = [];

  for (const rawItem of leadsToProcess) {
    if (!rawItem.phoneNumber && !rawItem.leadId && !rawItem.phone) {
      results.push({
        success: false,
        error: 'Missing required field: phoneNumber or leadId is required',
      });
      continue;
    }

    // Process lead in store with sandbox isolation flag
    const outcome = leadStore.ingestLead(rawItem, { isSandbox });
    results.push({
      success: true,
      action: outcome.action,
      leadId: rawItem.leadId || outcome.lead.websiteLeadId,
      crmLeadId: outcome.lead.id,
      isDuplicate: outcome.isDuplicate,
      isReturning: outcome.isReturning,
      isNew: outcome.isNew,
      environment: isSandbox ? 'SANDBOX' : 'PRODUCTION',
    });

    // Broadcast real-time Socket.IO event ONLY for production leads
    // (Never spam sales desk with dummy test sandbox leads!)
    if (io && !isSandbox) {
      if (outcome.action === 'CREATED') {
        console.log(`📢 [Socket.io] Broadcasting NEW lead alert: ${outcome.lead.name}`);
        io.to('agents_group').emit('lead:new', {
          lead: outcome.lead,
          message: `New flight inquiry from ${outcome.lead.name} (${outcome.lead.origin || ''} ➔ ${outcome.lead.destination || ''})`,
          timestamp: new Date().toISOString(),
        });
        io.emit('lead:new', outcome.lead);
      } else if (outcome.action === 'UPDATED') {
        console.log(`📢 [Socket.io] Broadcasting RETURNING customer alert: ${outcome.lead.name}`);
        io.to('agents_group').emit('lead:updated', {
          lead: outcome.lead,
          message: `Returning customer inquiry: ${outcome.lead.name} submitted a new flight request`,
          timestamp: new Date().toISOString(),
        });
        io.emit('lead:updated', outcome.lead);
      }
    }
  }

  const primary = results[0];
  const statusCode = primary.isNew ? 201 : 200;

  return res.status(statusCode).json({
    success: true,
    status: 'PROCESSED',
    environment: isSandbox ? 'SANDBOX' : 'PRODUCTION',
    action: primary.action,
    leadId: primary.leadId,
    crmLeadId: primary.crmLeadId,
    processedCount: results.length,
    details: results,
    message: isSandbox
      ? 'Test lead received and processed in isolated Sandbox environment (Production untouched).'
      : primary.isDuplicate
      ? 'Duplicate lead received; acknowledged idempotently without duplication.'
      : primary.isReturning
      ? 'Returning customer updated; new flight request logged and pipeline bumped to New Lead.'
      : 'New lead successfully created in WowMyFlight CRM pipeline.',
    timestamp: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Handshake & Health Checks
// ─────────────────────────────────────────────────────────────────────────────
router.get('/website-leads', (req, res) => {
  res.json({
    status: 'ACTIVE',
    service: 'WowMyFlight CRM Website Leads Ingestion Webhook',
    environment: 'PRODUCTION',
    method: 'POST',
    acceptedContentType: 'application/json',
    authHeader: 'x-crm-api-key',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

router.get('/test/website-leads', (req, res) => {
  res.json({
    status: 'ACTIVE',
    service: 'WowMyFlight CRM Website Leads Ingestion Webhook (Isolated Sandbox)',
    environment: 'SANDBOX',
    method: 'POST',
    acceptedContentType: 'application/json',
    authHeader: 'x-crm-api-key',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Production Lead Ingestion
// POST /api/webhooks/website-leads
// ─────────────────────────────────────────────────────────────────────────────
router.post('/website-leads', createAuthMiddleware('production'), async (req, res) => {
  return processInboundLeads(req, res, { isSandbox: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Isolated Test/Sandbox Lead Ingestion (Guaranteed 0% pollution of live data)
// POST /api/webhooks/test/website-leads
// ─────────────────────────────────────────────────────────────────────────────
router.post('/test/website-leads', createAuthMiddleware('test'), async (req, res) => {
  return processInboundLeads(req, res, { isSandbox: true });
});

// Alias for convenience: /api/webhooks/sandbox/website-leads
router.post('/sandbox/website-leads', createAuthMiddleware('test'), async (req, res) => {
  return processInboundLeads(req, res, { isSandbox: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Fallback Polling Endpoints: Leads Fetch
// ─────────────────────────────────────────────────────────────────────────────
// Production Polling
router.get('/leads', createAuthMiddleware('production'), (req, res) => {
  try {
    const { since, limit = 50, offset = 0, status } = req.query;
    const result = leadStore.getLeads({
      since,
      limit: Math.min(Number(limit) || 50, 100),
      offset: Number(offset) || 0,
      status,
      isSandbox: false,
    });

    return res.json({
      success: true,
      environment: 'PRODUCTION',
      count: result.data.length,
      total: result.total,
      pagination: {
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
        nextSince: result.nextSince,
      },
      data: result.data,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('❌ [Webhook Polling Error]', err);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error while fetching leads',
      message: err.message,
    });
  }
});

// Sandbox Test Polling
router.get('/test/leads', createAuthMiddleware('test'), (req, res) => {
  try {
    const { since, limit = 50, offset = 0, status } = req.query;
    const result = leadStore.getLeads({
      since,
      limit: Math.min(Number(limit) || 50, 100),
      offset: Number(offset) || 0,
      status,
      isSandbox: true,
    });

    return res.json({
      success: true,
      environment: 'SANDBOX',
      count: result.data.length,
      total: result.total,
      pagination: {
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
        nextSince: result.nextSince,
      },
      data: result.data,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('❌ [Webhook Polling Error]', err);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error while fetching test leads',
      message: err.message,
    });
  }
});

module.exports = router;
