const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Storage File Paths
const GENERAL_SETTINGS_FILE = path.join(__dirname, '../store/general_settings.json');
const SERVICES_FILE = path.join(__dirname, '../store/flight_services.json');
const PACKAGES_FILE = path.join(__dirname, '../store/travel_packages.json');
const TEMPLATES_FILE = path.join(__dirname, '../store/notification_templates.json');
const CHANNELS_FILE = path.join(__dirname, '../store/channel_settings.json');
const STRIPE_FILE = path.join(__dirname, '../store/payment_settings.json');

const { prisma } = require('../db');
async function readJsonFile(filePath, defaultValue) {
  const stored = await prisma.appSetting.findUnique({where:{key:path.basename(filePath)}});
  return stored ? stored.value : defaultValue;
}
async function writeJsonFile(filePath, data) {
  await prisma.appSetting.upsert({where:{key:path.basename(filePath)},create:{key:path.basename(filePath),value:data},update:{value:data}});
}
const safe = handler => (req,res,next) => Promise.resolve(handler(req,res,next)).catch(() => res.status(503).json({success:false,error:'Settings could not be saved or loaded. Please retry.'}));
const DEFAULT_GENERAL_SETTINGS = {companyName:'Wow My Flight',brandTagline:'',phone:process.env.TELNYX_PHONE_NUMBER || '',email:'',bookingEmail:'',address:'',vatRate:0,vatId:'',currency:'USD',currencySymbol:'$',website:'',incorporationDate:'',autoAssignConsultant:false,recordingStorage:'',primaryColor:'#1E40AF',accentColor:'#C59B27'};

const DEFAULT_FLIGHT_SERVICES = [];

const DEFAULT_TRAVEL_PACKAGES = [];

const DEFAULT_TEMPLATES = {
  emails: [
    {
      id: 'et1',
      name: 'Flight Booking Confirmation',
      subject: 'Flight Booking Confirmed - Wow My Flight (PNR: {pnr})',
      body: `Dear {clientName},

Thank you for choosing Wow My Flight Travel Agency. Your flight booking has been confirmed and issued in our GDS system.

BOOKING SUMMARY:
- Passenger Name: {clientName}
- Booking Reference (PNR): {pnr}
- Route: {route}
- Departure: {departureDate}
- Airline: {airline}
- Cabin Class: {cabinClass}
- Total Amount Paid: {amount}

Your official E-Ticket PDF and airline boarding passes are ready for download:
{bookingLink}

Need assistance with seat selection, extra baggage, or meal preferences? Simply reply to this email or call our 24/7 desk at +1 (833) 395-5554.

Warm regards,
Ticketing & Reservations Desk
Wow My Flight Travel Agency Inc.
support@wowmyflight.com | https://wowmyflight.com`
    },
    {
      id: 'et2',
      name: 'Flight Quote & Itinerary Proposal',
      subject: 'Exclusive Flight Proposal & Quote #{quoteId} for {route}',
      body: `Dear {clientName},

Our flight specialists have curated the best flight itinerary options for your upcoming journey to {destination}.

QUOTE DETAILS:
- Quote Reference: #{quoteId}
- Route: {route}
- Proposed Cabin: {cabinClass}
- Valid Until: 24 Hours from Issuance
- Total Fare (Taxes & Fees Included): {amount}

Click below to review the flight options, compare flight durations, and secure this fare:
{bookingLink}

Best regards,
Travel Consultant: {consultantName}
Wow My Flight Travel Agency Inc.`
    },
    {
      id: 'et3',
      name: 'Flight Invoice & Payment Link',
      subject: 'Invoice {invoiceId} for Flight Reservation {pnr}',
      body: `Dear {clientName},

Your flight itinerary is held with the airline. To complete ticketing and ensure your seats are secured, please finalize payment using our secure checkout link.

INVOICE SUMMARY:
- Invoice #: {invoiceId}
- Booking PNR: {pnr}
- Package/Service: {packageName}
- Total Amount: {amount}
- Due Date: {dueDate}

Secure Payment Gateway (Credit/Debit/Stripe):
{bookingLink}

Thank you for booking with Wow My Flight!

Finance Operations
Wow My Flight Travel Agency Inc.`
    }
  ],
  whatsapps: [
    {
      id: 'wt1',
      name: 'WhatsApp Instant Flight Quote',
      body: `✈️ Hello {clientName}! Greetings from Wow My Flight Air Concierge!
We have secured flight options for your trip: {route}.
Total Fare: {amount}.
Tap to view flight timings & confirm your seat: {bookingLink}`
    },
    {
      id: 'wt2',
      name: 'WhatsApp E-Ticket & PNR Dispatch',
      body: `🎉 Your Flight Ticket is Ready!
Passenger: {clientName}
PNR: {pnr}
Route: {route}
Your E-Ticket PDF has been dispatched to your email.
Have questions? Reply here anytime to chat with your dedicated flight agent!`
    },
    {
      id: 'wt3',
      name: 'WhatsApp 24h Check-in Reminder',
      body: `⏰ 24-Hour Flight Alert:
Dear {clientName}, your flight departs tomorrow!
Web check-in is now open. Would you like our agent to assign your preferred aisle or window seat?
Reply YES to auto-check-in.`
    }
  ]
};

