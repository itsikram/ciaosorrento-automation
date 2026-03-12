require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { google } = require('googleapis');
const { syncCalendarToLimoExpress } = require('./lib/sync');
const calendar = require('./lib/calendar');
const config = require('./lib/config');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Configure EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Config management functions
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading config:', err);
    return {};
  }
}

function writeConfig(data) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  config.clearCache(); // Clear cache after saving
}

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Server is running', automation: 'Google Calendar → LimoExpress' });
});

// Configuration page - GET
app.get('/credentials', (req, res) => {
  const saved = readConfig();
  res.render('credentials', {
    title: 'Configuration',
    success: req.query.saved === '1',
    error: req.query.error || null,
    tokenGenerated: req.query.tokenGenerated === '1',
    tokenError: req.query.tokenError || null,
    GOOGLE_CREDENTIALS_JSON: saved.GOOGLE_CREDENTIALS_JSON || '',
    GOOGLE_CREDENTIALS_PATH: saved.GOOGLE_CREDENTIALS_PATH || '',
    GOOGLE_TOKEN_JSON: saved.GOOGLE_TOKEN_JSON || '',
    GOOGLE_CALENDAR_ID: saved.GOOGLE_CALENDAR_ID || '',
    CALENDAR_POLL_MINUTES: saved.CALENDAR_POLL_MINUTES || '',
    LIMOEXPRESS_API_URL: saved.LIMOEXPRESS_API_URL || '',
    LIMOEXPRESS_API_KEY: saved.LIMOEXPRESS_API_KEY ? '••••••••' : '',
    LIMOEXPRESS_BOOKING_TYPE_ID: saved.LIMOEXPRESS_BOOKING_TYPE_ID || ''
  });
});

// Configuration save - POST
app.post('/credentials', (req, res) => {
  const existing = readConfig();
  const newConfig = { ...existing };

  // Only update fields that are provided (not empty)
  const fields = [
    'GOOGLE_CREDENTIALS_JSON',
    'GOOGLE_CREDENTIALS_PATH',
    'GOOGLE_TOKEN_JSON',
    'GOOGLE_CALENDAR_ID',
    'CALENDAR_POLL_MINUTES',
    'LIMOEXPRESS_API_URL',
    'LIMOEXPRESS_API_KEY',
    'LIMOEXPRESS_BOOKING_TYPE_ID'
  ];

  fields.forEach(field => {
    const value = req.body[field];
    if (value !== undefined) {
      if (field === 'LIMOEXPRESS_API_KEY' && value === '••••••••') {
        // Don't update if it's the placeholder
        return;
      }
      if (value && value.trim() !== '') {
        // Validate JSON fields
        if (field === 'GOOGLE_CREDENTIALS_JSON' || field === 'GOOGLE_TOKEN_JSON') {
          try {
            JSON.parse(value.trim());
            newConfig[field] = value.trim();
          } catch (err) {
            return res.redirect('/credentials?error=' + encodeURIComponent(`${field} is not valid JSON: ${err.message}`));
          }
        } else {
          newConfig[field] = value.trim();
        }
      } else {
        // Remove field if empty (use env instead)
        delete newConfig[field];
      }
    }
  });

  // Validate required fields
  if (!newConfig.GOOGLE_CREDENTIALS_JSON && !newConfig.GOOGLE_CREDENTIALS_PATH) {
    if (!process.env.GOOGLE_CREDENTIALS_JSON && !process.env.GOOGLE_CREDENTIALS_PATH) {
      return res.redirect('/credentials?error=' + encodeURIComponent('Either GOOGLE_CREDENTIALS_JSON or GOOGLE_CREDENTIALS_PATH is required'));
    }
  }

  if (!newConfig.LIMOEXPRESS_API_URL && !process.env.LIMOEXPRESS_API_URL) {
    return res.redirect('/credentials?error=' + encodeURIComponent('LIMOEXPRESS_API_URL is required'));
  }

  if (!newConfig.LIMOEXPRESS_API_KEY && !process.env.LIMOEXPRESS_API_KEY) {
    return res.redirect('/credentials?error=' + encodeURIComponent('LIMOEXPRESS_API_KEY is required'));
  }

  newConfig.updated_at = new Date().toISOString();

  try {
    writeConfig(newConfig);
    res.redirect('/credentials?saved=1');
  } catch (err) {
    res.redirect('/credentials?error=' + encodeURIComponent(err.message || 'Failed to save configuration'));
  }
});

// Store OAuth client for token generation (temporary)
let pendingOAuthClient = null;

