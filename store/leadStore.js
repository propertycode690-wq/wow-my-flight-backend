/**
 * server/store/leadStore.js
 * WowMyFlight CRM — Enterprise In-Memory + Prisma PostgreSQL Store for Leads
 * 
 * Responsibilities:
 *   - Idempotent lead ingestion (safe against webhook retries & duplicates)
 *   - Returning customer detection (by phone number or lead ID)
 *   - Automatic pipeline status bump on new flight request
 *   - Resilient persistence (In-memory + local file cache + async PostgreSQL sync)
 *   - Polling / Fetch API support with ISO date filtering
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { prisma, isDbConnected } = require('../db');

const CACHE_FILE = path.join(__dirname, 'leads_data.json');
const SANDBOX_CACHE_FILE = path.join(__dirname, 'sandbox_leads_data.json');

// ── Production Memory Storage ──
const leadsById = new Map();
const phoneIndex = new Map();
const websiteIdIndex = new Map();

// ── Isolated Test/Sandbox Memory Storage (100% separate from live pipeline) ──
const sandboxLeads = new Map();
const sandboxPhoneIndex = new Map();
const sandboxWebsiteIdIndex = new Map();

/**
 * Clean & normalize phone number for consistent matching
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.toString().replace(/[\s\-\(\)\.]/g, '').trim();
}

/**
 * Load persisted leads from local JSON cache on boot
 */
function loadFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        data.forEach((lead) => {
          leadsById.set(lead.id, lead);
          if (lead.phone) phoneIndex.set(normalizePhone(lead.phone), lead.id);
          if (lead.websiteLeadId) websiteIdIndex.set(lead.websiteLeadId, lead.id);
        });
        console.log(`📁 [LeadStore] Loaded ${data.length} cached live leads from disk.`);
      }
    }
    if (fs.existsSync(SANDBOX_CACHE_FILE)) {
      const rawSb = fs.readFileSync(SANDBOX_CACHE_FILE, 'utf-8');
      const dataSb = JSON.parse(rawSb);
      if (Array.isArray(dataSb)) {
        dataSb.forEach((lead) => {
          sandboxLeads.set(lead.id, lead);
          if (lead.phone) sandboxPhoneIndex.set(normalizePhone(lead.phone), lead.id);
          if (lead.websiteLeadId) sandboxWebsiteIdIndex.set(lead.websiteLeadId, lead.id);
        });
        console.log(`📁 [LeadStore] Loaded ${dataSb.length} cached sandbox test leads.`);
      }
    }
  } catch (err) {
    console.warn('⚠️ [LeadStore] Failed to read cached leads from disk:', err.message);
  }
}

/**
 * Save leads snapshot to disk asynchronously
 */
