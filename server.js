require('dotenv').config();
const express = require('express');
const { syncCalendarToLimoExpress } = require('./lib/sync');
const calendar = require('./lib/calendar');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'Server is running', automation: 'Google Calendar → LimoExpress' });
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
