const { Markup } = require('telegraf');
const { evaluateProfile, SHORT_PROMPT, LONG_PROMPT } = require('./moderation');
const { readWordList, writeWordList } = require('./rules');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WELCOME = 'Добро пожаловать в группу!';
const FINAL_BAN_REASON = 'Превышен лимит отказов при подаче заявок';
// Заявки уже нет (пользователь отозвал её или она обработана вручную) — повторять действие бессмысленно.
const CLOSED_REQUEST_ERRORS = /HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT/;
// В этих статусах заявка не может быть изменена кнопками.
const FINAL_STATUSES = ['approved', 'rejected', 'closed'];

function reasonLabel(reason) {
  const labels = {
    ambiguous_reply: 'Ответ неоднозначный — нужна ручная проверка',
    allow_deny_conflict: 'Фраза совпала с разрешающим и запрещающим списками',
    no_dictionary_match: 'Не найдено совпадений в словарях',
    reply_needs_profile_recheck: 'Нужно повторно проверить профиль',
    allow_keyword: 'Найдена разрешающая фраза',
    deny_keyword: 'Найдена запрещающая фраза',
    deny_keyword_in_reply: 'В ответе найдена запрещающая фраза',
    refused_to_provide_name: 'Пользователь отказался указать имя',
    cannot_message_user: 'Не удалось написать пользователю',
    approved_by_bot_or_owner: 'Заявка одобрена',
    name_missing_or_unrecognized: 'Имя отсутствует или не распознано',
    bio_missing: 'Описание профиля отсутствует',
    active_ban: 'Пользователь находится в блокировке',
    owner_rejected: 'Заявка отклонена владельцем',
    owner_kept_open: 'Заявка оставлена открытой владельцем',
    user_replied: 'Пользователь ответил — нужно ваше решение',
    approve_failed: 'Не удалось одобрить заявку (ошибка Telegram)',
    decline_failed: 'Не удалось отклонить заявку (ошибка Telegram)',
    processing_error: 'Ошибка при обработке заявки',
    interrupted: 'Обработка была прервана перезапуском бота',
    request_already_closed: 'Заявка уже закрыта в Telegram',
  };
  return labels[reason] || reason || 'Причина не указана';
}

function formatMatches(matches = {}) {
  const formatList = (items) => {
    if (!Array.isArray(items) || items.length === 0) {
      return 'нет';
    }

    return items.join(', ');
  };

  return [
    `Имя (разрешённые): ${formatList(matches.nameMatchesAllow)}`,
    `Имя (запрещённые): ${formatList(matches.nameMatchesDeny)}`,
    `Bio (разрешённые): ${formatList(matches.bioMatchesAllow)}`,
    `Bio (запрещённые): ${formatList(matches.bioMatchesDeny)}`,
    `Известные имена: ${formatList(matches.matchedKnownNames)}`,
    `Все разрешающие совпадения: ${formatList(matches.allowMatches)}`,
    `Все запрещающие совпадения: ${formatList(matches.denyMatches)}`
  ].join('\n');
}

function getDenyMatchDetails(matches = {}) {
  const nameMatches = Array.isArray(matches.nameMatchesDeny)
    ? matches.nameMatchesDeny
    : [];

  const bioMatches = Array.isArray(matches.bioMatchesDeny)
    ? matches.bioMatchesDeny
    : [];

  const lines = [];

  if (nameMatches.length) {
    lines.push(`Найдено в имени: ${nameMatches.join(', ')}`);
  }

  if (bioMatches.length) {
    lines.push(`Найдено в bio: ${bioMatches.join(', ')}`);
  }

  return lines.length ? lines.join('\n') : 'Найденные фразы: не указаны';
}