function saveToDisk(isSandbox = false) {
  try {
    if (isSandbox) {
      const list = Array.from(sandboxLeads.values());
      fs.writeFileSync(SANDBOX_CACHE_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } else {
      const list = Array.from(leadsById.values());
      fs.writeFileSync(CACHE_FILE, JSON.stringify(list, null, 2), 'utf-8');
    }
  } catch (err) {
    console.warn('⚠️ [LeadStore] Failed to save leads snapshot to disk:', err.message);
  }
}

// Initialize on require
loadFromDisk();

/**
 * Sync lead asynchronously to PostgreSQL via Prisma
 */
async function syncToPostgres(lead) {
  if (!prisma) return;
  try {
    const splitName = (lead.name || `${lead.firstName || ''} ${lead.lastName || ''}`).trim();
    const parts = splitName.split(' ');
    const firstName = lead.firstName || parts[0] || 'Customer';
    const lastName = lead.lastName || (parts.slice(1).join(' ') || null);

    // Upsert into PostgreSQL leads table
    await prisma.lead.upsert({
      where: { id: lead.id },
      update: {
        firstName,
        lastName,
        email: lead.email || null,
        phone: lead.phone || null,
        serviceId: (lead.serviceId || lead.cabinClass || 'economy').toLowerCase(),
        status: lead.status || 'New Lead',
        origin: lead.origin || null,
        destination: lead.destination || null,
        travelDate: lead.travelDate || null,
        passengers: lead.passengers || 1,
        budget: lead.budget ? Number(lead.budget) : null,
        notes: lead.notes || null,
        updatedAt: new Date(),
      },
      create: {
        id: lead.id,
        firstName,
        lastName,
        email: lead.email || null,
        phone: lead.phone || null,
        serviceId: (lead.serviceId || lead.cabinClass || 'economy').toLowerCase(),
        status: lead.status || 'New Lead',
        origin: lead.origin || null,
        destination: lead.destination || null,
        travelDate: lead.travelDate || null,
        passengers: lead.passengers || 1,
        budget: lead.budget ? Number(lead.budget) : null,
        notes: lead.notes || null,
        createdAt: lead.createdAt ? new Date(lead.createdAt) : new Date(),
        updatedAt: new Date(),
      },
    });
  } catch (err) {
    // Resilient fallback — memory and disk cache keep data 100% safe
    console.warn('⚠️ [LeadStore] Postgres sync deferred/unreachable:', err.message);
  }
}

/**
 * Parse and standardize raw website payload item into CRM Lead format
 */
function parseRawWebsiteLead(raw) {
  const websiteLeadId = raw.leadId || raw.id || uuidv4();
  const phone = raw.phoneNumber || raw.phone || '';
  const email = raw.email || '';
  const fullName = raw.name || 'Website Customer';
  const nameParts = fullName.trim().split(' ');
  const firstName = nameParts[0] || 'Customer';
  const lastName = nameParts.slice(1).join(' ') || '';
  const leadSource = raw.leadSource || 'WEBSITE';
  const websiteStatus = raw.status || 'VERIFIED';

  // Process offers & routes
  const offers = Array.isArray(raw.requestedOffers) ? raw.requestedOffers : [];
  const primaryOffer = offers[0] || {};
  const routes = Array.isArray(primaryOffer.flightRoutes) ? primaryOffer.flightRoutes : [];
  const leg1 = routes[0] || {};
  const leg2 = routes[1] || {};

  const originCode = leg1.originAirportCode || leg1.originCityCode || '';
  const originName = leg1.originCityName || leg1.originAirportName || originCode;
  const destCode = leg1.destinationAirportCode || leg1.destinationCityCode || '';
  const destName = leg1.destinationCityName || leg1.destinationAirportName || destCode;

  const origin = originCode ? `${originCode} (${originName})` : '';
  const destination = destCode ? `${destCode} (${destName})` : '';

  const departureDate = leg1.departureDateTime ? leg1.departureDateTime.split('T')[0] : '';
  const returnDate = leg2.departureDateTime ? leg2.departureDateTime.split('T')[0] : '';
  const travelDate = returnDate ? `${departureDate} - ${returnDate}` : departureDate;

  const adults = Number(primaryOffer.adultCount) || 1;
  const children = Number(primaryOffer.childCount) || 0;
  const infants = Number(primaryOffer.infantCount) || 0;
  const passengers = adults + children + infants;

  const cabinClass = primaryOffer.cabinClass || 'ECONOMY';
  const tripType = primaryOffer.tripType || (leg2.flightRouteId ? 'ROUND_TRIP' : 'ONE_WAY');
  const budget = primaryOffer.offeredAmount ? Number(primaryOffer.offeredAmount) : null;
  const currency = primaryOffer.offeredCurrency || 'USD';
  const providerOfferId = primaryOffer.providerOfferId || '';
  const requestOfferId = primaryOffer.requestOfferId || '';

  // Formulate clear notes summary
  const flightSummary = `${tripType.replace('_', ' ')}: ${originCode || 'Unknown'} ➔ ${destCode || 'Unknown'} | Cabin: ${cabinClass} | Pax: ${passengers} (${adults} Adt, ${children} Chd) | Offer: $${budget || 0} ${currency} | Lead Source: ${leadSource}`;

  return {
    websiteLeadId,
    name: fullName,
    firstName,
    lastName,
    email,
    phone,
    emailVerified: !!raw.emailVerified,
    phoneVerified: !!raw.phoneVerified,
    websiteStatus,
    leadSource,
    origin,
    originCode,
    destination,
    destCode,
    travelDate,
    departureDate,
    returnDate,
    passengers,
    cabinClass,
    serviceId: cabinClass.toLowerCase(),
    budget,
    currency,
    tripType,
    providerOfferId,
    requestOfferId,
    flightSummary,
    rawOffers: offers,
    leadLastRequestedAt: raw.leadLastRequestedAt || raw.updatedAt || new Date().toISOString(),
    createdAtWebsite: raw.createdAt || new Date().toISOString(),
  };
}

/**
 * Ingest or Update Lead from Webhook
 * @param {Object} rawLead
 * @param {Object} options - { isSandbox: boolean }
 * Returns: { action: 'CREATED' | 'UPDATED' | 'IDEMPOTENT_ACK', lead, isDuplicate, isReturning, isNew, isSandbox }
 */
function ingestLead(rawLead, options = {}) {
  const isSandbox = !!options.isSandbox;
  const parsed = parseRawWebsiteLead(rawLead);
  const normalizedPhone = normalizePhone(parsed.phone);

  // Pick target store (Isolated sandbox vs Live production)
  const targetMap = isSandbox ? sandboxLeads : leadsById;
  const targetPhoneIndex = isSandbox ? sandboxPhoneIndex : phoneIndex;
  const targetWebIdIndex = isSandbox ? sandboxWebsiteIdIndex : websiteIdIndex;

  // 1. Check for existing lead by websiteLeadId OR Phone Number
  let existingId = targetWebIdIndex.get(parsed.websiteLeadId);
  if (!existingId && normalizedPhone) {
    existingId = targetPhoneIndex.get(normalizedPhone);
  }

  const nowIso = new Date().toISOString();

  if (existingId && targetMap.has(existingId)) {
    const existing = targetMap.get(existingId);

    // ── Check Idempotency (Duplicate Retries) ──
    const hasSameOffer = parsed.requestOfferId && existing.latestOfferId === parsed.requestOfferId;
    const sameTimestamp = parsed.leadLastRequestedAt && existing.leadLastRequestedAt === parsed.leadLastRequestedAt;

    if (hasSameOffer || (sameTimestamp && !parsed.requestOfferId)) {
      console.log(`🔁 [LeadStore] Duplicate webhook acknowledged idempotently (${isSandbox ? 'SANDBOX' : 'PROD'}) for Lead ID: ${existing.id}`);
      return {
        action: 'IDEMPOTENT_ACK',
        lead: existing,
        isDuplicate: true,
        isReturning: false,
        isNew: false,
        isSandbox,
      };
    }

    // ── Returning Customer with New Flight Request ──
    console.log(`🔄 [LeadStore] Returning customer detected (${isSandbox ? 'SANDBOX' : 'PROD'})! Updating Lead ID: ${existing.id}`);

    const historyEntry = {
      timestamp: nowIso,
      requestOfferId: parsed.requestOfferId,
      providerOfferId: parsed.providerOfferId,
      flightSummary: parsed.flightSummary,
      routes: parsed.rawOffers,
    };

    const previousHistory = Array.isArray(existing.inquiryHistory) ? existing.inquiryHistory : [];
    const updatedHistory = [historyEntry, ...previousHistory];

    const updatedNotes = `[Returning Request - ${nowIso.split('T')[0]}]: ${parsed.flightSummary}\n${existing.notes ? existing.notes : ''}`.trim();

    const updatedLead = {
      ...existing,
      name: parsed.name || existing.name,
      firstName: parsed.firstName || existing.firstName,
      lastName: parsed.lastName || existing.lastName,
      email: parsed.email || existing.email,
      phone: parsed.phone || existing.phone,
      origin: parsed.origin || existing.origin,
      destination: parsed.destination || existing.destination,
      travelDate: parsed.travelDate || existing.travelDate,
      passengers: parsed.passengers || existing.passengers,
      budget: parsed.budget || existing.budget,
      cabinClass: parsed.cabinClass || existing.cabinClass,
      serviceId: (parsed.cabinClass || existing.cabinClass || 'economy').toLowerCase(),
      leadSource: parsed.leadSource || existing.leadSource,
      latestOfferId: parsed.requestOfferId,
      status: isSandbox ? 'TEST_LEAD' : 'New Lead',
      leadLastRequestedAt: parsed.leadLastRequestedAt,
      inquiryCount: (existing.inquiryCount || 1) + 1,
      inquiryHistory: updatedHistory,
      notes: updatedNotes,
      isSandbox,
      updatedAt: nowIso,
    };

    targetMap.set(existing.id, updatedLead);
    saveToDisk(isSandbox);
    if (!isSandbox) {
      syncToPostgres(updatedLead);
    }

    return {
      action: 'UPDATED',
      lead: updatedLead,
      isDuplicate: false,
      isReturning: true,
      isNew: false,
      isSandbox,
    };
  }

  // ── Brand New Lead ──
  const crmId = uuidv4();
  console.log(`✨ [LeadStore] Ingesting brand new lead (${isSandbox ? 'SANDBOX' : 'PROD'}): ${crmId} (${parsed.name})`);

  const newLead = {
    id: crmId,
    websiteLeadId: parsed.websiteLeadId,
    name: parsed.name,
    firstName: parsed.firstName,
    lastName: parsed.lastName,
    email: parsed.email,
    phone: parsed.phone,
    emailVerified: parsed.emailVerified,
    phoneVerified: parsed.phoneVerified,
    leadSource: parsed.leadSource,
    origin: parsed.origin,
    destination: parsed.destination,
    travelDate: parsed.travelDate,
    passengers: parsed.passengers,
    budget: parsed.budget,
    cabinClass: parsed.cabinClass,
    serviceId: parsed.serviceId,
    status: isSandbox ? 'TEST_LEAD' : 'New Lead',
    latestOfferId: parsed.requestOfferId,
    leadLastRequestedAt: parsed.leadLastRequestedAt,
    inquiryCount: 1,
    inquiryHistory: [
      {
        timestamp: nowIso,
        requestOfferId: parsed.requestOfferId,
        providerOfferId: parsed.providerOfferId,
        flightSummary: parsed.flightSummary,
        routes: parsed.rawOffers,
      },
    ],
    notes: `[${isSandbox ? 'SANDBOX TEST' : 'Website Inquiry'} - ${nowIso.split('T')[0]}]: ${parsed.flightSummary}`,
    assignedAgentId: null,
    isSandbox,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  targetMap.set(crmId, newLead);
  if (normalizedPhone) targetPhoneIndex.set(normalizedPhone, crmId);
  if (parsed.websiteLeadId) targetWebIdIndex.set(parsed.websiteLeadId, crmId);

  saveToDisk(isSandbox);
  if (!isSandbox) {
    syncToPostgres(newLead);
  }

  return {
    action: 'CREATED',
    lead: newLead,
    isDuplicate: false,
    isReturning: false,
    isNew: true,
    isSandbox,
  };
}

/**
 * Fetch leads with optional filtering and pagination (for polling endpoint fallback)
 */
function getLeads({ since, limit = 50, offset = 0, status, isSandbox = false }) {
  const targetMap = isSandbox ? sandboxLeads : leadsById;
  let all = Array.from(targetMap.values());

  // Filter by since (ISO timestamp)
  if (since) {
    const sinceDate = new Date(since).getTime();
    if (!isNaN(sinceDate)) {
      all = all.filter((l) => {
        const leadTime = new Date(l.leadLastRequestedAt || l.updatedAt || l.createdAt).getTime();
        return leadTime >= sinceDate;
      });
    }
  }

  // Filter by status
  if (status) {
    all = all.filter((l) => (l.status || '').toLowerCase() === status.toLowerCase());
  }

  // Sort newest first
  all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const count = all.length;
  const paginated = all.slice(Number(offset), Number(offset) + Number(limit));

  return {
    total: count,
    limit: Number(limit),
    offset: Number(offset),
    hasMore: Number(offset) + paginated.length < count,
    nextSince: paginated.length > 0 ? paginated[0].updatedAt : null,
    data: paginated,
  };
}

/**
 * Get lead by CRM ID
 */
function getLeadById(id) {
  return leadsById.get(id) || null;
}

module.exports = {
  ingestLead,
  getLeads,
  getLeadById,
  normalizePhone,
};