const DEFAULT_CHANNEL_SETTINGS = {primaryPhone:process.env.TELNYX_PHONE_NUMBER || '',secondaryPhone:'',whatsappSales:'',whatsappSupport:'',facebookPage1:'',facebookPage2:'',instagramAccount1:'',instagramAccount2:''};

const DEFAULT_STRIPE_SETTINGS = {mode:'unconfigured',primaryAccount:{id:'stripe_primary',label:'Primary Stripe Account',publishableKey:'',secretKeyMasked:'',status:'Not configured',currency:'USD',lastUsed:'Never',volume:'$0'},secondaryAccount:{id:'stripe_secondary',label:'Secondary Stripe Account',publishableKey:'',secretKeyMasked:'',status:'Not configured',currency:'USD',lastUsed:'Never',volume:'$0'}};

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// 1. GET /api/settings/all — Fetch everything at once for fast load
router.get('/all', safe(async (req, res) => {
  const general = await readJsonFile(GENERAL_SETTINGS_FILE, DEFAULT_GENERAL_SETTINGS);
  const services = await readJsonFile(SERVICES_FILE, DEFAULT_FLIGHT_SERVICES);
  const packages = await readJsonFile(PACKAGES_FILE, DEFAULT_TRAVEL_PACKAGES);
  const templates = await readJsonFile(TEMPLATES_FILE, DEFAULT_TEMPLATES);
  const channels = await readJsonFile(CHANNELS_FILE, DEFAULT_CHANNEL_SETTINGS);
  const stripe = await readJsonFile(STRIPE_FILE, DEFAULT_STRIPE_SETTINGS);

  res.json({
    success: true,
    data: {
      general,
      services,
      packages,
      templates,
      channels,
      stripe
    }
  });
}));

// 2. GENERAL SETTINGS
router.get('/general', safe(async (req, res) => {
  const settings = await readJsonFile(GENERAL_SETTINGS_FILE, DEFAULT_GENERAL_SETTINGS);
  res.json({ success: true, data: settings });
}));

router.put('/general', safe(async (req, res) => {
  const current = await readJsonFile(GENERAL_SETTINGS_FILE, DEFAULT_GENERAL_SETTINGS);
  const updated = {
    ...current,
    ...req.body,
    updatedAt: new Date().toISOString()
  };
  await writeJsonFile(GENERAL_SETTINGS_FILE, updated);
  res.json({ success: true, message: 'General corporate profile updated successfully', data: updated });
}));

