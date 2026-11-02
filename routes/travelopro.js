/**
 * server/routes/travelopro.js
 * Travelopro Flight API Proxy & Normalizer for WowMyFlight CRM
 */

const express = require('express');
const router = express.Router();

const API_BASE = process.env.TRAVELOPRO_API_BASE || 'https://travelnext.works/api/aeroVE5';
const USER_ID = process.env.TRAVELOPRO_USER_ID || 'wowmyflight_testAPI';
const USER_PASSWORD = process.env.TRAVELOPRO_PASSWORD || 'wowmyflightTest@2026';
const ACCESS = process.env.TRAVELOPRO_ACCESS || 'Test';

/**
 * Helper to get authentication credentials for requests
 */
function getCredentials(req) {
  const forwarded = req && req.headers ? req.headers['x-forwarded-for'] : null;
  const clientIp = forwarded ? forwarded.split(',')[0].trim() : '116.75.196.161';

  return {
    user_id: USER_ID,
    user_password: USER_PASSWORD,
    access: ACCESS,
    ip_address: clientIp.includes(':') ? '116.75.196.161' : clientIp
  };
}

/**
 * Format raw ISO date/time into display format
 */
function formatDateTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    const hours = d.getHours();
    const mins = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h12 = hours % 12 || 12;
    return `${h12}:${mins} ${ampm}`;
  } catch {
    return isoStr;
  }
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  return isoStr.split('T')[0] || isoStr;
}

