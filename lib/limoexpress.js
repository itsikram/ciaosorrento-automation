/**
 * LimoExpress booking client.
 * Maps Google Calendar events to LimoExpress API booking payload (PUT /api/integration/bookings).
 * See LimoExpress API docs: required booking_type_id, from_location, pickup_time.
 */

const config = require('./config');

const baseUrl = (config.getConfigWithDefault('LIMOEXPRESS_API_URL', '')).replace(/\/$/, '');
const apiKey = config.getConfigWithDefault('LIMOEXPRESS_API_KEY', '');
const bookingTypeId = config.getConfigWithDefault('LIMOEXPRESS_BOOKING_TYPE_ID', '');

function getAuthHeader() {
  return apiKey.trim().toLowerCase().startsWith('bearer ') ? apiKey.trim() : `Bearer ${apiKey.trim()}`;
}

/** GET a LimoExpress integration endpoint and return parsed JSON or error. */
async function fetchIntegrationEndpoint(path) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: getAuthHeader() },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * GET /api/integration/bookings (per API docs).
 * Optional query: pickup_date_from, pickup_date_to (format "YYYY-MM-DD HH:mm:ss"), page, per_page, etc.
 * Returns { ok, status, data } where data.data is the list of bookings.
 */
async function fetchBookings(query = {}) {
  const params = new URLSearchParams();
  if (query.pickup_date_from) params.set('pickup_date_from', query.pickup_date_from);
  if (query.pickup_date_to) params.set('pickup_date_to', query.pickup_date_to);
  if (query.page != null) params.set('page', String(query.page));
  if (query.per_page != null) params.set('per_page', String(query.per_page));
  const path = `/api/integration/bookings${params.toString() ? `?${params.toString()}` : ''}`;
  return fetchIntegrationEndpoint(path);
}

/** Fetch all integration data (booking types, clients, statuses, vehicles, vehicle classes, currencies, payment methods) and log them. */
async function fetchAndLogIntegrationData() {
  const endpoints = [
    ['/api/integration/booking-types', 'Booking types'],
    ['/api/integration/clients', 'Clients'],
    ['/api/integration/booking-statuses', 'Booking statuses'],
    ['/api/integration/vehicles', 'Vehicle'],
    ['/api/integration/vehicle-classes', 'Vehicle classes'],
    ['/api/integration/currencies', 'Currencies'],
    ['/api/integration/payment-methods', 'Payment methods'],
    ['/api/integration/users', 'Users'],
  ];
  const out = {};
  for (const [path, label] of endpoints) {
    const { ok, status, data } = await fetchIntegrationEndpoint(path);
    out[label] = { ok, status, data };
    //console.log(`[LimoExpress] ${label} (${path}) — status: ${status}`, JSON.stringify(data, null, 2));
  }
  return out;
}

/**
 * Get list of items from an integration endpoint response.
 * Handles data as array or as { data: [] } / { items: [] }.
 */
function getIntegrationList(integrationEntry) {
  if (!integrationEntry?.ok || integrationEntry.data == null) return [];
  const d = integrationEntry.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.data)) return d.data;
  if (Array.isArray(d.items)) return d.items;
  return [];
}

/** Return true if string looks like a UUID. */
function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
}

/**
 * Extract booking_type_id, booking_status_id, vehicle_id, vehicle_class_id, currency_id, client_id, payment_method_id, user_id (driver)
 * from integration data by matching parsed description fields (names → IDs).
 * Client Id: use "Client Id" value or UUID. Driver: "Driver" sets assigned driver (user_id) by name or numeric id; also used as client fallback.
 */
