/**
 * Sync new Google Calendar events to LimoExpress.
 * Lists events in a time window, creates reservation for each not yet synced.
 * Only events marked as "Added to Limo" (see LIMO_SYNC_REQUIRE_FLAG) are sent to LimoExpress.
 */

const calendar = require('./calendar');
const limoexpress = require('./limoexpress');
const syncedEvents = require('./syncedEvents');
const config = require('./config');

const CALENDAR_ID = config.getConfigWithDefault('GOOGLE_CALENDAR_ID', 'primary');
const DAYS_BACK = 1;
const DAYS_FORWARD = 30;

/** If set, event description must contain this phrase (case-insensitive) to be synced to LimoExpress. Empty = sync all. */
const LIMO_SYNC_REQUIRE_FLAG = (process.env.LIMO_SYNC_REQUIRE_FLAG || 'Added to Limo: yes').trim();

/** Maximum number of retry attempts for failed reservations before marking as synced to prevent infinite loops */
const MAX_RETRY_ATTEMPTS = parseInt(process.env.MAX_SYNC_RETRIES || '3', 10);

function isEventReadyForLimo(event) {
  if (!LIMO_SYNC_REQUIRE_FLAG) return true;
  const text = [event.description || '', event.summary || ''].join(' ');
  return text.toLowerCase().includes(LIMO_SYNC_REQUIRE_FLAG.toLowerCase());
}

async function syncCalendarToLimoExpress() {
  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - DAYS_BACK);
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + DAYS_FORWARD);

  let events;
  try {
    events = await calendar.listEventsInRange(CALENDAR_ID, timeMin, timeMax);
  } catch (err) {
    console.error('Calendar list error:', err.message);
    return { synced: 0, errors: [err.message] };
  }

  const results = { synced: 0, skipped: 0, skippedNotReady: 0, errors: [] };
  const newEventCount = events.filter((e) => e.id && !syncedEvents.isSynced(CALENDAR_ID, e.id)).length;
  if (newEventCount > 0) {
    console.log(`[Sync] Found ${events.length} event(s), ${newEventCount} new to sync.`);
  }

  for (const event of events) {
    if (!event.id) continue;
    if (syncedEvents.isSynced(CALENDAR_ID, event.id)) {
      results.skipped++;
      continue;
    }

    // if (!isEventReadyForLimo(event)) {
    //   results.skippedNotReady++;
    //   console.log(`[Sync] Skipping "${event.summary || '(no title)'}" — not added to Limo yet (add "${LIMO_SYNC_REQUIRE_FLAG}" to description to sync).`);
    //   continue;
    // }

    // Check if this event has exceeded max retry attempts
    const failureCount = syncedEvents.getFailureCount(CALENDAR_ID, event.id);
    if (failureCount >= MAX_RETRY_ATTEMPTS) {
      console.log(`[Sync] Skipping "${event.summary || event.id}" — exceeded max retry attempts (${failureCount}/${MAX_RETRY_ATTEMPTS}). Marking as synced to prevent infinite loop.`);
      syncedEvents.markSynced(CALENDAR_ID, event.id);
      results.skipped++;
      continue;
    }

    const start = event.start?.dateTime || event.start?.date || '';
    console.log(`[New event detected] "${event.summary || '(no title)'}" | Start: ${start} | ID: ${event.id}`);

    const result = await limoexpress.createReservation(event);
    if (result.success) {
      syncedEvents.markSynced(CALENDAR_ID, event.id);
      results.synced++;
      console.log(`[Reservation added] "${event.summary || event.id}" → LimoExpress`);
    } else {
      const newFailureCount = syncedEvents.incrementFailureCount(CALENDAR_ID, event.id);
      results.errors.push(`${event.summary || event.id}: ${result.error}`);
      console.error(`[Reservation failed] "${event.summary || event.id}":`, result.error, `(Attempt ${newFailureCount}/${MAX_RETRY_ATTEMPTS})`);
      
      // If exceeded max attempts, mark as synced to prevent infinite loop
      if (newFailureCount >= MAX_RETRY_ATTEMPTS) {
        console.log(`[Sync] Marking "${event.summary || event.id}" as synced after ${newFailureCount} failed attempts to prevent infinite loop.`);
        syncedEvents.markSynced(CALENDAR_ID, event.id);
      }
    }
  }

  if (results.synced > 0 || results.errors.length > 0 || results.skippedNotReady > 0) {
    const parts = [
      `New reservations: ${results.synced}`,
      `skipped (already synced): ${results.skipped}`,
      results.skippedNotReady > 0 ? `skipped (not added to Limo yet): ${results.skippedNotReady}` : null,
      `errors: ${results.errors.length}`,
    ].filter(Boolean);
    console.log(`[Sync complete] ${parts.join(', ')}`);
  }
  return results;
}

module.exports = { syncCalendarToLimoExpress };
