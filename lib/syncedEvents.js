const fs = require('fs');
const path = require('path');

const filePath = path.join(process.cwd(), 'syncedEvents.json');

function load() {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function isSynced(calendarId, eventId) {
  const data = load();
  const key = `${calendarId}:${eventId}`;
  return !!data[key];
}

function markSynced(calendarId, eventId) {
  const data = load();
  data[`${calendarId}:${eventId}`] = Date.now();
  // Remove failure tracking if it exists
  delete data[`${calendarId}:${eventId}:failures`];
  save(data);
}

function getFailureCount(calendarId, eventId) {
  const data = load();
  const key = `${calendarId}:${eventId}:failures`;
  return data[key] || 0;
}

function incrementFailureCount(calendarId, eventId) {
  const data = load();
  const key = `${calendarId}:${eventId}:failures`;
  data[key] = (data[key] || 0) + 1;
  save(data);
  return data[key];
}

module.exports = {
  load,
  save,
  isSynced,
  markSynced,
  getFailureCount,
  incrementFailureCount,
};
