const fs = require('node:fs');
const { parse } = require('csv-parse/sync');
const { normalize } = require('./text');

function readWordList(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const words = Array.isArray(data) ? data : data.words;
  if (!Array.isArray(words)) throw new Error(`${filePath}: expected { "words": [] }`);
  return [...new Set(words.map(String).map((x) => x.trim()).filter(Boolean))];
}

// Атомарная запись: сначала временный файл, потом переименование — читатель никогда не увидит полфайла.
function writeWordList(filePath, words) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ words }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJson(filePath) {
  return { words: readWordList(filePath) };
}

function readNamesCsv(filePath) {
  if (!fs.existsSync(filePath)) return new Map();
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.trim()) return new Map();
  const rows = parse(content, { bom: true, delimiter: ';', skip_empty_lines: true, relax_column_count: true, trim: true });
  const header = String(rows[0]?.[0] ?? '').trim().toLowerCase();
  const start = ['name', 'имя', 'variant', 'variantname'].includes(header) ? 1 : 0;
  const map = new Map();
  for (const row of rows.slice(start)) {
    const variant = normalize(row[0] ?? '');
    const canonical = normalize(row[1] ?? row[0] ?? '');
    if (variant && canonical) map.set(variant, canonical);
  }
  return map;
}

function loadRules(config) {
  return {
    allow: readJson(config.allowWordsPath),
    deny: readJson(config.denyWordsPath),
    knownNames: readNamesCsv(config.namesCsvPath)
  };
}

// Горячая перезагрузка: при каждом обращении сравниваем время изменения файлов и перечитываем
// только если они изменились. Если новый файл сломан (например, битый JSON при ручной правке),
// остаются прежние правила, а владельцу уходит уведомление.
function createRulesProvider(config, { onError } = {}) {
  const files = [config.allowWordsPath, config.denyWordsPath, config.namesCsvPath];
  const signature = () => files.map((file) => {
    // Время изменения у файловых систем бывает грубым (несколько мс), поэтому добавляем размер.
    try { const stat = fs.statSync(file); return `${stat.mtimeMs}-${stat.size}`; } catch { return 'missing'; }
  }).join(':');

  let rules = loadRules(config); // при старте ошибка должна быть фатальной
  let loadedSignature = signature();

  return {
    get() {
      const current = signature();
      if (current !== loadedSignature) {
        loadedSignature = current;
        try {
          rules = loadRules(config);
          console.log('[rules] словари перезагружены');
        } catch (error) {
          console.error('[rules] не удалось перезагрузить словари, остаются прежние:', error.message);
          if (onError) onError(error);
        }
      }
      return rules;
    }
  };
}

module.exports = { loadRules, readJson, readNamesCsv, readWordList, writeWordList, createRulesProvider };
