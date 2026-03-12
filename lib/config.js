/**
 * Configuration loader: checks frontend-saved data first, then environment variables.
 * Frontend saves to data/config.json, which takes priority over .env
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

let cachedConfig = null;

/**
 * Load config from file (frontend-saved) or return null
 */
function loadConfigFromFile() {
  if (cachedConfig !== null) {
    return cachedConfig;
  }
  
  if (!fs.existsSync(CONFIG_FILE)) {
    cachedConfig = {};
    return cachedConfig;
  }
  
  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf8');
    cachedConfig = JSON.parse(content);
    return cachedConfig;
  } catch (err) {
    console.error('Error reading config file:', err);
    cachedConfig = {};
    return cachedConfig;
  }
}

/**
 * Get a config value: frontend-saved first, then environment variable
 */
function getConfig(key) {
  const fileConfig = loadConfigFromFile();
  // Check frontend-saved config first
  if (fileConfig[key] !== undefined && fileConfig[key] !== null && fileConfig[key] !== '') {
    return fileConfig[key];
  }
  // Fallback to environment variable
  return process.env[key];
}

/**
 * Get config with default value
 */
function getConfigWithDefault(key, defaultValue) {
  const value = getConfig(key);
  return value !== undefined && value !== null && value !== '' ? value : defaultValue;
}

/**
 * Clear cached config (call after saving new config)
 */
function clearCache() {
  cachedConfig = null;
}

module.exports = {
  getConfig,
  getConfigWithDefault,
  loadConfigFromFile,
  clearCache,
  CONFIG_FILE,
};