// Token generation endpoint - returns auth URL
app.post('/auth/generate-token', async (req, res) => {
  const { GOOGLE_CREDENTIALS_JSON, GOOGLE_CREDENTIALS_PATH } = req.body;
  
  let credentials;
  try {
    // Priority 1: Use provided credentials from request body
    if (GOOGLE_CREDENTIALS_JSON) {
      credentials = JSON.parse(GOOGLE_CREDENTIALS_JSON);
    } else if (GOOGLE_CREDENTIALS_PATH) {
      const credPath = path.isAbsolute(GOOGLE_CREDENTIALS_PATH) 
        ? GOOGLE_CREDENTIALS_PATH 
        : path.join(__dirname, GOOGLE_CREDENTIALS_PATH);
      if (!fs.existsSync(credPath)) {
        return res.json({ success: false, error: `Credentials file not found: ${credPath}` });
      }
      credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    } else {
      // Priority 2: Check environment variables first (most secure)
      if (process.env.GOOGLE_CREDENTIALS_JSON) {
        credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
      } else if (process.env.GOOGLE_CREDENTIALS_PATH) {
        const credPath = path.isAbsolute(process.env.GOOGLE_CREDENTIALS_PATH)
          ? process.env.GOOGLE_CREDENTIALS_PATH
          : path.join(__dirname, process.env.GOOGLE_CREDENTIALS_PATH);
        if (fs.existsSync(credPath)) {
          credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        }
      } else {
        // Priority 3: Try to load from config file
        const configData = readConfig();
        if (configData.GOOGLE_CREDENTIALS_JSON) {
          credentials = JSON.parse(configData.GOOGLE_CREDENTIALS_JSON);
        } else if (configData.GOOGLE_CREDENTIALS_PATH) {
          const credPath = path.isAbsolute(configData.GOOGLE_CREDENTIALS_PATH)
            ? configData.GOOGLE_CREDENTIALS_PATH
            : path.join(__dirname, configData.GOOGLE_CREDENTIALS_PATH);
          if (fs.existsSync(credPath)) {
            credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
          }
        }
        
        // Priority 4: Fallback to default path
        if (!credentials) {
          const defaultPath = path.join(__dirname, 'credentials.json');
          if (fs.existsSync(defaultPath)) {
            credentials = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
          }
        }
      }
    }

    if (!credentials) {
      return res.json({ success: false, error: 'No credentials found. Please provide GOOGLE_CREDENTIALS_JSON or GOOGLE_CREDENTIALS_PATH.' });
    }

    const creds = credentials.installed || credentials.web;
    if (!creds || !creds.client_id || !creds.client_secret) {
      return res.json({ success: false, error: 'Invalid credentials format. Expected installed or web object with client_id and client_secret.' });
    }

    // Determine redirect URI based on request or environment
    // Priority: 1) OAUTH_REDIRECT_URI env var, 2) Request host, 3) Environment detection
    let REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;
    if (!REDIRECT_URI) {
      // Try to detect from request headers (works for both local and production)
      const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
      const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
      
      // If host contains onrender.com, use https with the exact host
      if (host.includes('onrender.com')) {
        // Use the exact host from the request, but ensure it's https
        const hostname = host.split(':')[0]; // Remove port if present
        REDIRECT_URI = `https://${hostname}/oauth2callback`;
      } else if (host.includes('localhost') || host.includes('127.0.0.1')) {
        REDIRECT_URI = `http://${host}/oauth2callback`;
      } else {
        // Fallback: check environment variables
        const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.BASE_URL;
        if (baseUrl && baseUrl.startsWith('https://')) {
          REDIRECT_URI = `${baseUrl}/oauth2callback`;
        } else if (process.env.NODE_ENV === 'production') {
          // Default production URL for Render.com (must match Google Cloud Console)
          REDIRECT_URI = 'https://ciaosorrento-automation-0h3m.onrender.com/oauth2callback';
        } else {
          REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
        }
      }
    }
    
    // Log the redirect URI being used (for debugging)
    console.log('[OAuth] Using redirect URI:', REDIRECT_URI);
    
    const oauth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);
    
    // Store client temporarily for callback
    pendingOAuthClient = oauth2Client;

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: calendar.SCOPES,
      prompt: 'consent',
      redirect_uri: REDIRECT_URI,
    });

    res.json({ 
      success: true, 
      authUrl: authUrl,
      redirectUri: REDIRECT_URI,
      message: 'Open the authUrl in your browser to complete authorization.',
      note: `Using redirect URI: ${REDIRECT_URI}. Make sure this matches exactly what's configured in Google Cloud Console.`
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// OAuth callback handler - supports both /oauth2callback and /auth/oauth2callback for compatibility
const handleOAuthCallback = async (req, res) => {
  if (!pendingOAuthClient) {
    return res.status(400).send('<html><body><h1>Error</h1><p>No pending OAuth request. Please start token generation from the credentials page.</p></body></html>');
  }

  const code = req.query.code;
  if (!code) {
    return res.status(400).send('<html><body><h1>Error</h1><p>No authorization code received.</p></body></html>');
  }

  try {
    const { tokens } = await pendingOAuthClient.getToken({ code });
    
    // Save token to config
    const configData = readConfig();
    configData.GOOGLE_TOKEN_JSON = JSON.stringify(tokens);
    writeConfig(configData);
    config.clearCache();

    // Clear pending client
    pendingOAuthClient = null;

    res.send('<html><body><h1>Authorization Successful!</h1><p>The token has been saved. You can close this tab and return to the <a href="/credentials">credentials page</a>.</p></body></html>');
  } catch (err) {
    pendingOAuthClient = null;
    res.status(500).send(`<html><body><h1>Error</h1><p>Failed to get token: ${err.message}</p></body></html>`);
  }
};

// Support both routes for compatibility
app.get('/oauth2callback', handleOAuthCallback);
app.get('/auth/oauth2callback', handleOAuthCallback);

// Google Calendar push notifications hit this URL (must be HTTPS in production).
// Respond 200 immediately, then sync in background.
app.post('/webhook/calendar', (req, res) => {
  const state = req.headers['x-goog-resource-state'];
  const channelId = req.headers['x-goog-channel-id'];

  res.status(200).send();

  if (state === 'sync') {
    console.log('Calendar watch channel synced:', channelId);
    return;
  }
  if (state === 'exists') {
    console.log('[Webhook] Calendar change detected → syncing to LimoExpress...');
    syncCalendarToLimoExpress().then((r) => {
      console.log('[Webhook] Sync done:', r.synced, 'new reservation(s),', r.skipped, 'skipped,', r.errors?.length || 0, 'error(s)');
    }).catch((err) => {
      console.error('[Webhook] Sync error:', err);
    });
  }
});

// Manual trigger: POST /sync to run sync once (e.g. from cron or button).
app.post('/sync', async (req, res) => {
  try {
    const result = await syncCalendarToLimoExpress();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Function to call external API
function callExternalAPI() {
  const apiUrl = 'https://ciaosorrento-automation-0h3m.onrender.com/';
  
  https.get(apiUrl, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      console.log(`[API Call] Successfully called ${apiUrl} - Status: ${res.statusCode}`);
    });
  }).on('error', (err) => {
    console.error(`[API Call] Error calling ${apiUrl}:`, err.message);
  });
}

// Start server
app.listen(PORT, async () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log('Automation: new Google Calendar events → LimoExpress reservations');

  // Set up external API call every 15 minutes
  const apiCallInterval = 15 * 60 * 1000; // 15 minutes in milliseconds
  setInterval(callExternalAPI, apiCallInterval);
  console.log('External API will be called every 15 minutes.');
  callExternalAPI(); // Call immediately on startup

  const webhookBase = process.env.WEBHOOK_BASE_URL;
  const pollMinutes = parseInt(config.getConfigWithDefault('CALENDAR_POLL_MINUTES', '0'), 10) || 0;

  if (webhookBase && webhookBase.startsWith('https://')) {
    try {
      const calendarId = config.getConfigWithDefault('GOOGLE_CALENDAR_ID', 'primary');
      const channel = await calendar.setupWatch(calendarId, webhookBase);
      console.log('Calendar watch active. Channel expires:', new Date(Number(channel.expiration)).toISOString());
    } catch (err) {
      console.warn('Calendar watch setup failed:', err.message);
    }
  } else if (pollMinutes > 0) {
    const run = () => {
      console.log('[Poll] Checking for new calendar events...');
      syncCalendarToLimoExpress().then((r) => {
        if (r.synced > 0 || (r.errors && r.errors.length > 0)) {
          console.log('[Poll] Done:', r.synced, 'new reservation(s),', r.errors?.length || 0, 'error(s)');
        }
      }).catch((e) => console.error('[Poll] Sync error:', e));
    };
    setInterval(run, pollMinutes * 60 * 1000);
    console.log(`Polling calendar every ${pollMinutes} minute(s).`);
    run();
  } else {
    console.log('Tip: Set WEBHOOK_BASE_URL (HTTPS) for push, or CALENDAR_POLL_MINUTES for polling.');
  }
});
