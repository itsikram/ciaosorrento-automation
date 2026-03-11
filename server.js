require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { syncCalendarToLimoExpress } = require('./lib/sync');
const calendar = require('./lib/calendar');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CRED_FILE = path.join(DATA_DIR, 'credentials.json');

// Configure EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Credentials management functions
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readCredentials() {
  ensureDataDir();
  if (!fs.existsSync(CRED_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading credentials:', err);
    return null;
  }
}

function writeCredentials(data) {
  ensureDataDir();
  fs.writeFileSync(CRED_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Server is running', automation: 'Google Calendar → LimoExpress' });
});

// Credentials page - GET
app.get('/credentials', (req, res) => {
  const saved = readCredentials();
  res.render('credentials', {
    title: 'Save Credentials',
    success: req.query.saved === '1',
    error: req.query.error || null,
    client_id: saved?.web?.client_id || saved?.client_id || '',
    client_secret: saved?.web?.client_secret ? '••••••••' : '',
    redirect_uris: saved?.web?.redirect_uris?.join('\n') || '',
    hasSecret: !!(saved?.web?.client_secret || saved?.client_secret)
  });
});

// Credentials save - POST
app.post('/credentials', (req, res) => {
  const { client_id, client_secret, redirect_uris } = req.body;
  
  if (!client_id || !client_id.trim()) {
    return res.redirect('/credentials?error=' + encodeURIComponent('Client ID is required'));
  }

  const existing = readCredentials() || {};
  const web = existing.web || {};
  
  web.client_id = client_id.trim();
  
  // Only update secret if a new one is provided (not the placeholder)
  if (client_secret && client_secret.trim() && client_secret !== '••••••••') {
    web.client_secret = client_secret.trim();
  } else if (!web.client_secret) {
    return res.redirect('/credentials?error=' + encodeURIComponent('Client secret is required'));
  }
  
  if (redirect_uris && redirect_uris.trim()) {
    web.redirect_uris = redirect_uris.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
  } else {
    web.redirect_uris = web.redirect_uris || [];
  }

  const payload = {
    web,
    updated_at: new Date().toISOString()
  };

  try {
    writeCredentials(payload);
    res.redirect('/credentials?saved=1');
  } catch (err) {
    res.redirect('/credentials?error=' + encodeURIComponent(err.message || 'Failed to save credentials'));
  }
});

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

// Start server
app.listen(PORT, async () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log('Automation: new Google Calendar events → LimoExpress reservations');

  const webhookBase = process.env.WEBHOOK_BASE_URL;
  const pollMinutes = parseInt(process.env.CALENDAR_POLL_MINUTES, 10) || 0;

  if (webhookBase && webhookBase.startsWith('https://')) {
    try {
      const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
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
