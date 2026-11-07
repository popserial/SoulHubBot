const { findKeywordMatches, looksLikeHumanName } = require('./text');

const SHORT_PROMPT = `Здравствуйте! Я администратор группы Soul Hub — спасибо, что отправили заявку на вступление, я как раз её обрабатываю 🙂

Наша группа создана для начинающих психологов. Расскажите, имеете ли вы отношение к профессии психолога?`;

const LONG_PROMPT = `Здравствуйте! Я администратор группы Soul Hub — спасибо, что отправили заявку на вступление, я как раз её обрабатываю 🙂

Наша группа создана для психологов и тех, кто учится этой профессии. Поскольку заявок много, я стараюсь отсеивать ботов и людей, не связанных с психологией, — поэтому смотрю на оформление профиля.

В вашем аккаунте вместо имени — символы, и по профилю не совсем понятно, имеете ли вы отношение к психологии. Подскажите, пожалуйста: вы психолог / учитесь на психолога / планируете им стать? И как к вам можно обращаться?

Если добавите в шапку аккаунта имя и кратко укажете связь с профессией здесь, в чате — я с радостью приму заявку 🙏`;

function displayName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
}

function evaluateProfile(user, bio, rules) {
  const name = displayName(user);
  const nameMatchesAllow = findKeywordMatches(name, rules.allow.words);
  const nameMatchesDeny = findKeywordMatches(name, rules.deny.words);
  const bioMatchesAllow = findKeywordMatches(bio, rules.allow.words);
  const bioMatchesDeny = findKeywordMatches(bio, rules.deny.words);

  const humanName = looksLikeHumanName(name, rules.knownNames);
  const hasBio = Boolean(String(bio ?? '').trim());
  const allowMatches = [...nameMatchesAllow.map((word) => `name:${word}`), ...bioMatchesAllow.map((word) => `bio:${word}`)];
  const denyMatches = [...nameMatchesDeny.map((word) => `name:${word}`), ...bioMatchesDeny.map((word) => `bio:${word}`)];

  const matches = {
    nameMatchesAllow, nameMatchesDeny, bioMatchesAllow, bioMatchesDeny,
    matchedKnownNames: humanName.matchedNames,
    hasBio, looksHumanName: humanName.looksHuman,
    allowMatches, denyMatches
  };

  // A conflict is explicitly routed to the owner, per the client's rules.
  if (allowMatches.length && denyMatches.length) {
    return { action: 'manual_review', reason: 'allow_deny_conflict', matches, name, hasBio };
  }
  if (denyMatches.length) {
    return { action: 'reject', reason: 'deny_keyword', matches, name, hasBio };
  }

  // A profile with missing fields or a symbol-like display name gets a guided dialog.
  if (!name || !hasBio || !humanName.looksHuman) {
    return {
      action: 'dialog',
      reason: !name || !humanName.looksHuman ? 'name_missing_or_unrecognized' : 'bio_missing',
      promptType: (!name || !humanName.looksHuman) ? 'long' : 'short',
      matches, name, hasBio
    };
  }

  if (allowMatches.length) {
    return { action: 'approve', reason: 'allow_keyword', matches, name, hasBio };
  }

  return { action: 'manual_review', reason: 'no_dictionary_match', matches, name, hasBio };
}

// Ответы пользователей в диалоге не анализируются автоматически: все они уходят владельцу.

module.exports = { evaluateProfile, displayName, SHORT_PROMPT, LONG_PROMPT };
