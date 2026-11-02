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

// Helper: Read JSON file safely
function readJsonFile(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.warn(`[Settings API] Could not read ${path.basename(filePath)}:`, err.message);
  }
  return defaultValue;
}

// Helper: Write JSON file safely
function writeJsonFile(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[Settings API] Error saving ${path.basename(filePath)}:`, err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CONFIGURATIONS FOR WOW MY FLIGHT
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_GENERAL_SETTINGS = {
  companyName: 'Wow My Flight Travel Agency Inc.',
  brandTagline: 'Luxury Aviation & Worldwide Flight Booking Portal',
  phone: '+1 (833) 395-5554',
  email: 'support@wowmyflight.com',
  bookingEmail: 'bookings@wowmyflight.com',
  address: 'One World Trade Center, Suite 8500, New York, NY 10007, USA',
  vatRate: 7.5,
  vatId: 'EIN-US-92-4819201',
  currency: 'USD',
  currencySymbol: '$',
  website: 'https://wowmyflight.com',
  incorporationDate: '2020-03-15',
  autoAssignConsultant: true,
  recordingStorage: 'cloud',
  primaryColor: '#1E40AF',
  accentColor: '#C59B27',
  updatedAt: new Date().toISOString()
};

const DEFAULT_FLIGHT_SERVICES = [
  { id: 'srv_eco', name: 'Economy Class', category: 'Economy', basePrice: 550, active: true },
  { id: 'srv_prem', name: 'Premium Economy', category: 'Economy', basePrice: 950, active: true },
  { id: 'srv_biz', name: 'Business Class', category: 'Business', basePrice: 3200, active: true },
  { id: 'srv_first', name: 'First Class & Suites', category: 'First', basePrice: 7500, active: true },
  { id: 'srv_charter', name: 'Private Jet Charter', category: 'Charter', basePrice: 22000, active: true },
  { id: 'srv_vip_concierge', name: 'VIP Airport Fast-Track & Lounge Escort', category: 'Concierge', basePrice: 350, active: true }
];

const DEFAULT_TRAVEL_PACKAGES = [
  {
    id: 'flight_saver',
    name: 'Flight Only Saver',
    price: 550,
    description: 'Instant GDS airfare booking with competitive markup, e-ticket issuance, and automated 24/7 flight schedule tracking.',
    includes: [
      'GDS Fare Search (Travelopro / Sabre / Amadeus)',
      'Instant PNR & Official Airline E-Ticket PDF',
      'Flight Status & Schedule Change Alerts',
      'Seat Selection & Online Check-In Guidance',
      'WhatsApp & Email Notification Alerts',
      'Dedicated Ticketing Helpdesk'
    ]
  },
  {
    id: 'travel_bundle',
    name: 'Full Travel & Flight Package',
    price: 1250,
    description: 'Complete end-to-end holiday and business travel package with flight, 4-star hotel vouchers, and private airport transfers.',
    includes: [
      'Round-Trip Flights with Baggage Included (2x 23kg)',
      'Partner Hotel Booking Vouchers (4★ / 5★)',
      'Private Airport Chauffeur Transfer',
      'Comprehensive Travel & Medical Insurance',
      'Priority Boarding & Airport Lounge Pass',
      'Dedicated Travel Concierge Agent'
    ]
  },
  {
    id: 'executive_vip',
    name: 'Executive Business Class VIP Concierge',
    price: 3450,
    description: 'Ultra-premium corporate travel package for C-level executives, featuring flatbed business class and meet-and-greet airport service.',
    includes: [
      'Lie-flat Business Class Cabin Guarantee',
      'Fast-Track Security Clearance & VIP Lounge Access',
      'Dedicated 24/7 Personal Flight Broker',
      'Flexible Date Changes & Free Refund Protection',
      'Excess Baggage Allowance (3x 32kg)',
      'Executive Chauffeur Sedan Pickup & Dropoff'
    ]
  },
  {
    id: 'jet_charter',
    name: 'Private Jet & Luxury Charter',
    price: 18500,
    description: 'Exclusive private charter solutions for VIP families, diplomatic delegations, and high-net-worth individuals.',
    includes: [
      'Private Jet Terminal (FBO) Access with Zero Waiting',
      'Custom Flight Schedule & Departure Times',
      'Gourmet In-Flight Dining & Champagne Service',
      'Pet In Cabin Accompaniment',
      'Bespoke Ground Limousine Fleet',
      'Discreet High-Security Flight Protocol'
    ]
  }
];

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

const DEFAULT_CHANNEL_SETTINGS = {
  primaryPhone: '+1 (833) 395-5554',
  secondaryPhone: '+1 (850) 332-9680',
  whatsappSales: '+1 (833) 395-5554',
  whatsappSupport: '+1 (850) 332-9680',
  facebookPage1: 'https://facebook.com/WowMyFlight',
  facebookPage2: 'https://facebook.com/WowMyFlightVIP',
  instagramAccount1: '@wowmyflight',
  instagramAccount2: '@wowmyflight_deals',
  updatedAt: new Date().toISOString()
};

const DEFAULT_STRIPE_SETTINGS = {
  mode: 'live',
  primaryAccount: {
    id: 'stripe_primary',
    label: 'Primary Stripe Account (USD Global)',
    publishableKey: 'pk_live_51P...WMF_USD',
    secretKeyMasked: 'sk_live_51P...9921',
    status: 'Active',
    currency: 'USD',
    lastUsed: 'Today at 3:45 PM',
    volume: '$184,520'
  },
  secondaryAccount: {
    id: 'stripe_secondary',
    label: 'Secondary Stripe Account (Backup / International)',
    publishableKey: 'pk_live_51P...WMF_INTL',
    secretKeyMasked: 'sk_live_51P...3384',
    status: 'Standby',
    currency: 'USD',
    lastUsed: 'Yesterday at 6:10 PM',
    volume: '$42,300'
  },
  updatedAt: new Date().toISOString()
};

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// 1. GET /api/settings/all — Fetch everything at once for fast load
router.get('/all', (req, res) => {
  const general = readJsonFile(GENERAL_SETTINGS_FILE, DEFAULT_GENERAL_SETTINGS);
  const services = readJsonFile(SERVICES_FILE, DEFAULT_FLIGHT_SERVICES);
  const packages = readJsonFile(PACKAGES_FILE, DEFAULT_TRAVEL_PACKAGES);
  const templates = readJsonFile(TEMPLATES_FILE, DEFAULT_TEMPLATES);
  const channels = readJsonFile(CHANNELS_FILE, DEFAULT_CHANNEL_SETTINGS);
  const stripe = readJsonFile(STRIPE_FILE, DEFAULT_STRIPE_SETTINGS);

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
});

// 2. GENERAL SETTINGS
router.get('/general', (req, res) => {
  const settings = readJsonFile(GENERAL_SETTINGS_FILE, DEFAULT_GENERAL_SETTINGS);
  res.json({ success: true, data: settings });
});

router.put('/general', (req, res) => {
  const current = readJsonFile(GENERAL_SETTINGS_FILE, DEFAULT_GENERAL_SETTINGS);
  const updated = {
    ...current,
    ...req.body,
    updatedAt: new Date().toISOString()
  };
  writeJsonFile(GENERAL_SETTINGS_FILE, updated);
  res.json({ success: true, message: 'General corporate profile updated successfully', data: updated });
});

// 3. FLIGHT SERVICES & CABIN PRICING
router.get('/services', (req, res) => {
  const services = readJsonFile(SERVICES_FILE, DEFAULT_FLIGHT_SERVICES);
  res.json({ success: true, data: services });
});

router.put('/services', (req, res) => {
  const services = Array.isArray(req.body) ? req.body : req.body.services;
  if (!Array.isArray(services)) {
    return res.status(400).json({ success: false, error: 'Services must be an array' });
  }
  writeJsonFile(SERVICES_FILE, services);
  res.json({ success: true, message: 'Flight services updated successfully', data: services });
});

router.post('/services', (req, res) => {
  const services = readJsonFile(SERVICES_FILE, DEFAULT_FLIGHT_SERVICES);
  const newService = {
    id: req.body.id || `srv_${Date.now()}`,
    name: req.body.name,
    category: req.body.category || 'Flight Class',
    basePrice: Number(req.body.basePrice) || 0,
    active: req.body.active !== false
  };
  services.push(newService);
  writeJsonFile(SERVICES_FILE, services);
  res.status(201).json({ success: true, message: 'Flight service added', data: newService });
});

// 4. TRAVEL PACKAGES & DELIVERABLES
router.get('/packages', (req, res) => {
  const packages = readJsonFile(PACKAGES_FILE, DEFAULT_TRAVEL_PACKAGES);
  res.json({ success: true, data: packages });
});

router.put('/packages', (req, res) => {
  const packages = Array.isArray(req.body) ? req.body : req.body.packages;
  if (!Array.isArray(packages)) {
    return res.status(400).json({ success: false, error: 'Packages must be an array' });
  }
  writeJsonFile(PACKAGES_FILE, packages);
  res.json({ success: true, message: 'Travel packages updated successfully', data: packages });
});

// 5. NOTIFICATION TEMPLATES (Email & WhatsApp)
router.get('/templates', (req, res) => {
  const templates = readJsonFile(TEMPLATES_FILE, DEFAULT_TEMPLATES);
  res.json({ success: true, data: templates });
});

router.put('/templates', (req, res) => {
  const current = readJsonFile(TEMPLATES_FILE, DEFAULT_TEMPLATES);
  const updated = {
    emails: req.body.emails || current.emails,
    whatsapps: req.body.whatsapps || current.whatsapps,
    updatedAt: new Date().toISOString()
  };
  writeJsonFile(TEMPLATES_FILE, updated);
  res.json({ success: true, message: 'Templates saved successfully', data: updated });
});

// 6. MULTI-CHANNEL CONTACTS
router.get('/channels', (req, res) => {
  const channels = readJsonFile(CHANNELS_FILE, DEFAULT_CHANNEL_SETTINGS);
  res.json({ success: true, data: channels });
});

router.put('/channels', (req, res) => {
  const current = readJsonFile(CHANNELS_FILE, DEFAULT_CHANNEL_SETTINGS);
  const updated = {
    ...current,
    ...req.body,
    updatedAt: new Date().toISOString()
  };
  writeJsonFile(CHANNELS_FILE, updated);
  res.json({ success: true, message: 'Multi-channel communication settings saved', data: updated });
});

// 7. STRIPE CONFIGURATION
router.get('/stripe', (req, res) => {
  const stripe = readJsonFile(STRIPE_FILE, DEFAULT_STRIPE_SETTINGS);
  res.json({ success: true, data: stripe });
});

router.put('/stripe', (req, res) => {
  const current = readJsonFile(STRIPE_FILE, DEFAULT_STRIPE_SETTINGS);
  const updated = {
    ...current,
    ...req.body,
    updatedAt: new Date().toISOString()
  };
  writeJsonFile(STRIPE_FILE, updated);
  res.json({ success: true, message: 'Stripe configuration saved successfully', data: updated });
});

module.exports = router;
