const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

// Час (по Москве), после которого раз в сутки приходит сводка. DIGEST_HOUR=off — выключить.
function digestHour(value) {
  if (value === undefined || value === '') return 9;
  if (String(value).toLowerCase() === 'off') return null;
  const hour = Number.parseInt(value, 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('DIGEST_HOUR must be 0-23 or "off"');
  return hour;
}

function resolvePath(value, fallback) {
  return path.resolve(process.cwd(), value || fallback);
}

const config = {
  botToken: required('BOT_TOKEN'),
  groupId: required('GROUP_ID'),
  ownerId: required('OWNER_ID'),
  databasePath: resolvePath(process.env.DATABASE_PATH, './data/soul-hub.sqlite'),
  allowWordsPath: resolvePath(process.env.ALLOW_WORDS_PATH, './config/allow.json'),
  denyWordsPath: resolvePath(process.env.DENY_WORDS_PATH, './config/deny.json'),
  namesCsvPath: resolvePath(process.env.NAMES_CSV_PATH, './data/names.csv'),
  refusalsBeforeBan: positiveInt('REFUSALS_BEFORE_BAN', 4),
  banDays: positiveInt('BAN_DAYS', 7),
  digestHour: digestHour(process.env.DIGEST_HOUR)
};

for (const file of [config.allowWordsPath, config.denyWordsPath]) {
  if (!fs.existsSync(file)) throw new Error(`Configuration file not found: ${file}`);
}
fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

module.exports = config;