function extractIdsFromIntegrationData(integrationData, descriptionParsed) {
  const result = {
    booking_type_id: null,
    booking_status_id: null,
    vehicle_id: null,
    vehicle_class_id: null,
    currency_id: null,
    client_id: null,
    payment_method_id: null,
    user_id: null,
  };
  if (!descriptionParsed || typeof descriptionParsed !== 'object' || descriptionParsed.raw !== undefined) return result;

  const bookingTypeValue = (descriptionParsed.booking_type_id || '').trim();
  const bookingStatusValue = (descriptionParsed.booking_status_id || '').trim();
  const driver = (descriptionParsed.driver || descriptionParsed.driver_id || '').trim();
  const vehicleName = (descriptionParsed.vehicle || '').trim();
  const vehicleClassName = (descriptionParsed.vehicle_class || '').trim();
  const currencyCode = (descriptionParsed.currency || '').trim();

  const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const includes = (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase());

  // Booking Type: use UUID as-is or match by name/title
  if (bookingTypeValue) {
    if (isUuid(bookingTypeValue)) {
      result.booking_type_id = bookingTypeValue;
    } else {
      const bookingTypes = getIntegrationList(integrationData['Booking types']);
      for (const bt of bookingTypes) {
        const name = bt.name || bt.title || '';
        if (same(name, bookingTypeValue) || includes(name, bookingTypeValue) || includes(bookingTypeValue, name)) {
          result.booking_type_id = bt.id;
          break;
        }
      }
    }
  }

  // Booking Status: use UUID as-is or match by name/title
  if (bookingStatusValue) {
    if (isUuid(bookingStatusValue)) {
      result.booking_status_id = bookingStatusValue;
    } else {
      const bookingStatuses = getIntegrationList(integrationData['Booking statuses']);
      for (const bs of bookingStatuses) {
        const name = bs.name || bs.title || '';
        if (same(name, bookingStatusValue) || includes(name, bookingStatusValue) || includes(bookingStatusValue, name)) {
          result.booking_status_id = bs.id;
          break;
        }
      }
    }
  }

  // Client Id: use UUID as-is or match by client name / company_id from integrated Clients; else match Driver name → client
  const clientValue = (descriptionParsed.client_id || '').trim();
  const searchByClientOrDriver = (searchStr) => {
    if (!searchStr) return null;
    const clients = getIntegrationList(integrationData['Clients']);
    for (const c of clients) {
      const clientName = c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.display_name || '';
      const companyId = (c.company_id != null && c.company_id !== '') ? String(c.company_id).trim() : '';
      const matchName = clientName && (same(clientName, searchStr) || includes(clientName, searchStr) || includes(searchStr, clientName));
      const matchCompany = companyId && (same(companyId, searchStr) || includes(companyId, searchStr) || includes(searchStr, companyId));
      if (matchName || matchCompany) return c.id;
    }
    return null;
  };
  if (clientValue) {
    if (isUuid(clientValue)) {
      result.client_id = clientValue;
    } else {
      result.client_id = searchByClientOrDriver(clientValue);
    }
  } else if (driver) {
    result.client_id = searchByClientOrDriver(driver);
  }

  // Vehicle: match by name, registration_number, or plate
  const vehicles = getIntegrationList(integrationData['Vehicle']);
  for (const v of vehicles) {
    const name = v.name || v.registration_number || v.registrationNumber || v.plate || v.number || '';
    if (same(name, vehicleName) || includes(name, vehicleName) || includes(vehicleName, name)) {
      result.vehicle_id = v.id;
      break;
    }
  }

  // Vehicle Class: match by name
  const vehicleClasses = getIntegrationList(integrationData['Vehicle classes']);
  for (const vc of vehicleClasses) {
    const name = vc.name || vc.title || '';
    if (same(name, vehicleClassName) || includes(name, vehicleClassName)) {
      result.vehicle_class_id = vc.id;
      break;
    }
  }

  // Currency: match by code, iso_code, or symbol
  const currencies = getIntegrationList(integrationData['Currencies']);
  for (const c of currencies) {
    const code = c.code || c.iso_code || c.isoCode || c.symbol || '';
    if (same(code, currencyCode)) {
      result.currency_id = c.id;
      break;
    }
  }

  // Payment Method: use UUID as-is or match by name
  const paymentMethodValue = (descriptionParsed.payment_method_id || descriptionParsed.payment_method || '').trim();
  if (paymentMethodValue) {
    if (isUuid(paymentMethodValue)) {
      result.payment_method_id = paymentMethodValue;
    } else {
      const paymentMethods = getIntegrationList(integrationData['Payment methods']);
      for (const pm of paymentMethods) {
        const name = pm.name || pm.title || '';
        if (same(name, paymentMethodValue) || includes(name, paymentMethodValue) || includes(paymentMethodValue, name)) {
          result.payment_method_id = pm.id;
          break;
        }
      }
    }
  }

  // Driver (assigned driver): user_id by numeric id or match by name/email from Users list
  if (driver) {
    const driverNum = /^\d+$/.test(driver) ? parseInt(driver, 10) : null;
    if (driverNum != null) {
      result.user_id = driverNum;
    } else {
      const users = getIntegrationList(integrationData['Users']);
      for (const u of users) {
        const uid = u.id != null ? u.id : u.user_id;
        const name = (u.name || [u.first_name, u.last_name].filter(Boolean).join(' ') || '').trim();
        const email = (u.email || '').trim();
        const matchName = name && (same(name, driver) || includes(name, driver) || includes(driver, name));
        const matchEmail = email && (same(email, driver) || includes(email, driver) || includes(driver, email));
        if (matchName || matchEmail) {
          result.user_id = typeof uid === 'number' ? uid : (typeof uid === 'string' && /^\d+$/.test(uid) ? parseInt(uid, 10) : uid);
          break;
        }
      }
    }
  }

  return result;
}

