function normalize(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}@.+_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Слово = буквы/цифры, у «18+» плюс остаётся частью слова. Дефис, точка, «_», «@» разделяют слова.
const WORD_RE = /[\p{L}\p{N}]+\+?/gu;

function tokens(value = '') {
  return normalize(value).match(WORD_RE) ?? [];
}

// Правила сопоставления слова из словаря со словом из текста:
//  • слово короче 6 букв — только точное совпадение («маг», «таро», «курс», «астро»);
//  • слово от 6 букв — с окончаниями до 3 букв: «психолог» → психолога, психологом, психологов;
//    «психология» → психологии, психологией; «натальн» → натальная, натальные;
//  • слово со звёздочкой в конце («юрист*», «онлайн-школ*») — любое продолжение (префикс).
// Словосочетания и слова через дефис сопоставляются по словам подряд: «арт-терапевт» найдётся
// и в «арт-терапевт», и в «арт терапевта».
const INFLECTION_MIN_LENGTH = 6;
const MAX_ENDING_LENGTH = 3;
const TRAILING_VOWEL = /[аяйьыиеоуюэ]$/u;

function wordMatcher(word, prefix) {
  if (prefix) return (token) => token.startsWith(word);
  if (word.length >= INFLECTION_MIN_LENGTH && /^\p{L}+$/u.test(word)) {
    const stem = TRAILING_VOWEL.test(word) ? word.slice(0, -1) : word;
    return (token) => token.startsWith(stem) && token.length - stem.length <= MAX_ENDING_LENGTH;
  }
  return (token) => token === word;
}

const compiled = new Map();

function compileKeyword(keyword) {
  if (compiled.has(keyword)) return compiled.get(keyword);
  const prefix = keyword.endsWith('*');
  const words = tokens(prefix ? keyword.slice(0, -1) : keyword);
  const matchers = words.map((word, index) => wordMatcher(word, prefix && index === words.length - 1));
  const result = matchers.length ? matchers : null;
  compiled.set(keyword, result);
  return result;
}

function findKeywordMatches(text, keywords = []) {
  const textTokens = tokens(text);
  if (!textTokens.length) return [];
  const found = new Set();

  for (const rawKeyword of keywords) {
    if (typeof rawKeyword !== 'string') continue;
    const keyword = rawKeyword.trim();
    if (!keyword) continue;
    const matchers = compileKeyword(keyword);
    if (!matchers) continue;

    for (let start = 0; start + matchers.length <= textTokens.length; start += 1) {
      if (matchers.every((matches, offset) => matches(textTokens[start + offset]))) {
        found.add(keyword);
        break;
      }
    }
  }
  return [...found];
}

// Имя считается человеческим, если оно есть в списке имён ИЛИ выглядит как имя:
// 1–3 слова из одних букв (без цифр и «_»), хотя бы одно из 3+ букв. Так проходят
// редкие, уменьшительные и латинские имена; эмодзи, цифры и набор символов — нет.
function looksLikeHumanName(displayName, knownNames) {
  const parts = tokens(displayName);
  if (!parts.length) return { looksHuman: false, matchedNames: [], canonicalNames: [] };

  const nameMap = knownNames instanceof Map
    ? knownNames
    : new Map((knownNames || []).map((name) => [normalize(name), normalize(name)]));

  const matchedNames = [];
  const canonicalNames = [];
  for (const part of parts) {
    if (nameMap.has(part)) {
      matchedNames.push(part);
      canonicalNames.push(nameMap.get(part));
    }
  }

  const shapedLikeName = parts.length <= 3
    && parts.every((part) => /^\p{L}+$/u.test(part))
    && parts.some((part) => part.length >= 3);

  return {
    looksHuman: matchedNames.length > 0 || shapedLikeName,
    matchedNames: [...new Set(matchedNames)],
    canonicalNames: [...new Set(canonicalNames)]
  };
}

module.exports = { normalize, tokens, findKeywordMatches, looksLikeHumanName };
