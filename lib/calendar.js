const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('./config');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

/**
 * Load credentials: from frontend-saved config first, then env, then file.
 */
function loadCredentials() {
  // Check frontend-saved config first
  const credentialsJson = config.getConfig('GOOGLE_CREDENTIALS_JSON');
  if (credentialsJson) {
    try {
      return typeof credentialsJson === 'string' ? JSON.parse(credentialsJson) : credentialsJson;
    } catch (err) {
      console.error('Error parsing GOOGLE_CREDENTIALS_JSON:', err);
    }
  }

  // Check credentials path
  const credentialsPath = config.getConfigWithDefault('GOOGLE_CREDENTIALS_PATH', path.join(process.cwd(), 'credentials.json'));
  const credPath = path.isAbsolute(credentialsPath) ? credentialsPath : path.join(process.cwd(), credentialsPath);
  
  if (fs.existsSync(credPath)) {
    const content = fs.readFileSync(credPath, 'utf8');
    return JSON.parse(content);
  }

  throw new Error(`Credentials not found. Set GOOGLE_CREDENTIALS_JSON or GOOGLE_CREDENTIALS_PATH in frontend config or .env`);
}

/**
 * Load token: from frontend-saved config first, then env, then token.json file.
 */
function loadToken() {
  // Check frontend-saved config first
  const tokenJson = config.getConfig('GOOGLE_TOKEN_JSON');
  if (tokenJson) {
    try {
      return typeof tokenJson === 'string' ? JSON.parse(tokenJson) : tokenJson;
    } catch (err) {
      console.error('Error parsing GOOGLE_TOKEN_JSON:', err);
    }
  }

  // Fallback to token.json file
  const tokenPath = path.join(process.cwd(), 'token.json');
  if (fs.existsSync(tokenPath)) {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  }
  
  return null;
}

/**
 * Load OAuth2 client from credentials and optional saved token.
 * Run auth.js once to get token.json (refresh token), or set GOOGLE_CREDENTIALS_JSON and GOOGLE_TOKEN_JSON in .env.
 */
const DEFAULT_REDIRECT_URI = 'http://localhost:3456/oauth2callback';

function getAuthClient() {
  const credentials = loadCredentials();
  const creds = credentials.installed || credentials.web;
  const redirectUri = (creds.redirect_uris && creds.redirect_uris[0]) || DEFAULT_REDIRECT_URI;
  const oauth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);

  const token = loadToken();
  if (token) {
    oauth2Client.setCredentials(token);
  }

  return oauth2Client;
}

/**
 * Get calendar API client (authenticated).
 */
function getCalendarClient() {
  const auth = getAuthClient();
  return google.calendar({ version: 'v3', auth });
}

/**
 * List events in a time range.
 * @param {string} calendarId - e.g. 'primary'
 * @param {Date} timeMin
 * @param {Date} timeMax
 * @returns {Promise<Array>} events
 */
async function listEventsInRange(calendarId, timeMin, timeMax) {
  const calendar = getCalendarClient();
  const res = await calendar.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return res.data.items || [];
}

/**
 * Set up push notifications (watch) for a calendar.
 * Requires WEBHOOK_BASE_URL to be HTTPS. Returns channel info for renewal.
 */
async function setupWatch(calendarId, webhookBaseUrl) {
  const calendar = getCalendarClient();
  const { v4: uuidv4 } = require('uuid');
  const channelId = uuidv4();
  const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

  const res = await calendar.events.watch({
    calendarId,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: `${webhookBaseUrl.replace(/\/$/, '')}/webhook/calendar`,
      expiration,
    },
  });

  return {
    id: res.data.id,
    resourceId: res.data.resourceId,
    expiration: res.data.expiration,
  };
}

// Export paths for backward compatibility (used by auth.js)
const getCredentialsPath = () => {
  return config.getConfigWithDefault('GOOGLE_CREDENTIALS_PATH', path.join(process.cwd(), 'credentials.json'));
};

const getTokenPath = () => {
  return path.join(process.cwd(), 'token.json');
};

module.exports = {
  getAuthClient,
  getCalendarClient,
  listEventsInRange,
  setupWatch,
  credentialsPath: getCredentialsPath(), // Computed for backward compatibility
  tokenPath: getTokenPath(), // Computed for backward compatibility
  SCOPES,
};