/** Format ISO date-time to LimoExpress "YYYY-MM-DD HH:mm:ss" */
function formatDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

/** Format ISO date-time to app API "DD-MM-YYYY HH:mm" */
function formatPickupTimeApp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const day = String(d.getDate()).padStart(2, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const y = d.getFullYear();
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${day}-${m}-${y} ${h}:${min}`;
}

/** POST /api/available-user/{userId} to mark driver as available for the driving slot (optional, same auth). */
async function setDriverAvailableForDriving(userId, drivingId, pickupTimeApp, expectedDropOffTimeApp) {
  if (userId == null || drivingId == null) return { ok: false };
  const url = `${baseUrl}/api/available-user/${userId}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: getAuthHeader() },
      body: JSON.stringify({
        id: typeof userId === 'number' ? userId : parseInt(String(userId), 10),
        pickupTime: pickupTimeApp || '',
        expectedDropOffTime: expectedDropOffTimeApp || '',
        driving_id: typeof drivingId === 'number' ? drivingId : parseInt(String(drivingId), 10),
      }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** GET /api/driving?from=&to= and return array of drivings. Uses same auth as integration. */
async function fetchDrivingList(timeMin, timeMax) {
  const from = (timeMin instanceof Date ? timeMin : new Date(timeMin)).toISOString();
  const to = (timeMax instanceof Date ? timeMax : new Date(timeMax)).toISOString();
  const url = `${baseUrl}/api/driving?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: getAuthHeader() },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) return { ok: false, status: res.status, data, list: [] };
  const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.data?.data) ? data.data.data : []));
  return { ok: true, data, list };
}

/**
 * Find the driving that corresponds to the just-created booking. Match by pickup time (app format DD-MM-YYYY HH:mm)
 * or by created.id / created.number if the list item has uuid or number.
 */
function findDrivingForCreatedBooking(drivingList, event, created) {
  const pickupIso = event.start?.dateTime || event.start?.date;
  const pickupApp = pickupIso ? formatPickupTimeApp(pickupIso) : '';
  const createdId = created?.id;
  const createdNumber = created?.number;
  for (const d of drivingList) {
    if (createdId != null && (d.id === createdId || d.uuid === createdId || String(d.id) === String(createdId))) return d;
    if (createdNumber != null && (d.number === createdNumber || String(d.number) === String(createdNumber))) return d;
    const drvPickup = d.pickup_time || d.start || d.pickupTime || '';
    const drvPickupNorm = typeof drvPickup === 'string' ? drvPickup.trim() : (drvPickup ? formatPickupTimeApp(drvPickup) : '');
    if (pickupApp && drvPickupNorm && (drvPickupNorm === pickupApp || drvPickupNorm.replace(/\s+/g, ' ').indexOf(pickupApp) === 0)) return d;
  }
  return null;
}

/**
 * Parse HTML event description into structured fields.
 * Splits by line (<br> or newline); each line is "Label: value". Values are kept intact
 * (commas inside a value are not used to split).
 *
 * Example description (labels with spaces, no underscores).
 * Booking Type Id / Booking Status Id: use name (e.g. "One Way", "Confirmed") or UUID; names are resolved to IDs from the API.
 *   From Location: 123 Main St, City
 *   To Location: Airport Terminal 2
 *   Pickup Time: 2025-03-10 09:00:00
 *   Expected Drop Off Time: 2025-03-10 10:30:00
 *   Note: Dispatcher note here
 *   Note For Driver: Call on arrival, gate code 4567
 *   Passenger Count: 2
 *   Driver: John Smith
 *   Vehicle: Mercedes V-Class
 *   Vehicle Class: Business
 *   Currency: EUR
 */
function parseEventDescription(html) {
  if (!html || typeof html !== 'string') return {};
  const withNewlines = html.replace(/<br\s*\/?>/gi, '\n');
  let text = withNewlines.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // Longer labels first so "Note For Driver" matches before "Note", "From Location" before "From"
  const labelNames = [
    'Booking Type Id', 'Booking Status Id', 'Client Id', 'Driver Id', 'Payment Method Id', 'Payment Method',
    'From Location', 'To Location', 'Pickup Time', 'Expected Drop Off Time', 'Expected Comeback Time',
    'Note For Driver', 'Note', 'Passenger Count', 'Passenger Email', 'Passenger Phone', 'Email', 'Phone',
    'From', 'To', 'Driver Note', 'Driver', 'Vehicle', 'Vehicle Class', 'Currency', 'Description',
    'Flight Number', 'Baby Seat Count', 'Suitcase Count', 'Waiting Board Text', 'Num Of Waiting Hours',
    'Price', 'Price For Waiting', 'Price Type', 'Commission Amount', 'VAT Percentage', 'Distance', 'Duration',
    'Paid', 'Confirmed', 'Round Trip',
  ];
  // When description has no newlines (e.g. "CityTo Location: Airport"), split on each label so each field parses correctly
  const labelNamesLongestFirst = [...labelNames].sort((a, b) => b.length - a.length);
  for (const label of labelNamesLongestFirst) {
    const re = new RegExp(`(${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}):\\s*`, 'gi');
    text = text.replace(re, '\n$1: ');
  }
  text = text.replace(/^\n+/, '').trim();
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const result = {};
  for (const line of lines) {
    for (const label of labelNames) {
      const prefix = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`, 'i');
      const match = line.match(prefix);
      if (match) {
        const value = line.slice(match[0].length).replace(/,+\s*$/, '').trim();
        const key = label.toLowerCase().replace(/\s+/g, '_');
        result[key] = value;
        break;
      }
    }
  }
  const keys = [
    'booking_type_id', 'booking_status_id', 'client_id', 'driver_id', 'payment_method_id', 'payment_method',
    'from_location', 'to_location', 'pickup_time', 'expected_drop_off_time', 'expected_comeback_time',
    'note_for_driver', 'note', 'passenger_count', 'passenger_email', 'passenger_phone', 'email', 'phone',
    'from', 'to', 'driver_note', 'driver', 'vehicle', 'vehicle_class', 'currency', 'description',
    'flight_number', 'baby_seat_count', 'suitcase_count', 'waiting_board_text', 'num_of_waiting_hours',
    'price', 'price_for_waiting', 'price_type', 'commission_amount', 'vat_percentage', 'distance', 'duration',
    'paid', 'confirmed', 'round_trip',
  ];
  const out = {};
  for (const k of keys) if (result[k] !== undefined) out[k] = result[k];
  return Object.keys(out).length ? out : { raw: text || html };
}