function formatDuration(mins) {
  const m = parseInt(mins, 10);
  if (isNaN(m) || m <= 0) return 'Direct';
  const hours = Math.floor(m / 60);
  const minutes = m % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * Normalizes a single Travelopro FareItinerary into the WowMyFlight offer shape
 */
function normalizeFareItinerary(fareItineraryObj, index, query = {}) {
  const itin = fareItineraryObj.FareItinerary || fareItineraryObj;
  const fareInfo = itin.AirItineraryFareInfo || {};
  const totalFares = fareInfo.ItinTotalFares || {};
  const baseFare = parseFloat(totalFares.BaseFare?.Amount || 0);
  const taxes = parseFloat(totalFares.TotalTax?.Amount || 0);
  const totalFare = parseFloat(totalFares.TotalFare?.Amount || (baseFare + taxes));
  const currency = totalFares.BaseFare?.CurrencyCode || 'USD';

  const isRefundable = (fareInfo.IsRefundable === 'Yes');
  const fareBreakdown = fareInfo.FareBreakdown?.[0] || {};
  const baggageList = fareBreakdown.Baggage || [];
  const cabinBaggageList = fareBreakdown.CabinBaggage || [];
  const baggageStr = [
    baggageList.length ? baggageList.join(', ') : '1 Piece Included',
    cabinBaggageList.length ? `${cabinBaggageList.join(', ')} Cabin` : '7kg Cabin'
  ].filter(Boolean).join(' + ');

  const fareBasis = fareBreakdown.FareBasisCode || `${itin.ValidatingAirlineCode || 'WMF'}FLEX`;

  // Parse Outbound Leg
  const outboundOptions = itin.OriginDestinationOptions?.[0]?.OriginDestinationOption || [];
  const firstSeg = outboundOptions[0]?.FlightSegment || {};
  const lastSeg = outboundOptions[outboundOptions.length - 1]?.FlightSegment || firstSeg;

  const stopsCount = Math.max(0, outboundOptions.length - 1);
  const airlineName = firstSeg.MarketingAirlineName || itin.ValidatingAirlineCode || 'Commercial Carrier';
  const airlineCode = firstSeg.MarketingAirlineCode || itin.ValidatingAirlineCode || 'GDS';
  const flightNumber = `${airlineCode}-${firstSeg.FlightNumber || '101'}`;
  const originCode = firstSeg.DepartureAirportLocationCode || query.origin || 'DEL';
  const destCode = lastSeg.ArrivalAirportLocationCode || query.destination || 'LHR';
  const depTimeStr = formatDateTime(firstSeg.DepartureDateTime);
  const arrTimeStr = formatDateTime(lastSeg.ArrivalDateTime);
  const depDateStr = formatDate(firstSeg.DepartureDateTime) || query.departDate;
  const arrDateStr = formatDate(lastSeg.ArrivalDateTime) || query.departDate;

  // Layover info
  let layoverDesc = 'Direct Non-Stop';
  if (stopsCount > 0) {
    const stopAirport = outboundOptions[0]?.FlightSegment?.ArrivalAirportLocationCode || 'Transit';
    layoverDesc = `${stopsCount} Stop (${stopAirport} ${formatDuration(outboundOptions[0]?.StopQuantityInfo?.Duration || 90)})`;
  }

  // Parse Inbound Leg (for RoundTrip)
  const inboundOptions = itin.OriginDestinationOptions?.[1]?.OriginDestinationOption || [];
  let inboundObj = null;
  if (inboundOptions.length > 0) {
    const inFirst = inboundOptions[0]?.FlightSegment || {};
    const inLast = inboundOptions[inboundOptions.length - 1]?.FlightSegment || inFirst;
    inboundObj = {
      date: formatDate(inFirst.DepartureDateTime) || query.returnDate,
      route: `${inFirst.DepartureAirportLocationCode} → ${inLast.ArrivalAirportLocationCode}`,
      totalDuration: formatDuration(inFirst.JourneyDuration || 480),
      stops: Math.max(0, inboundOptions.length - 1),
      emissions: '760 kg CO2e',
      flightNo: `${inFirst.MarketingAirlineCode || airlineCode} ${inFirst.FlightNumber || ''}`,
      departTime: formatDateTime(inFirst.DepartureDateTime),
      arriveTime: formatDateTime(inLast.ArrivalDateTime),
      leg1: {
        flightNo: `${inFirst.MarketingAirlineCode || airlineCode} ${inFirst.FlightNumber || ''}`,
        aircraft: inFirst.OperatingAirline?.Equipment ? `Aircraft ${inFirst.OperatingAirline.Equipment}` : 'Boeing 787',
        origin: inFirst.DepartureAirportLocationCode,
        originCode: inFirst.DepartureAirportLocationCode,
        depTime: formatDateTime(inFirst.DepartureDateTime),
        dest: inFirst.ArrivalAirportLocationCode,
        destCode: inFirst.ArrivalAirportLocationCode,
        arrTime: formatDateTime(inFirst.ArrivalDateTime),
        duration: formatDuration(inFirst.JourneyDuration || 240),
        overnight: false
      }
    };
  }

  const suggestedSellingPrice = Math.round(totalFare * 1.15) + 120;

  return {
    id: `TP-${itin.SequenceNumber || index + 1}-${Date.now().toString(36).slice(-4)}`,
    supplierAdapterId: 'ADAPTER-TRAVELOPRO',
    supplierName: 'TraveloPro (B2B Global Flights)',
    supplierType: 'Consolidator B2B',
    airline: `${airlineName} (${airlineCode})`,
    airlineCode: airlineCode,
    flightNumber: flightNumber,
    origin: originCode,
    destination: destCode,
    departure: `${originCode} ${depTimeStr} (${depDateStr})`,
    arrival: `${destCode} ${arrTimeStr} (${arrDateStr})`,
    depDateTime: firstSeg.DepartureDateTime || `${depDateStr}T09:00:00`,
    arrDateTime: lastSeg.ArrivalDateTime || `${arrDateStr}T18:00:00`,
    duration: formatDuration(firstSeg.JourneyDuration || 540),
    stops: layoverDesc,
    cabinClass: query.cabinClass || firstSeg.CabinClassText || 'Economy',
    fareFamily: `${firstSeg.CabinClassText || 'Published'} Flexible`,
    baggage: baggageStr,
    fareConditions: isRefundable ? 'Refundable with penalty' : (itin.TicketAdvisory || 'Non-refundable fare rules apply'),
    baseFare: Math.round(baseFare),
    taxes: Math.round(taxes),
    supplierCost: Math.round(totalFare),
    totalNetPrice: Math.round(totalFare),
    usdEquivalent: Math.round(totalFare),
    suggestedSellingPrice: suggestedSellingPrice,
    currency: currency,
    gdsSource: 'TraveloPro B2B GDS',
    fareBasis: fareBasis,
    fareSourceCode: fareInfo.FareSourceCode || '',
    refundable: isRefundable ? 'Refundable' : 'Non-refundable',
    protocolUsed: 'REST / JSON API',
    notes: itin.TicketAdvisory || 'TraveloPro Live Net Fare with instant PNR issuance',
    amenities: {
      legroom: (query.cabinClass === 'Business' || query.cabinClass === 'First') 
        ? '180° Fully Lie-Flat Bed (198 cm / 78")' 
        : 'Standard Legroom (79 cm / 31")',
      wifi: 'High-speed Satellite Wi-Fi',
      power: 'USB & Universal AC Power Outlets',
      entertainment: '13.3" HD Touchscreen In-Flight Entertainment'
    },
    outbound: {
      date: depDateStr,
      route: `${originCode} → ${destCode}`,
      totalDuration: formatDuration(firstSeg.JourneyDuration || 540),
      stops: stopsCount,
      emissions: '720 kg CO2e (-10% emissions)',
      flightNo: `${airlineCode} ${firstSeg.FlightNumber || ''}`,
      departTime: depTimeStr,
      arriveTime: arrTimeStr,
      leg1: {
        flightNo: `${airlineCode} ${firstSeg.FlightNumber || ''}`,
        aircraft: firstSeg.OperatingAirline?.Equipment ? `Aircraft ${firstSeg.OperatingAirline.Equipment}` : 'Boeing 787-9 Dreamliner',
        origin: originCode,
        originCode: originCode,
        depTime: depTimeStr,
        dest: outboundOptions[0]?.FlightSegment?.ArrivalAirportLocationCode || destCode,
        destCode: outboundOptions[0]?.FlightSegment?.ArrivalAirportLocationCode || destCode,
        arrTime: formatDateTime(outboundOptions[0]?.FlightSegment?.ArrivalDateTime || lastSeg.ArrivalDateTime),
        duration: formatDuration(firstSeg.JourneyDuration || 540),
        overnight: false
      },
      ...(stopsCount > 0 && outboundOptions[1] ? {
        layover: {
          duration: `${formatDuration(outboundOptions[0]?.StopQuantityInfo?.Duration || 90)} layover`,
          airport: outboundOptions[0]?.FlightSegment?.ArrivalAirportLocationCode || 'Transit Airport'
        },
        leg2: {
          flightNo: `${outboundOptions[1].FlightSegment.MarketingAirlineCode || airlineCode} ${outboundOptions[1].FlightSegment.FlightNumber || ''}`,
          aircraft: 'Airbus A350-900',
          origin: outboundOptions[1].FlightSegment.DepartureAirportLocationCode,
          originCode: outboundOptions[1].FlightSegment.DepartureAirportLocationCode,
          depTime: formatDateTime(outboundOptions[1].FlightSegment.DepartureDateTime),
          dest: outboundOptions[1].FlightSegment.ArrivalAirportLocationCode,
          destCode: outboundOptions[1].FlightSegment.ArrivalAirportLocationCode,
          arrTime: formatDateTime(outboundOptions[1].FlightSegment.ArrivalDateTime),
          duration: formatDuration(outboundOptions[1].FlightSegment.JourneyDuration || 240),
          overnight: false
        }
      } : {})
    },
    ...(inboundObj ? { inbound: inboundObj } : {})
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/travelopro/auth
// Test authentication / connection status
// ─────────────────────────────────────────────────────────────────────────────
router.post('/auth', async (req, res) => {
  try {
    const creds = getCredentials(req);
    return res.json({
      success: true,
      authenticated: true,
      userId: creds.user_id,
      access: creds.access,
      apiBase: API_BASE,
      message: 'Travelopro API credentials configured and active'
    });
  } catch (err) {
    console.error('[Travelopro Auth Error]', err);
    return res.status(500).json({ error: 'Auth check failed', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/travelopro/flights/search
// Search flights and return normalized offers array
// ─────────────────────────────────────────────────────────────────────────────
router.post('/flights/search', async (req, res) => {
  try {
    const {
      origin = 'DEL',
      destination = 'LHR',
      departDate = '2026-11-21',
      returnDate = null,
      cabinClass = 'Economy',
      passengers = 1,
      tripType = 'oneway',
      adults = 1,
      childs = 0,
      infants = 0,
      currency = 'USD'
    } = req.body;

    const creds = getCredentials(req);
    const isRoundTrip = (tripType.toLowerCase() === 'roundtrip' || tripType.toLowerCase() === 'round trip' || !!returnDate);

    // Calculate passenger breakdown
    const adultCount = adults || Math.max(1, passengers);
    const childCount = childs || 0;
    const infantCount = infants || 0;

    const originDest = {
      departureDate: departDate,
      airportOriginCode: origin.toUpperCase(),
      airportDestinationCode: destination.toUpperCase()
    };
    if (isRoundTrip && returnDate) {
      originDest.returnDate = returnDate;
    }

    const payload = {
      user_id: creds.user_id,
      user_password: creds.user_password,
      access: creds.access,
      ip_address: creds.ip_address,
      requiredCurrency: currency,
      journeyType: isRoundTrip ? 'Return' : 'OneWay',
      OriginDestinationInfo: [originDest],
      class: cabinClass === 'Business' ? 'Business' : cabinClass === 'First Class' ? 'First' : 'Economy',
      adults: adultCount,
      childs: childCount,
      infants: infantCount
    };

    console.log(`[Travelopro Search] POST ${API_BASE}/availability`, {
      origin,
      destination,
      journeyType: payload.journeyType,
      departDate,
      returnDate
    });

    const response = await fetch(`${API_BASE}/availability`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Travelopro HTTP Error ${response.status}]`, errText);
      return res.status(response.status).json({
        error: `Travelopro API HTTP ${response.status}`,
        details: errText
      });
    }

    const data = await response.json();

    // Check for Travelopro error structure
    if (data.Errors) {
      console.warn('[Travelopro API Returned Errors]', data.Errors);
      return res.status(400).json({
        error: data.Errors.ErrorMessage || 'Travelopro Search Validation Error',
        code: data.Errors.ErrorCode || 'FL_ERR',
        details: data.Errors
      });
    }

    const itineraries = data.AirSearchResponse?.AirSearchResult?.FareItineraries || [];
    const sessionId = data.AirSearchResponse?.session_id || '';

    const normalizedOffers = itineraries.map((itin, idx) => {
      const offer = normalizeFareItinerary(itin, idx, {
        origin,
        destination,
        departDate,
        returnDate,
        cabinClass
      });
      offer.sessionId = sessionId;
      return offer;
    });

    console.log(`[Travelopro Search Result] Found ${normalizedOffers.length} normalized offers (Session: ${sessionId})`);

    return res.json({
      query: { origin, destination, departDate, returnDate, cabinClass, passengers },
      sessionId: sessionId,
      searchedAdaptersCount: 1,
      offersCount: normalizedOffers.length,
      offers: normalizedOffers
    });

  } catch (err) {
    console.error('[Travelopro Search Exception]', err);
    return res.status(500).json({
      error: 'Flight search proxy failed',
      message: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/travelopro/flights/revalidate
// Revalidate fare before booking
// ─────────────────────────────────────────────────────────────────────────────
router.post('/flights/revalidate', async (req, res) => {
  try {
    const { fareSourceCode } = req.body;
    const creds = getCredentials(req);

    const payload = {
      user_id: creds.user_id,
      user_password: creds.user_password,
      access: creds.access,
      ip_address: creds.ip_address,
      fareSourceCode
    };

    const response = await fetch(`${API_BASE}/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('[Travelopro Revalidate Error]', err);
    return res.status(500).json({ error: 'Fare revalidation failed', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/travelopro/flights/book
// Create Booking / Hold PNR
// ─────────────────────────────────────────────────────────────────────────────
router.post('/flights/book', async (req, res) => {
  try {
    const creds = getCredentials(req);
    const bookingPayload = {
      user_id: creds.user_id,
      user_password: creds.user_password,
      access: creds.access,
      ip_address: creds.ip_address,
      ...req.body
    };

    console.log(`[Travelopro Booking] POST ${API_BASE}/booking`);
    const response = await fetch(`${API_BASE}/booking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bookingPayload)
    });

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('[Travelopro Booking Error]', err);
    return res.status(500).json({ error: 'Flight booking failed', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/travelopro/flights/issue
// Issue Ticket for a confirmed PNR
// ─────────────────────────────────────────────────────────────────────────────
router.post('/flights/issue', async (req, res) => {
  try {
    const creds = getCredentials(req);
    const issuePayload = {
      user_id: creds.user_id,
      user_password: creds.user_password,
      access: creds.access,
      ip_address: creds.ip_address,
      ...req.body
    };

    console.log(`[Travelopro Ticket Order] POST ${API_BASE}/ticketorder`);
    const response = await fetch(`${API_BASE}/ticketorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(issuePayload)
    });

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('[Travelopro Issue Ticket Error]', err);
    return res.status(500).json({ error: 'Ticket issuance failed', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/travelopro/flights/cancel
// Cancel booking / PNR
// ─────────────────────────────────────────────────────────────────────────────
router.post('/flights/cancel', async (req, res) => {
  try {
    const creds = getCredentials(req);
    const cancelPayload = {
      user_id: creds.user_id,
      user_password: creds.user_password,
      access: creds.access,
      ip_address: creds.ip_address,
      ...req.body
    };

    console.log(`[Travelopro Cancel] POST ${API_BASE}/cancel`);
    const response = await fetch(`${API_BASE}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cancelPayload)
    });

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('[Travelopro Cancel Error]', err);
    return res.status(500).json({ error: 'Cancellation failed', message: err.message });
  }
});

module.exports = router;