function buildReviewMessage(record) {
  const matches = JSON.parse(record.matches_json || '{}');

  return [
    `🟡 Ручная проверка #${record.id}`,
    `Пользователь: ${record.display_name || '(имя не указано)'}`,
    `Username: ${record.username ? '@' + record.username : 'нет'}`,
    `ID: ${record.user_id}`,
    `Bio: ${record.bio || '(отсутствует)'}`,
    `Причина: ${reasonLabel(record.reason)}`,
    'Совпадения:',
    formatMatches(matches),
    `Bio заполнено: ${matches.hasBio ? 'да' : 'нет'}`,
    `Имя похоже на настоящее: ${matches.looksHumanName ? 'да' : 'нет'}`
  ].join('\n');
}

function caseKeyboard(caseId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Одобрить', `case:approve:${caseId}`),
      Markup.button.callback('❌ Отклонить', `case:reject:${caseId}`)
    ],
    [Markup.button.callback('🕓 Оставить открытой', `case:hold:${caseId}`)]
  ]);
}

// Ключ для сравнения фраз в словаре: регистр и «ё» не важны, «*» и дефисы сохраняются.
function phraseKey(value) {
  return String(value).trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

function createHandlers({ bot, config, storage, getRules }) {
  // Защита от двойного нажатия на кнопку, пока заявка ещё обрабатывается.
  const busy = new Set();

  async function notifyOwner(text, extra = {}) {
    return bot.telegram.sendMessage(Number(config.ownerId), text, extra).catch((error) => {
      console.error('[owner notification]', error.message);
    });
  }

  // Действие над заявкой не удалось. Заявка не «теряется»: она либо закрыта в Telegram,
  // либо получает статус action_failed и остаётся в /pending с кнопками.
  async function failCase(record, action, error) {
    const verb = action === 'approve' ? 'одобрить' : 'отклонить';
    if (CLOSED_REQUEST_ERRORS.test(error.message || '')) {
      storage.updateCase(record.id, 'closed', 'request_already_closed');
      await notifyOwner(
        `ℹ️ Заявка #${record.id} уже закрыта в Telegram (пользователь отозвал её или она обработана вручную), ` +
        `${verb} не потребовалось.\n${record.display_name || record.user_id}\nID: ${record.user_id}`
      );
    } else {
      storage.updateCase(record.id, 'action_failed', action === 'approve' ? 'approve_failed' : 'decline_failed');
      await notifyOwner(
        `⚠️ Не удалось ${verb} заявку #${record.id}. Она осталась в /pending.\n` +
        `${record.display_name || record.user_id}\nID: ${record.user_id}\nОшибка: ${error.message}`
      );
    }
    return false;
  }

  async function incrementRefusalAndMaybeBan(record, reason) {
    const count = storage.addRefusal(record.chat_id, record.user_id, record.id, reason);
    if (count >= config.refusalsBeforeBan) {
      const untilAt = Math.floor(Date.now() / 1000) + config.banDays * 86400;
      try {
        await bot.telegram.banChatMember(Number(record.chat_id), Number(record.user_id), {
          until_date: untilAt,
          revoke_messages: false
        });
        storage.saveBan(record.chat_id, record.user_id, untilAt, FINAL_BAN_REASON);
        storage.clearRefusals(record.chat_id, record.user_id);
        await notifyOwner(`⛔ Пользователь заблокирован на ${config.banDays} дней после ${count} отказов.\n${record.display_name || record.user_id}\nID: ${record.user_id}\nПричина последнего отказа: ${reasonLabel(reason)}`);
      } catch (error) {
        console.error('[ban failed]', error.message);
        await notifyOwner(`⚠️ Не удалось применить бан пользователю ${record.user_id}. Проверьте права бота.\nОтказов: ${count}\nОшибка: ${error.message}`);
      }
    }
    return count;
  }

  // Возвращает true, только если Telegram действительно отклонил заявку.
  async function declineCase(record, reason) {
    try {
      await bot.telegram.declineChatJoinRequest(Number(record.chat_id), Number(record.user_id));
    } catch (error) {
      console.error('[decline failed]', error.message);
      return failCase(record, 'decline', error);
    }

    storage.updateCase(record.id, 'rejected', reason);
    const count = await incrementRefusalAndMaybeBan(record, reason);
    let matches = {};

    try {
      matches = JSON.parse(record.matches_json || '{}');
    } catch (error) {
      console.error('[matches JSON parse failed]', error.message);
    }

    const denyMatchDetails = getDenyMatchDetails(matches);
    await notifyOwner(
      `🔴 Заявка отклонена\n` +
      `${record.display_name || '(имя не указано)'}\n` +
      `Username: ${record.username ? '@' + record.username : 'не указан'}\n` +
      `ID: ${record.user_id}\n` +
      `Причина: ${reasonLabel(reason)}\n` +
      `${denyMatchDetails}\n` +
      `Отказов всего: ${count}`
    );
    return true;
  }

  // Возвращает true, только если Telegram действительно одобрил заявку.
  async function approveCase(record) {
    try {
      await bot.telegram.approveChatJoinRequest(Number(record.chat_id), Number(record.user_id));
    } catch (error) {
      console.error('[approve failed]', error.message);
      return failCase(record, 'approve', error);
    }

    storage.updateCase(record.id, 'approved', 'approved_by_bot_or_owner');
    await notifyOwner(
      `✅ Заявка одобрена\n${record.display_name || '(имя не указано)'}\n` +
      `Username: ${record.username ? '@' + record.username : 'не указан'}\n` +
      `ID: ${record.user_id}`
    );
    return true;
  }

  async function sendManualReview(record) {
    storage.updateCase(record.id, 'manual_review', record.reason);
    await notifyOwner(buildReviewMessage(record), caseKeyboard(record.id));
  }

  async function startDialog(record, promptType, userChatId) {
    const prompt = promptType === 'short' ? SHORT_PROMPT : LONG_PROMPT;
    storage.updateCase(record.id, 'awaiting_reply', record.reason, {
      promptType,
      promptSentAt: Math.floor(Date.now() / 1000)
    });

    try {
      // user_chat_id can be used for a limited period after the join request.
      await bot.telegram.sendMessage(Number(userChatId), prompt);
      await notifyOwner(`💬 Начат диалог по заявке #${record.id}\n${record.display_name || '(имя не указано)'}\n${record.username ? '@' + record.username : 'Username не указан'}\nID: ${record.user_id}\nСценарий: ${promptType === 'short' ? 'имя есть, bio отсутствует' : 'имя отсутствует/не распознано'}`);
    } catch (error) {
      console.error('[initial DM failed]', error.message);
      storage.updateCase(record.id, 'manual_review', 'cannot_message_user');
      await sendManualReview(storage.getCaseById(record.id));
      await notifyOwner(`⚠️ Не удалось написать пользователю по заявке #${record.id}. Заявка оставлена для ручного рассмотрения.\nОшибка: ${error.message}`);
    }
  }

  async function onJoinRequest(ctx) {
    const request = ctx.chatJoinRequest;
    if (!request) return;
    if (String(request.chat.id) !== String(config.groupId)) return;

    const user = request.from;
    const bio = request.bio || '';

    let profile;
    try {
      profile = evaluateProfile(user, bio, getRules());
    } catch (error) {
      console.error('[evaluateProfile failed]', error);
      profile = { action: 'manual_review', reason: 'processing_error', matches: {}, name: '', hasBio: Boolean(bio) };
    }

    const caseResult = storage.createCase({
      chatId: String(request.chat.id),
      userId: String(user.id),
      requestDate: Number(request.date),
      status: 'received',
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      username: user.username || '',
      bio,
      displayName: [user.first_name, user.last_name].filter(Boolean).join(' ').trim(),
      reason: profile.reason,
      matchesJson: JSON.stringify(profile.matches)
    });
    const record = caseResult.record;

    // Persisted idempotency: duplicate update delivery must not repeat actions.
    if (!caseResult.created) {
      console.log(`[join request] duplicate request ignored for case ${record.id}: ${record.status}`);
      return;
    }

    try {
      const activeBan = storage.getBan(request.chat.id, user.id);
      if (activeBan && activeBan.until_at > Math.floor(Date.now() / 1000)) {
        storage.updateCase(record.id, 'rejected', 'active_ban');
        try {
          await bot.telegram.declineChatJoinRequest(request.chat.id, user.id);
        } catch (error) {
          console.warn('[active ban decline]', error.message);
        }
        return;
      }

      if (profile.action === 'reject') {
        await declineCase(record, profile.reason);
      } else if (profile.action === 'approve') {
        await approveCase(record);
      } else if (profile.action === 'manual_review') {
        await sendManualReview(record);
      } else {
        await startDialog(record, profile.promptType, request.user_chat_id);
      }
    } catch (error) {
      // Любой неожиданный сбой не должен оставлять заявку в статусе «received» без внимания владельца.
      console.error('[join request failed]', error);
      storage.updateCase(record.id, 'manual_review', 'processing_error');
      await sendManualReview(storage.getCaseById(record.id));
    }
  }

  // После перезапуска: заявки, обработка которых была прервана (статус received), отдаём владельцу.
  async function recoverInterrupted() {
    const count = storage.recoverInterrupted();
    if (count) {
      await notifyOwner(`⚠️ После перезапуска найдено заявок с прерванной обработкой: ${count}. Они переведены в ручную проверку — см. /pending.`);
    }
    return count;
  }

  async function onStart(ctx) {
    if (String(ctx.from.id) === String(config.ownerId)) {
      return ctx.reply('Бот работает. /help — команды, /pending — открытые заявки.');
    }
    const record = storage.getLatestCase(config.groupId, ctx.from.id);
    if (record && record.status === 'awaiting_reply') {
      return ctx.reply(record.prompt_type === 'short' ? SHORT_PROMPT : LONG_PROMPT);
    }
    return ctx.reply('Это бот модерации группы Soul Hub. Если я вам не писал, отвечать здесь ничего не нужно.');
  }

  async function onPrivateMessage(ctx) {
    const message = ctx.message;
    if (!message || !message.from || message.from.is_bot || message.chat.type !== 'private') return;
    if (typeof message.text === 'string' && message.text.startsWith('/')) return;
    const record = storage.getLatestCase(config.groupId, message.from.id);
    if (!record || !['awaiting_reply', 'awaiting_profile_update'].includes(record.status)) return;

    storage.updateCase(record.id, record.status, record.reason, {
      lastUserMessageAt: Math.floor(Date.now() / 1000)
    });
    const replyText = message.text || message.caption || '';
    if (!replyText.trim()) {
      await ctx.reply('Пожалуйста, ответьте текстом, чтобы администратор мог рассмотреть вашу заявку.');
      return;
    }

    // Ответы не анализируются автоматически: решение всегда принимает владелец.
    storage.updateCase(record.id, 'manual_review', 'user_replied');
    const updatedRecord = storage.getCaseById(record.id);
    await notifyOwner([
      `💬 Ответ на заявку #${record.id}`,
      `${updatedRecord.username ? '@' + updatedRecord.username : 'Username не указан'}`,
      `Пользователь: ${updatedRecord.display_name || '(имя не указано)'}`,
      `ID: ${updatedRecord.user_id}`,
      `Ответ: ${replyText.slice(0, 1500)}`,
      `Исходный профиль: ${updatedRecord.bio || '(bio отсутствует)'}`,
      'Проверьте, исправлено ли имя в профиле, перед решением.'
    ].join('\n'), caseKeyboard(record.id));
    await ctx.reply('Спасибо за ответ! Я передал информацию администратору для рассмотрения заявки.');
  }

  async function onOwnerCallback(ctx) {
    const callback = ctx.callbackQuery;
    if (String(ctx.from.id) !== String(config.ownerId)) {
      await ctx.answerCbQuery('Эта кнопка доступна только владельцу.', { show_alert: true });
      return;
    }
    const match = /^case:(approve|reject|hold):(\d+)$/.exec(callback.data || '');
    if (!match) return;
    const [, action, idText] = match;
    const record = storage.getCaseById(Number(idText));
    if (!record) {
      await ctx.answerCbQuery('Заявка не найдена.', { show_alert: true });
      return;
    }

    const removeKeyboard = () => ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

    if (FINAL_STATUSES.includes(record.status)) {
      await ctx.answerCbQuery(`Заявка уже обработана (статус: ${record.status}).`, { show_alert: true });
      await removeKeyboard();
      return;
    }
    if (busy.has(record.id)) {
      await ctx.answerCbQuery('Заявка уже обрабатывается.');
      return;
    }

    busy.add(record.id);
    try {
      if (action === 'hold') {
        if (record.status !== 'awaiting_reply') {
          storage.updateCase(record.id, 'manual_review', 'owner_kept_open');
        }
        await ctx.answerCbQuery('Заявка оставлена открытой.');
        return;
      }

      const ok = action === 'approve'
        ? await approveCase(record)
        : await declineCase(record, 'owner_rejected');

      if (ok) {
        await ctx.answerCbQuery(action === 'approve' ? 'Заявка одобрена.' : 'Заявка отклонена.');
        await removeKeyboard();
      } else if (storage.getCaseById(record.id).status === 'closed') {
        await ctx.answerCbQuery('Заявка уже закрыта в Telegram (отозвана или обработана вручную).', { show_alert: true });
        await removeKeyboard();
      } else {
        await ctx.answerCbQuery('Не удалось выполнить действие — подробности в сообщении бота. Заявка осталась в /pending.', { show_alert: true });
      }
    } finally {
      busy.delete(record.id);
    }
  }

  async function ownerCommand(ctx) {
    if (String(ctx.from.id) !== String(config.ownerId)) return;
    const text = ctx.message.text || '';
    const command = text.split(/\s+/)[0].split('@')[0];

    if (command === '/pending') {
      const cases = storage.listPendingCases();
      if (!cases.length) return ctx.reply('Открытых заявок нет.');
      for (const record of cases) {
        await ctx.reply(buildReviewMessage(record), caseKeyboard(record.id));
      }
    } else if (command === '/stats') {
      const recent = storage.listRecentCases(1000);
      const counts = recent.reduce((acc, row) => {
        acc[row.status] = (acc[row.status] || 0) + 1;
        return acc;
      }, {});
      await ctx.reply(`Статистика последних ${recent.length} заявок:\n${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('\n') || 'Нет данных'}`);
    } else if (['/allow_add', '/deny_add', '/allow_remove', '/deny_remove', '/dictionaries'].includes(command)) {
      try {
        if (command === '/dictionaries') {
          return ctx.reply(
            `📚 Словари Soul Hub\n` +
            `Разрешающих выражений: ${readWordList(config.allowWordsPath).length}\n` +
            `Запрещающих выражений: ${readWordList(config.denyWordsPath).length}`
          );
        }
        const which = command.startsWith('/allow') ? 'allow' : 'deny';
        const file = which === 'allow' ? config.allowWordsPath : config.denyWordsPath;
        const words = readWordList(file);
        const phrase = text.replace(/^\S+\s*/, '').trim();
        if (!phrase) return ctx.reply('Укажите слово или фразу после команды.');
        const key = phraseKey(phrase);
        const idx = words.findIndex((w) => phraseKey(w) === key);
        if (command.endsWith('_add')) {
          if (idx >= 0) return ctx.reply('Такая фраза уже есть в словаре.');
          words.push(phrase);
        } else {
          if (idx < 0) return ctx.reply('Такой фразы нет в словаре.');
          words.splice(idx, 1);
        }
        writeWordList(file, words);
        return ctx.reply(
          `✅ Фраза «${phrase}» ${command.endsWith('_add') ? 'добавлена в' : 'удалена из'} ${which === 'allow' ? 'разрешающий' : 'запрещающий'} словарь.\n` +
          'Изменение применится автоматически, перезапуск не нужен.'
        );
      } catch (error) {
        console.error('[dictionary command failed]', error.message);
        return ctx.reply(`⚠️ Не удалось изменить словарь: ${error.message}`);
      }
    } else if (command === '/backup') {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulhub-backup-'));
      try {
        const date = new Date().toISOString().slice(0, 10);
        const dbCopy = path.join(dir, 'soul-hub.sqlite');
        await storage.backupTo(dbCopy);
        await ctx.replyWithDocument({ source: dbCopy, filename: `soul-hub-${date}.sqlite` });
        await ctx.replyWithDocument({ source: config.allowWordsPath, filename: 'allow.json' });
        await ctx.replyWithDocument({ source: config.denyWordsPath, filename: 'deny.json' });
        await ctx.reply('✅ Бэкап: база заявок и два словаря. В базе данные заявителей — храните файлы аккуратно.');
      } catch (error) {
        console.error('[backup failed]', error.message);
        await ctx.reply(`⚠️ Не удалось сделать бэкап: ${error.message}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } else if (command === '/help') {
      await ctx.reply(
        '📖 Команды Soul Hub Moderation Bot\n\n' +
        '/pending — посмотреть открытые заявки\n' +
        '/stats — статистика заявок и модерации\n' +
        '/allow_add фраза — добавить фразу в разрешающий словарь\n' +
        '/deny_add фраза — добавить фразу в запрещающий словарь\n' +
        '/allow_remove фраза — удалить фразу из разрешающего словаря\n' +
        '/deny_remove фраза — удалить фразу из запрещающего словаря\n' +
        '/dictionaries — количество фраз в словарях\n' +
        '/backup — прислать бэкап базы и словарей\n' +
        '/forget user_id — сбросить отказы и снять блокировку пользователя\n' +
        '/help — показать эту справку\n\n' +
        'Пример: /deny_add подозрительная фраза\n\n' +
        'Как ищутся слова: слова от 6 букв находятся вместе с окончаниями (психолог → психологом), ' +
        'короткие — только точно. Чтобы короткое слово искалось с любым продолжением, добавьте * в конце ' +
        '(например, юрист*). Дефис и пробел равнозначны: арт-терапевт = арт терапевт.'
      );
    } else if (command === '/forget') {
      const args = text.trim().split(/\s+/).slice(1);
      const userId = args[0];

      if (!userId || !/^\d+$/.test(userId)) {
        return ctx.reply(
          'Использование: /forget <user_id>\n' +
          'Пример: /forget 325653903'
        );
      }

      const chatId = String(config.groupId);
      const targetUserId = String(userId);

      try {
        // Сбрасываем историю отказов пользователя в этой группе.
        const deletedRefusals = storage.clearRefusals(chatId, targetUserId);

        // Снимаем бан в Telegram, даже если локальная запись о нём отсутствует.
        await ctx.telegram.unbanChatMember(
          Number(chatId),
          Number(targetUserId),
          { only_if_banned: true }
        );

        // Удаляем локальную запись о блокировке.
        storage.clearBan(chatId, targetUserId);

        return ctx.reply(
          `♻️ Пользователь ${targetUserId} сброшен\n` +
          `Удалено отказов: ${deletedRefusals}\n` +
          'Блокировка в группе снята, если она действовала.'
        );
      } catch (error) {
        console.error('[forget failed]', error.message);

        return ctx.reply(
          `⚠️ Не удалось полностью сбросить пользователя ${targetUserId}.\n` +
          `Ошибка: ${error.message}`
        );
      }
    }
  }

  return { onJoinRequest, onPrivateMessage, onOwnerCallback, ownerCommand, recoverInterrupted, onStart };
}

module.exports = { createHandlers };