/**
 * Build a comma-separated string of description fields.
 * Commas separate fields only; commas inside a field value are preserved.
 */
function descriptionToCommaSeparated(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.raw !== undefined) {
    return typeof parsed === 'object' && parsed.raw ? parsed.raw : '';
  }
  const labels = {
    booking_type_id: 'Booking Type Id',
    booking_status_id: 'Booking Status Id',
    client_id: 'Client Id',
    payment_method_id: 'Payment Method Id',
    payment_method: 'Payment Method',
    from_location: 'From Location',
    to_location: 'To Location',
    pickup_time: 'Pickup Time',
    expected_drop_off_time: 'Expected Drop Off Time',
    expected_comeback_time: 'Expected Comeback Time',
    note_for_driver: 'Note For Driver',
    note: 'Note',
    passenger_count: 'Passenger Count',
    passenger_email: 'Passenger Email',
    passenger_phone: 'Passenger Phone',
    from: 'From',
    to: 'To',
    driver_note: 'Driver Note',
    driver: 'Driver',
    vehicle: 'Vehicle',
    vehicle_class: 'Vehicle Class',
    currency: 'Currency',
    description: 'Description',
    flight_number: 'Flight Number',
    baby_seat_count: 'Baby Seat Count',
    suitcase_count: 'Suitcase Count',
    waiting_board_text: 'Waiting Board Text',
    num_of_waiting_hours: 'Num Of Waiting Hours',
    price: 'Price',
    price_for_waiting: 'Price For Waiting',
    price_type: 'Price Type',
    commission_amount: 'Commission Amount',
    vat_percentage: 'VAT Percentage',
    distance: 'Distance',
    duration: 'Duration',
    paid: 'Paid',
    confirmed: 'Confirmed',
    round_trip: 'Round Trip',
  };
  return Object.entries(labels)
    .filter(([key]) => parsed[key] != null && parsed[key] !== '')
    .map(([key, label]) => `${label}: ${parsed[key]}`)
    .join(', ');
}