// 3. FLIGHT SERVICES & CABIN PRICING
router.get('/services', safe(async (req, res) => {
  const services = await readJsonFile(SERVICES_FILE, DEFAULT_FLIGHT_SERVICES);
  res.json({ success: true, data: services });
}));

router.put('/services', safe(async (req, res) => {
  const services = Array.isArray(req.body) ? req.body : req.body.services;
  if (!Array.isArray(services)) {
    return res.status(400).json({ success: false, error: 'Services must be an array' });
  }
  await writeJsonFile(SERVICES_FILE, services);
  res.json({ success: true, message: 'Flight services updated successfully', data: services });
}));

router.post('/services', safe(async (req, res) => {
  const services = await readJsonFile(SERVICES_FILE, DEFAULT_FLIGHT_SERVICES);
  const newService = {
    id: req.body.id || `srv_${Date.now()}`,
    name: req.body.name,
    category: req.body.category || 'Flight Class',
    basePrice: Number(req.body.basePrice) || 0,
    active: req.body.active !== false
  };
  services.push(newService);
  await writeJsonFile(SERVICES_FILE, services);
  res.status(201).json({ success: true, message: 'Flight service added', data: newService });
}));

// 4. TRAVEL PACKAGES & DELIVERABLES
router.get('/packages', safe(async (req, res) => {
  const packages = await readJsonFile(PACKAGES_FILE, DEFAULT_TRAVEL_PACKAGES);
  res.json({ success: true, data: packages });
}));

router.put('/packages', safe(async (req, res) => {
  const packages = Array.isArray(req.body) ? req.body : req.body.packages;
  if (!Array.isArray(packages)) {
    return res.status(400).json({ success: false, error: 'Packages must be an array' });
  }
  await writeJsonFile(PACKAGES_FILE, packages);
  res.json({ success: true, message: 'Travel packages updated successfully', data: packages });
}));

// 5. NOTIFICATION TEMPLATES (Email & WhatsApp)
router.get('/templates', safe(async (req, res) => {
  const templates = await readJsonFile(TEMPLATES_FILE, DEFAULT_TEMPLATES);
  res.json({ success: true, data: templates });
}));

router.put('/templates', safe(async (req, res) => {
  const current = await readJsonFile(TEMPLATES_FILE, DEFAULT_TEMPLATES);
  const updated = {
    emails: req.body.emails || current.emails,
    whatsapps: req.body.whatsapps || current.whatsapps,
    updatedAt: new Date().toISOString()
  };
  await writeJsonFile(TEMPLATES_FILE, updated);
  res.json({ success: true, message: 'Templates saved successfully', data: updated });
}));

// 6. MULTI-CHANNEL CONTACTS
router.get('/channels', safe(async (req, res) => {
  const channels = await readJsonFile(CHANNELS_FILE, DEFAULT_CHANNEL_SETTINGS);
  res.json({ success: true, data: channels });
}));

router.put('/channels', safe(async (req, res) => {
  const current = await readJsonFile(CHANNELS_FILE, DEFAULT_CHANNEL_SETTINGS);
  const updated = {
    ...current,
    ...req.body,
    updatedAt: new Date().toISOString()
  };
  await writeJsonFile(CHANNELS_FILE, updated);
  res.json({ success: true, message: 'Multi-channel communication settings saved', data: updated });
}));

// 7. STRIPE CONFIGURATION
router.get('/stripe', safe(async (req, res) => {
  const stripe = await readJsonFile(STRIPE_FILE, DEFAULT_STRIPE_SETTINGS);
  res.json({ success: true, data: stripe });
}));

router.put('/stripe', safe(async (req, res) => {
  const current = await readJsonFile(STRIPE_FILE, DEFAULT_STRIPE_SETTINGS);
  const updated = {
    ...current,
    ...req.body,
    updatedAt: new Date().toISOString()
  };
  await writeJsonFile(STRIPE_FILE, updated);
  res.json({ success: true, message: 'Stripe configuration saved successfully', data: updated });
}));

module.exports = router;
