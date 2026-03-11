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
  save(data);
}

module.exports = {
  load,
  save,
  isSynced,
  markSynced,
};