/**
 * Format a Google Calendar event into a clean JSON object for logging.
 * Parses the HTML description into structured fields and adds a comma-separated
 * string (fields separated by comma; description text values not split by comma).
 */
function formatCalendarEvent(event) {
  const descriptionParsed = parseEventDescription(event.description);
  const formatted = {
    id: event.id,
    summary: event.summary,
    status: event.status,
    created: event.created,
    updated: event.updated,
    start: event.start,
    end: event.end,
    location: event.location,
    creator: event.creator?.email ?? null,
    organizer: event.organizer?.email ?? null,
    description_parsed: descriptionParsed,
    description_formatted: descriptionToCommaSeparated(descriptionParsed),
  };
  return formatted;
}

/** Convert HTML to plain text, preserving line breaks (<br> → newline). */
function htmlToPlainText(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

/** Build location object from address string (no geocoding; coordinates 0,0 if unknown). */
function toLocationObject(address, defaultName = 'Pickup') {
  const name = (address || defaultName).slice(0, 255);
  return {
    name,
    full_address: address || name,
    coordinates: { lat: 0, lng: 0 },
  };
}

/** Parse numeric value from string; returns undefined if not a valid number. */
function parseNum(s) {
  if (s == null || s === '') return undefined;
  const v = Number(String(s).trim());
  return Number.isNaN(v) ? undefined : v;
}

/** Parse boolean from string (true/1/yes vs false/0/no). */
function parseBool(s) {
  if (s == null || s === '') return undefined;
  const v = String(s).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  return undefined;
}

/**
 * Build LimoExpress create-booking payload from a Google Calendar event.
 * Required by API: booking_type_id, from_location, pickup_time.
 * All optional API fields are included when we have values (from description or event).
 */
function eventToBookingPayload(event) {
  const pickupTime = event.start?.dateTime || event.start?.date;
  const dropOffTime = event.end?.dateTime || event.end?.date;
  const location = (event.location || '').trim();
  const descriptionParsed = parseEventDescription(event.description);
  const p = descriptionParsed || {};
  const [fromAddress, toAddressFromLocation] = location.includes(' to ')
    ? location.split(' to ').map((s) => s.trim())
    : [location || 'Address not specified', ''];
  const toAddressRaw =
    (p.to_location || p.to || '').trim() || toAddressFromLocation || '';
  const fromAddressFinal =
    (p.from_location || p.from || '').trim() || fromAddress || 'Address not specified';
  const from_location = toLocationObject(fromAddressFinal, 'Pickup');
  const to_location = toAddressRaw ? toLocationObject(toAddressRaw, 'Drop-off') : null;

  const defaultNote = (() => {
    const header = `From Google Calendar: ${event.summary || 'Event'}`;
    const plainDesc = htmlToPlainText(event.description);
    const body = plainDesc ? `${header}\n${plainDesc}` : header;
    return body.slice(0, 500);
  })();

  const noteForDriver = (p.note_for_driver || p.driver_note || '').trim();
  const passengerCountNum = parseNum(p.passenger_count);
  const passenger_count = passengerCountNum != null && passengerCountNum >= 1 ? Math.round(passengerCountNum) : 1;

  // Primary passenger: from event summary + creator/organizer email + description Phone/Email
  const summaryParts = (event.summary || 'Guest').split(/\s+/).filter(Boolean);
  const passengerEmail = (p.passenger_email || p.email || '').trim() || event.creator?.email || event.organizer?.email || null;
  const passengerPhone = (p.passenger_phone || p.phone || '').trim() || null;
  const passengers = [
    {
      first_name: summaryParts[0] || 'Guest',
      last_name: summaryParts.slice(1).join(' ') || 'Calendar',
      ...(passengerEmail && { email: passengerEmail }),
      ...(passengerPhone && { phone: passengerPhone }),
    },
  ];

  // Build payload: prefer calendar event start/end so the booking appears on the correct date in LimoExpress.
  // Description pickup_time/expected_drop_off_time are fallbacks only (e.g. when event has no dateTime).
  const pickupTimeStr = formatDateTime(pickupTime) || (p.pickup_time || '').trim() || null;
  const expectedDropOffStr = (dropOffTime ? formatDateTime(dropOffTime) : null) || (p.expected_drop_off_time || '').trim() || null;
  const expectedComebackStr = (p.expected_comeback_time || '').trim() || null;
  const note = (p.note || '').trim() || defaultNote;
  
  // Extract flight number - only take the flight code (2-3 letters + 3-4 digits, e.g., "EZY8339")
  // This prevents capturing extra text like "EZY8339 Number of passengers: 2..."
  let flightNumber = (p.flight_number || '').trim() || null;
  if (flightNumber) {
    // Match flight number pattern: 2-3 letters followed by 3-4 digits (e.g., EZY8339, AA123, BA1234)
    const flightMatch = flightNumber.match(/^([A-Z]{2,3}\d{3,4})/i);
    if (flightMatch) {
      flightNumber = flightMatch[1].toUpperCase();
    } else {
      // If no match, try to extract just the first word/token (in case format is different)
      const firstToken = flightNumber.split(/\s+/)[0];
      if (firstToken && firstToken.length <= 10) {
        flightNumber = firstToken.toUpperCase();
      } else {
        // If still too long, set to null to avoid validation errors
        flightNumber = null;
      }
    }
  }
  const waitingBoardText = (p.waiting_board_text || '').trim() || null;
  const priceVal = parseNum(p.price);
  const priceForWaitingVal = parseNum(p.price_for_waiting);
  const priceTypeStr = (p.price_type || '').trim().toUpperCase();
  const priceType = (priceTypeStr === 'NET' || priceTypeStr === 'GROSS') ? priceTypeStr : null;
  const commissionVal = parseNum(p.commission_amount);
  const vatVal = parseNum(p.vat_percentage);
  const distanceVal = parseNum(p.distance);
  const durationStr = (p.duration || '').trim() || null;
  const paidVal = parseBool(p.paid);
  const confirmedVal = parseBool(p.confirmed);
  const roundTripVal = parseBool(p.round_trip);
  const babySeatVal = parseNum(p.baby_seat_count);
  const suitcaseVal = parseNum(p.suitcase_count);
  const numWaitingHoursVal = parseNum(p.num_of_waiting_hours);

  const payload = {
    booking_type_id: bookingTypeId,
    booking_status_id: '7366f352-928e-43e9-8df0-217913b7177b',
    from_location,
    pickup_time: pickupTimeStr,
    note,
    passenger_count,
    passengers,
  };

  if (to_location) payload.to_location = to_location;
  if (expectedDropOffStr) payload.expected_drop_off_time = expectedDropOffStr;
  if (expectedComebackStr) payload.expected_comeback_time = expectedComebackStr;
  if (noteForDriver) payload.note_for_driver = noteForDriver;
  if (flightNumber) payload.flight_number = flightNumber;
  if (waitingBoardText) payload.waiting_board_text = waitingBoardText;
  if (priceVal != null) payload.price = priceVal;
  if (priceForWaitingVal != null) payload.price_for_waiting = priceForWaitingVal;
  if (priceType) payload.price_type = priceType;
  if (commissionVal != null) payload.commission_amount = commissionVal;
  if (vatVal != null) payload.vat_percentage = vatVal;
  if (distanceVal != null) payload.distance = distanceVal;
  if (durationStr) payload.duration = durationStr;
  if (paidVal !== undefined) payload.paid = paidVal;
  if (confirmedVal !== undefined) payload.confirmed = confirmedVal;
  if (roundTripVal !== undefined) payload.round_trip = roundTripVal;
  if (babySeatVal != null) payload.baby_seat_count = Math.max(0, Math.round(babySeatVal));
  if (suitcaseVal != null) payload.suitcase_count = Math.max(0, Math.round(suitcaseVal));
  if (numWaitingHoursVal != null) payload.num_of_waiting_hours = numWaitingHoursVal;

  // vehicle_id, vehicle_class_id, currency_id, client_id, payment_method_id, user_id (driver) are applied in createReservation from extractedIds
  return payload;
}

/**
 * Create a booking in LimoExpress from a calendar event.
 * Uses PUT /api/integration/bookings per LimoExpress API.
 */
async function createReservation(event) {

  console.log('createReservation', event);

  // return true;
  if (!baseUrl || !apiKey) {
    return { success: false, error: 'LIMOEXPRESS_API_URL and LIMOEXPRESS_API_KEY must be set in .env' };
  }
  if (!bookingTypeId) {
    return {
      success: false,
      error: 'LIMOEXPRESS_BOOKING_TYPE_ID must be set in .env (get IDs from GET /api/integration/booking-types)',
    };
  }

  // On new event: format and log Google Calendar event as JSON
  const formattedEvent = formatCalendarEvent(event);
  console.log('[LimoExpress] New event detected — formatted event (JSON):', JSON.stringify(formattedEvent, null, 2));
  console.log('[LimoExpress] Description (comma-separated fields, values intact):', formattedEvent.description_formatted);

  // After format: fetch integration data (booking types, clients, statuses, vehicles, vehicle classes, currencies)
  let integrationData = {};
  try {
    integrationData = await fetchAndLogIntegrationData();
    console.log('[LimoExpress] Integration data fetched:', JSON.stringify(integrationData, null, 2));
  } catch (err) {
    console.error('[LimoExpress] Failed to fetch integration data:', err.message);
  }

  // Extract IDs by matching parsed description (Booking Type, Booking Status, Driver→Client, Vehicle, Vehicle Class, Currency)
  const extractedIds = extractIdsFromIntegrationData(integrationData, formattedEvent.description_parsed);
  console.log('[LimoExpress] Extracted IDs:', JSON.stringify(extractedIds, null, 2));

  const payload = eventToBookingPayload(event);
  if (!payload.pickup_time) {
    console.error('[LimoExpress] Cannot create booking: event has no start date/time (pickup_time is required by API).');
    return { success: false, error: 'Event has no start date/time; pickup_time is required.' };
  }
  if (extractedIds.booking_type_id) payload.booking_type_id = extractedIds.booking_type_id;
  if (extractedIds.booking_status_id) payload.booking_status_id = extractedIds.booking_status_id;
  if (extractedIds.vehicle_id) payload.vehicle_id = extractedIds.vehicle_id;
  if (extractedIds.vehicle_class_id) payload.vehicle_class_id = extractedIds.vehicle_class_id;
  if (extractedIds.currency_id) payload.currency_id = extractedIds.currency_id;
  if (extractedIds.client_id) payload.client_id = extractedIds.client_id;
  if (extractedIds.payment_method_id) payload.payment_method_id = extractedIds.payment_method_id;
  if (extractedIds.user_id != null) payload.user_id = extractedIds.user_id;

  console.log('[LimoExpress] Payload:', payload);
  // return true;

  const url = `${baseUrl}/api/integration/bookings`;
  const authHeader = getAuthHeader();

  console.log(`[LimoExpress] Creating booking: "${event.summary || '(no title)'}" (${payload.pickup_time})`);
  console.log(`[LimoExpress] PUT ${url}`);

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    console.log('[LimoExpress] Create reservation API response:', JSON.stringify({ status: res.status, data }, null, 2));

    if (!res.ok) {
      console.error(`[LimoExpress] API error ${res.status}:`, data?.message || data?.error || res.statusText);
      if (data && (data.message || data.error || data.raw)) console.error(`[LimoExpress] Response:`, data);
      return { success: false, error: data?.message || data?.error || res.statusText, data };
    }

    const created = data?.data;
    const createdId = created?.id;
    const createdNumber = created?.number;
    const createdPickup = created?.pickup_time || payload.pickup_time;
    console.log(`[LimoExpress] Booking created successfully (id: ${createdId}, number: ${createdNumber}, pickup: ${createdPickup})`);

    // Verify booking appears in GET /api/integration/bookings for the pickup date (per API docs)
    if (createdId && createdPickup) {
      const pickupDateStr = String(createdPickup).trim().slice(0, 10); // "YYYY-MM-DD"
      const from = `${pickupDateStr} 00:00:00`;
      const to = `${pickupDateStr} 23:59:59`;
      const listRes = await fetchBookings({ pickup_date_from: from, pickup_date_to: to, per_page: 50 });
      const list = getIntegrationList({ ok: listRes.ok, data: listRes.data });
      const found = list.some((b) => b.id === createdId || b.number === createdNumber || String(b.id) === String(createdId));
      if (found) {
        console.log(`[LimoExpress] Verified: booking appears in GET /api/integration/bookings for ${pickupDateStr}`);
      } else {
        console.log(`[LimoExpress] Note: booking not found in GET bookings for ${pickupDateStr} (list had ${list.length} item(s)); check date range in LimoExpress.`);
      }
    }

    return { success: true, data };
  } catch (err) {
    console.error('[LimoExpress] Create reservation API error (network/exception):', err.message);
    return { success: false, error: err.message };
  }
}

/** Legacy name for compatibility. */
function eventToReservation(event) {
  return eventToBookingPayload(event);
}

module.exports = {
  createReservation,
  eventToReservation,
  eventToBookingPayload,
  fetchAndLogIntegrationData,
  fetchBookings,
  formatCalendarEvent,
  parseEventDescription,
  descriptionToCommaSeparated,
  extractIdsFromIntegrationData,
  getIntegrationList,
};
