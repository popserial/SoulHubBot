const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Markup } = require('telegraf');
const { evaluateProfile, SHORT_PROMPT, LONG_PROMPT } = require('./moderation');
const { readWordList, writeWordList } = require('./rules');

const FINAL_BAN_REASON = 'Превышен лимит отказов при подаче заявок';
// Заявки уже нет (пользователь отозвал её или она обработана вручную) — повторять действие бессмысленно.
const CLOSED_REQUEST_ERRORS = /HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT/;
// В этих статусах заявка не может быть изменена кнопками.
const FINAL_STATUSES = ['approved', 'rejected', 'closed'];
// Если после вашего отказа человек подал заявку с теми же именем и описанием — отклоняем молча.
const REPEAT_DECLINE_DAYS = 14;
const PENDING_LIMIT = 10; // больше 10 блоков не показываем (10 эмодзи-номеров)
const LIST_HEADER = '📋 Открытые заявки';
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const EMPTY_KEYBOARD = { ...HTML, reply_markup: { inline_keyboard: [] } };
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Имя-ссылка на профиль: работает и без ника (если Telegram разрешает открыть профиль).
const profileLink = (r) => `<a href="tg://user?id=${r.user_id}">${esc(r.display_name || 'без имени')}</a>`;
// Сдвиг местного времени от UTC (Москва): для «понедельника», времени в карточках и часа сводки.
const STATS_UTC_OFFSET_HOURS = 3;

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
    repeat_rejected: 'Повторная заявка с теми же данными после отказа',
  };
  return labels[reason] || reason || 'Причина не указана';
}

// Короткие причины для компактного списка /pending.
const SHORT_REASONS = {
  no_dictionary_match: 'нет совпадений',
  allow_deny_conflict: 'конфликт слов',
  user_replied: 'ответил',
  cannot_message_user: 'боту не написать',
  approve_failed: '⚠️ ошибка',
  decline_failed: '⚠️ ошибка',
  processing_error: '⚠️ сбой',
  interrupted: '⚠️ сбой',
  bio_missing: 'ждём ответа',
  name_missing_or_unrecognized: 'ждём ответа'
};

const ROUTE_REASON_LABELS = {
  no_dictionary_match: 'нет совпадений в словарях',
  allow_deny_conflict: 'конфликт разрешающих и запрещающих слов',
  bio_missing: 'нет описания профиля (бот задал вопрос)',
  name_missing_or_unrecognized: 'имя не распознано (бот задал вопрос)',
  processing_error: 'ошибка обработки'
};

const pad = (n) => String(n).padStart(2, '0');

function localDate(sec) {
  return new Date((sec + STATS_UTC_OFFSET_HOURS * 3600) * 1000);
}

function formatDay(sec) {
  const d = localDate(sec);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}`;
}

function formatDateTime(sec) {
  const d = localDate(sec);
  return `${formatDay(sec)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatAgo(sec, nowSec) {
  const diff = Math.max(0, nowSec - sec);
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} мин`;
  if (diff < 86400) return `${Math.round(diff / 3600)} ч`;
  return `${Math.round(diff / 86400)} д`;
}

function shorten(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function safeJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function caseKeyboard(caseId, userId, withProfile = true) {
  const rows = [[
    Markup.button.callback('✅ Одобрить', `case:approve:${caseId}`),
    Markup.button.callback('❌ Отклонить', `case:reject:${caseId}`)
  ]];
  if (withProfile) rows.push([Markup.button.url('👤 Профиль', `tg://user?id=${userId}`)]);
  return { ...HTML, ...Markup.inlineKeyboard(rows) };
}

// Описание профиля: если после ответа человек его изменил, показываем «было → сейчас».
function bioChanged(record) {
  // Пустой ответ getChat не считаем изменением: он бывает и при скрытом по приватности bio.
  return Boolean(record.current_bio) && record.current_bio !== (record.bio || '');
}

// Карточка заявки. Пока заявка открыта — подробная, с кнопками; после решения сворачивается в одну строку.
function buildCard(record, note = '', withProfile = true) {
  const nick = record.username ? ` @${esc(record.username)}` : '';

  if (FINAL_STATUSES.includes(record.status)) {
    const verb = { approved: '✅ Одобрена', rejected: '❌ Отклонена', closed: 'ℹ️ Закрыта в Telegram' }[record.status];
    return { text: `${verb} · #${record.id} · ${profileLink(record)}${nick} · ${formatDateTime(record.updated_at)}`, extra: EMPTY_KEYBOARD };
  }

  const matches = safeJson(record.matches_json);
  const hits = [];
  if (matches.allowMatches?.length) hits.push(`✔ ${matches.allowMatches.join(', ')}`);
  if (matches.denyMatches?.length) hits.push(`✖ ${matches.denyMatches.join(', ')}`);

  const lines = [
    `${record.status === 'action_failed' ? '⚠️' : '🟡'} #${record.id} · заявка от ${formatDateTime(record.created_at)}`,
    `👤 ${profileLink(record)}${nick} · ID ${record.user_id}`,
    ...(bioChanged(record)
      ? [`📝 Было: ${record.bio ? `«${esc(record.bio)}»` : 'описание не заполнено'}`,
        `📝 Сейчас: ${record.current_bio ? `«${esc(record.current_bio)}»` : 'описание не заполнено'}`]
      : [`📝 ${record.bio ? `«${esc(record.bio)}»` : '(описание не заполнено)'}`]),
    `❓ ${esc(reasonLabel(record.reason))}`
  ];
  if (hits.length) lines.push(`🔎 В словарях: ${esc(hits.join(' | '))}`);
  if (record.repeat_count > 0) lines.push(`🔁 Подана повторно: ${record.repeat_count}`);
  if (record.user_reply) lines.push(`💬 Ответ: ${esc(shorten(record.user_reply, 600))}`);
  if (note) lines.push(esc(note));
  return { text: lines.join('\n'), extra: caseKeyboard(record.id, record.user_id, withProfile) };
}

function statsRange(arg, nowSec) {
  const offset = STATS_UTC_OFFSET_HOURS * 3600;
  const today = Math.floor((nowSec + offset) / 86400);              // номер дня по местному времени
  const monday = (today - ((today + 3) % 7)) * 86400 - offset;      // 00:00 понедельника (1.01.1970 — четверг)
  if (!arg) return { from: monday, to: nowSec + 1, title: 'с понедельника' };
  if (arg === 'prev') return { from: monday - 7 * 86400, to: monday, title: 'за прошлую неделю' };
  if (arg === 'all') return { from: 0, to: nowSec + 1, title: 'за всё время', noDates: true };
  const days = Number(arg);
  if (Number.isInteger(days) && days > 0 && days <= 3650) {
    return { from: nowSec - days * 86400, to: nowSec + 1, title: `за последние ${days} дн.` };
  }
  return null;
}

function formatStats(rows, range, extra) {
  const dates = range.noDates ? '' : ` (${formatDay(range.from)} – ${formatDay(range.to - 1)})`;
  const title = `📊 Статистика ${range.title}${dates}`;

  const sum = (predicate) => rows.filter(predicate).reduce((acc, row) => acc + row.n, 0);
  const total = sum(() => true);
  if (!total) return `${title}\nЗаявок не было.`;
  const pct = (n) => `${n} (${Math.round((n / total) * 100)}%)`;

  const banned = sum((r) => r.reason === 'active_ban');
  const bot = (route) => sum((r) => r.reason !== 'active_ban' && r.route === route);
  const isManual = (r) => r.reason !== 'active_ban' && (r.route === 'manual_review' || r.route === 'dialog');
  const manual = sum(isManual);
  const unlabeled = sum((r) => r.reason !== 'active_ban' && !r.route);
  const failed = sum((r) => r.status === 'action_failed');

  const lines = [
    title,
    `Всего заявок: ${total}`,
    `✅ Принято ботом сам: ${pct(bot('approve'))}`,
    `⛔ Отклонено ботом сам: ${pct(bot('reject') + banned)}${banned ? ` — из них по действующему бану: ${banned}` : ''}`,
    `🟡 На ручную проверку: ${pct(manual)}`
  ];

  const byReason = new Map();
  for (const row of rows.filter(isManual)) {
    byReason.set(row.routeReason, (byReason.get(row.routeReason) || 0) + row.n);
  }
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    lines.push(`   • ${ROUTE_REASON_LABELS[reason] || reason || 'причина не указана'}: ${n}`);
  }
  if (manual) {
    const approved = sum((r) => isManual(r) && r.status === 'approved');
    const rejected = sum((r) => isManual(r) && r.status === 'rejected');
    const closed = sum((r) => isManual(r) && r.status === 'closed');
    lines.push(`   Из ручных: вы одобрили ${approved}, отклонили ${rejected}, отозвано ${closed}, ждут решения ${manual - approved - rejected - closed}`);
  }
  if (extra?.merged) lines.push(`🔁 Повторных подач, добавленных к уже открытым заявкам: ${extra.merged}`);
  if (extra?.silent) lines.push(`🔁 Повторных заявок, отклонённых молча (те же данные после отказа): ${extra.silent}`);
  if (extra?.bans) lines.push(`🚫 Блокировок за период: ${extra.bans}`);
  if (unlabeled) lines.push(`Без метки (заявки до обновления статистики): ${unlabeled}`);
  if (failed) lines.push(`⚠️ Ошибок при одобрении/отклонении: ${failed} — см. /pending`);
  return lines.join('\n');
}

// Ключ для сравнения фраз в словаре: регистр и «ё» не важны, «*» и дефисы сохраняются.
function phraseKey(value) {
  return String(value).trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

function createHandlers({ bot, config, storage, getRules }) {
  const ownerChatId = Number(config.ownerId);
  // Защита от двойного нажатия на кнопку, пока заявка ещё обрабатывается.
  const busy = new Set();

  // Для действительно важных сообщений (сбои, сводка). Обычные заявки идут карточками.
  async function notifyOwner(text, extra = {}) {
    return bot.telegram.sendMessage(ownerChatId, text, extra).catch((error) => {
      console.error('[owner notification]', error.message);
    });
  }

  // Одна карточка на человека: первый вызов отправляет её (владелец получает уведомление),
  // последующие редактируют то же сообщение. Решённая заявка сворачивается в одну строку.
  // Заявки без карточки (автоматические решения) остаются молча.
  async function renderCard(caseId, note = '') {
    const record = storage.getCaseById(caseId);
    if (!record) return;
    const isFinal = FINAL_STATUSES.includes(record.status);
    // Если Telegram не принимает кнопку-ссылку на профиль (закрытая приватность), повторяем без неё.
    const attempt = async (send) => {
      try {
        return await send(buildCard(record, note, true));
      } catch (error) {
        if (!/BUTTON_USER/i.test(error.message)) throw error;
        return send(buildCard(record, note, false));
      }
    };

    if (record.card_message_id) {
      try {
        await attempt((card) => bot.telegram.editMessageText(ownerChatId, record.card_message_id, undefined, card.text, card.extra));
        return;
      } catch (error) {
        if (/not modified/i.test(error.message)) return;
        console.warn('[card edit failed]', error.message);
        if (isFinal) return;
      }
    } else if (isFinal) {
      return;
    }

    try {
      const sent = await attempt((card) => bot.telegram.sendMessage(ownerChatId, card.text, card.extra));
      storage.setCardMessage(record.id, sent.message_id);
    } catch (error) {
      console.error('[owner notification]', error.message);
    }
  }

  function buildPendingList() {
    const cases = storage.listPendingCases(PENDING_LIMIT);
    if (!cases.length) return { text: `${LIST_HEADER}\nОткрытых заявок нет ✅`, extra: EMPTY_KEYBOARD };

    const counts = storage.countPending();
    const now = Math.floor(Date.now() / 1000);
    const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const SEPARATOR = '──────────────';
    const block = (c, n) => {
      const nick = c.username ? ` @${esc(c.username)}` : '';
      const name = { ...c, display_name: shorten(c.display_name || 'без имени', 30) };
      const out = [`${KEYCAPS[n]} <b>${profileLink(name)}</b>${nick} · ${formatAgo(c.created_at, now)} назад`];
      if (bioChanged(c)) {
        out.push(`   📝 обновил: ${c.current_bio ? `«${esc(shorten(c.current_bio, 80))}»` : 'описания нет'} (было: ${c.bio ? `«${esc(shorten(c.bio, 40))}»` : 'нет'})`);
      } else {
        out.push(`   📝 ${c.bio ? `«${esc(shorten(c.bio, 80))}»` : 'описания нет'}`);
      }
      if (c.user_reply) out.push(`   💬 «${esc(shorten(c.user_reply, 140))}»`);
      else if (c.status === 'awaiting_reply') out.push('   ⏳ ещё не ответил');
      else out.push(`   ❓ ${esc(SHORT_REASONS[c.reason] || reasonLabel(c.reason))}`);
      return out.join('\n');
    };

    // Собираем блоки, пока текст помещается в лимит Telegram (4096 символов); остальное — «ещё N».
    const total = counts.decision + counts.waiting;
    let shown = cases.slice(0, KEYCAPS.length);
    let text;
    for (;;) {
      const decision = shown.filter((c) => c.status !== 'awaiting_reply');
      const waiting = shown.filter((c) => c.status === 'awaiting_reply');
      let n = 0;
      const section = (title, list) => [title, ...list.map((c) => `${block(c, n++)}\n${SEPARATOR}`)];
      const lines = [LIST_HEADER];
      if (decision.length) lines.push('', ...section(`🟡 Ждут вашего решения (${counts.decision}):`, decision));
      if (waiting.length) lines.push('', ...section(`⏳ Ждём ответа человека (${counts.waiting}):`, waiting));
      if (total > shown.length) lines.push('', `Ещё ${total - shown.length} не показано — решите эти, и список обновится.`);
      text = lines.join('\n');
      if (text.length <= 3900 || shown.length <= 1) break;
      shown = shown.slice(0, -1);
    }

    // Кнопки идут в том же порядке, что и блоки (сначала «ждут решения», потом «ждём ответа»).
    const ordered = [...shown.filter((c) => c.status !== 'awaiting_reply'), ...shown.filter((c) => c.status === 'awaiting_reply')];
    const rows = ordered.map((c, i) => [
      Markup.button.callback(`✅ ${KEYCAPS[i]}`, `case:approve:${c.id}`),
      Markup.button.callback(`❌ ${KEYCAPS[i]}`, `case:rejectask:${c.id}`)
    ]);
    return { text, extra: { ...HTML, ...Markup.inlineKeyboard(rows) } };
  }

  async function refreshList(ctx) {
    const list = buildPendingList();
    try {
      await ctx.editMessageText(list.text, list.extra);
    } catch (error) {
      if (!/not modified/i.test(error.message)) console.warn('[list refresh]', error.message);
    }
  }

  // Журнал автоматических решений: кого бот принял или отклонил сам, с фильтром и страницами.
  const AUTO_PAGE_SIZE = 10;
  const AUTO_KINDS = { all: 'Все', approve: '✅ Принятые', reject: '⛔ Отклонённые' };

  function buildAutoPage(kind, page, hours) {
    const now = Math.floor(Date.now() / 1000);
    const range = { from: now - hours * 3600, to: now + 1 };
    const counts = {
      approve: storage.countAuto({ ...range, kind: 'approve' }),
      reject: storage.countAuto({ ...range, kind: 'reject' })
    };
    const total = kind === 'all' ? counts.approve + counts.reject : counts[kind];
    const pages = Math.max(1, Math.ceil(total / AUTO_PAGE_SIZE));
    const current = Math.min(Math.max(0, page), pages - 1);
    const period = hours % 24 === 0 ? `${hours / 24} сут.` : `${hours} ч`;

    const lines = [`🤖 Решения бота за ${period}: ✅ принято ${counts.approve} · ⛔ отклонено ${counts.reject}`];
    if (!total) lines.push('', 'Пока ничего нет.');
    const rows = storage.listAutoCases({ ...range, kind, limit: AUTO_PAGE_SIZE, offset: current * AUTO_PAGE_SIZE });
    for (const c of rows) {
      const matches = safeJson(c.matches_json);
      const approved = c.reason !== 'active_ban' && c.route === 'approve';
      let why;
      if (c.reason === 'active_ban') why = 'пользователь в блокировке';
      else if (c.reason === 'repeat_rejected') why = 'повтор после вашего отказа';
      else if (approved && matches.allowMatches?.length) why = `подошло: ${matches.allowMatches.slice(0, 3).join(', ')}`;
      else if (!approved && matches.denyMatches?.length) why = `запрещено: ${matches.denyMatches.slice(0, 3).join(', ')}`;
      else why = reasonLabel(c.reason);
      const icon = c.status === 'action_failed' ? '⚠️' : approved ? '✅' : '⛔';
      const nick = c.username ? ` @${esc(c.username)}` : '';
      const name = { ...c, display_name: shorten(c.display_name || 'без имени', 30) };
      lines.push('', `${icon} <b>${profileLink(name)}</b>${nick} · ${formatAgo(c.created_at, now)} назад`);
      lines.push(`   📝 ${c.bio ? `«${esc(shorten(c.bio, 80))}»` : 'описания нет'} · ${esc(shorten(why, 60))}`);
    }

    const filterRow = Object.entries(AUTO_KINDS).map(([k, label]) =>
      Markup.button.callback(k === kind ? `• ${label}` : label, `auto:${k}:0:${hours}`));
    const keyboard = [filterRow];
    if (pages > 1) {
      keyboard.push([
        Markup.button.callback('◀', `auto:${kind}:${Math.max(0, current - 1)}:${hours}`),
        Markup.button.callback(`${current + 1} / ${pages}`, 'auto:noop'),
        Markup.button.callback('▶', `auto:${kind}:${Math.min(pages - 1, current + 1)}:${hours}`)
      ]);
    }
    return { text: lines.join('\n'), extra: { ...HTML, ...Markup.inlineKeyboard(keyboard) } };
  }

  async function onAutoCallback(ctx) {
    const match = /^auto:(all|approve|reject):(\d+):(\d+)$/.exec(ctx.callbackQuery.data || '');
    await ctx.answerCbQuery();
    if (!match) return; // кнопка с номером страницы
    const page = buildAutoPage(match[1], Number(match[2]), Number(match[3]));
    try {
      await ctx.editMessageText(page.text, page.extra);
    } catch (error) {
      if (!/not modified/i.test(error.message)) console.warn('[auto page]', error.message);
    }
  }

  // Действие над заявкой не удалось. Заявка не «теряется»: она либо закрыта в Telegram,
  // либо получает статус action_failed, и владелец видит её в карточке и в /pending.
  async function failCase(record, action, error) {
    if (CLOSED_REQUEST_ERRORS.test(error.message || '')) {
      storage.updateCase(record.id, 'closed', 'request_already_closed');
      await renderCard(record.id);
    } else {
      storage.updateCase(record.id, 'action_failed', action === 'approve' ? 'approve_failed' : 'decline_failed');
      await renderCard(record.id, `⚠️ Не удалось ${action === 'approve' ? 'одобрить' : 'отклонить'}: ${error.message}`);
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
      } catch (error) {
        console.error('[ban failed]', error.message);
        await notifyOwner(`⚠️ Не удалось заблокировать пользователя ${record.user_id} после ${count} отказов. Проверьте права бота.\nОшибка: ${error.message}`);
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
    await incrementRefusalAndMaybeBan(record, reason);
    await renderCard(record.id);
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
    await renderCard(record.id);
    return true;
  }

  async function sendManualReview(record) {
    storage.updateCase(record.id, 'manual_review', record.reason);
    await renderCard(record.id);
  }

  // Диалог: бот пишет человеку первым (в пределах 5 минут после заявки). Владельцу ничего не приходит,
  // пока человек не ответит. Если написать не удалось — сразу карточка на ручную проверку.
  async function startDialog(record, promptType, userChatId) {
    const prompt = promptType === 'short' ? SHORT_PROMPT : LONG_PROMPT;
    storage.updateCase(record.id, 'awaiting_reply', record.reason, {
      promptType,
      promptSentAt: Math.floor(Date.now() / 1000)
    });

    try {
      await bot.telegram.sendMessage(Number(userChatId), prompt);
    } catch (error) {
      console.error('[initial DM failed]', error.message);
      storage.updateCase(record.id, 'manual_review', 'cannot_message_user');
      await renderCard(record.id);
    }
  }

  // Человек подал заявку заново, пока прошлая ещё открыта: новую запись и новую карточку не создаём.
  async function handleRepeat(open, { requestDate, user, bio, displayName, profile }) {
    if (Number(open.request_date) === requestDate) {
      console.log(`[join request] duplicate delivery ignored for case ${open.id}`);
      return;
    }
    const auto = profile.action === 'approve' || profile.action === 'reject';
    storage.refreshCase(open.id, {
      requestDate,
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      username: user.username || '',
      bio,
      displayName,
      matchesJson: JSON.stringify(profile.matches),
      route: auto ? profile.action : null,
      routeReason: auto ? profile.reason : null
    });
    const record = storage.getCaseById(open.id);

    if (profile.action === 'approve') {
      await approveCase(record);
    } else if (profile.action === 'reject') {
      await declineCase(record, profile.reason);
    } else if (record.card_message_id) {
      await renderCard(record.id); // обновляем карточку на месте, без нового сообщения
    }
  }

  async function onJoinRequest(ctx) {
    const request = ctx.chatJoinRequest;
    if (!request) return;
    if (String(request.chat.id) !== String(config.groupId)) return;

    const user = request.from;
    const bio = request.bio || '';
    const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    const chatId = String(request.chat.id);
    const userId = String(user.id);
    const requestDate = Number(request.date);
    const nowSec = Math.floor(Date.now() / 1000);

    let profile;
    try {
      profile = evaluateProfile(user, bio, getRules());
    } catch (error) {
      console.error('[evaluateProfile failed]', error);
      profile = { action: 'manual_review', reason: 'processing_error', matches: {}, name: '', hasBio: Boolean(bio) };
    }

    // 1. У человека уже есть открытая заявка — склеиваем, нового сообщения не будет.
    const open = storage.getOpenCase(chatId, userId);
    if (open) {
      await handleRepeat(open, { requestDate, user, bio, displayName, profile });
      return;
    }

    // 2. Повторная заявка с теми же данными после вашего отказа — отклоняем молча.
    const last = storage.getLatestCase(chatId, userId);
    if (last && last.status === 'rejected'
      && ['owner_rejected', 'repeat_rejected'].includes(last.reason)
      && Number(last.request_date) !== requestDate
      && (last.display_name || '') === displayName && (last.bio || '') === bio
      && last.updated_at > nowSec - REPEAT_DECLINE_DAYS * 86400) {
      profile = { action: 'reject', reason: 'repeat_rejected', matches: profile.matches, name: displayName, hasBio: Boolean(bio) };
    }

    const caseResult = storage.createCase({
      chatId,
      userId,
      requestDate,
      status: 'received',
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      username: user.username || '',
      bio,
      displayName,
      reason: profile.reason,
      matchesJson: JSON.stringify(profile.matches),
      route: profile.action,
      routeReason: profile.reason
    });
    const record = caseResult.record;

    // Persisted idempotency: duplicate update delivery must not repeat actions.
    if (!caseResult.created) {
      console.log(`[join request] duplicate request ignored for case ${record.id}: ${record.status}`);
      return;
    }

    try {
      const activeBan = storage.getBan(request.chat.id, user.id);
      if (activeBan && activeBan.until_at > nowSec) {
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
      await renderCard(record.id);
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

  // Раз в сутки (после DIGEST_HOUR по Москве): что произошло за 24 часа и что ждёт решения.
  async function sendDigest() {
    const now = Math.floor(Date.now() / 1000);
    const range = { from: now - 86400, to: now + 1, title: 'за последние 24 часа' };
    const rows = storage.statsBetween(range.from, range.to);
    const pending = storage.countPending();
    if (!rows.length && !pending.decision && !pending.waiting) return false;

    const lines = ['📬 Ежедневная сводка', formatStats(rows, range, storage.statsExtra(range.from, range.to))];
    if (pending.decision || pending.waiting) {
      lines.push(`\n⏳ Сейчас ждут вашего решения: ${pending.decision}, ждём ответа людей: ${pending.waiting}. Откройте /pending.`);
    }
    await notifyOwner(lines.join('\n'));
    return true;
  }

  async function maybeSendDigest() {
    if (config.digestHour === null || config.digestHour === undefined) return false;
    const local = localDate(Math.floor(Date.now() / 1000));
    if (local.getUTCHours() < config.digestHour) return false;
    const today = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
    if (storage.getMeta('digest_last_date') === today) return false;
    storage.setMeta('digest_last_date', today); // отмечаем до отправки, чтобы не продублировать
    return sendDigest();
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
    if (!record || !['awaiting_reply', 'manual_review', 'action_failed'].includes(record.status)) return;

    storage.updateCase(record.id, record.status, record.reason, {
      lastUserMessageAt: Math.floor(Date.now() / 1000)
    });
    const replyText = (message.text || message.caption || '').trim();
    if (!replyText) {
      if (record.status === 'awaiting_reply') {
        await ctx.reply('Пожалуйста, ответьте текстом, чтобы администратор мог рассмотреть вашу заявку.');
      }
      return;
    }

    // Ответы не анализируются автоматически: решение всегда принимает владелец.
    // Первый ответ создаёт карточку (с уведомлением), следующие дописываются в неё молча.
    const firstReply = !record.user_reply;
    storage.appendReply(record.id, replyText.slice(0, 1000));
    if (record.status === 'awaiting_reply') storage.updateCase(record.id, 'manual_review', 'user_replied');
    // Человек мог поправить профиль, пока отвечал: подтягиваем актуальные ник и bio.
    try {
      const chat = await bot.telegram.getChat(message.from.id);
      storage.setCurrentProfile(record.id, { bio: chat.bio || '', username: chat.username || '' });
    } catch (error) {
      console.warn('[profile refresh]', error.message);
    }
    await renderCard(record.id);
    if (firstReply) {
      await ctx.reply('Спасибо за ответ! Я передал информацию администратору для рассмотрения заявки.');
    }
  }

  async function onOwnerCallback(ctx) {
    const callback = ctx.callbackQuery;
    if (String(ctx.from.id) !== String(config.ownerId)) {
      await ctx.answerCbQuery('Эта кнопка доступна только владельцу.', { show_alert: true });
      return;
    }
    if (String(callback.data || '').startsWith('auto:')) return onAutoCallback(ctx);
    const match = /^case:(approve|reject|rejectask|cancel|hold):(\d+)$/.exec(callback.data || '');
    if (!match) return;
    const [, action, idText] = match;
    const record = storage.getCaseById(Number(idText));
    if (!record) {
      await ctx.answerCbQuery('Заявка не найдена.', { show_alert: true });
      return;
    }

    // Кнопка нажата в списке /pending или на карточке заявки?
    const fromList = String(callback.message?.text || '').startsWith(LIST_HEADER);
    if (!fromList && !record.card_message_id && callback.message) {
      storage.setCardMessage(record.id, callback.message.message_id); // карточки старого формата тоже обновляем
    }

    if (FINAL_STATUSES.includes(record.status)) {
      await ctx.answerCbQuery(`Заявка уже обработана (статус: ${record.status}).`, { show_alert: true });
      await renderCard(record.id);
      if (fromList) await refreshList(ctx);
      return;
    }
    if (action === 'cancel') {
      await ctx.answerCbQuery();
      await refreshList(ctx);
      return;
    }
    if (action === 'rejectask') { // второй шаг для отказа из списка
      await ctx.answerCbQuery();
      await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([[
        Markup.button.callback(`❌ Да, отклонить #${record.id}`, `case:reject:${record.id}`),
        Markup.button.callback('↩️ Отмена', `case:cancel:${record.id}`)
      ]]).reply_markup).catch(() => {});
      return;
    }
    if (action === 'hold') { // кнопка из карточек старого формата
      await ctx.answerCbQuery('Заявка остаётся в списке открытых.');
      return;
    }
    if (busy.has(record.id)) {
      await ctx.answerCbQuery('Заявка уже обрабатывается.');
      return;
    }

    busy.add(record.id);
    try {
      const ok = action === 'approve'
        ? await approveCase(record)
        : await declineCase(record, 'owner_rejected');

      if (ok) {
        await ctx.answerCbQuery(action === 'approve' ? 'Заявка одобрена.' : 'Заявка отклонена.');
      } else if (storage.getCaseById(record.id).status === 'closed') {
        await ctx.answerCbQuery('Заявка уже закрыта в Telegram (отозвана или обработана вручную).', { show_alert: true });
      } else {
        await ctx.answerCbQuery('Не удалось выполнить действие — подробности в карточке заявки.', { show_alert: true });
      }
      if (fromList) await refreshList(ctx);
    } finally {
      busy.delete(record.id);
    }
  }

  async function ownerCommand(ctx) {
    if (String(ctx.from.id) !== String(config.ownerId)) return;
    const text = ctx.message.text || '';
    const command = text.split(/\s+/)[0].split('@')[0];

    if (command === '/pending') {
      const list = buildPendingList();
      await ctx.reply(list.text, list.extra);
    } else if (command === '/stats') {
      const range = statsRange(text.split(/\s+/)[1], Math.floor(Date.now() / 1000));
      if (!range) {
        return ctx.reply('Использование: /stats — с понедельника, /stats prev — прошлая неделя, /stats 30 — последние 30 дней, /stats all — всё время.');
      }
      await ctx.reply(formatStats(storage.statsBetween(range.from, range.to), range, storage.statsExtra(range.from, range.to)));
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
    } else if (command === '/auto') {
      const arg = text.split(/\s+/)[1];
      const hours = arg === undefined ? 24 : Number(arg);
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
        return ctx.reply('Использование: /auto — за последние 24 часа, /auto 72 — за 72 часа (до 720).');
      }
      const page = buildAutoPage('all', 0, hours);
      await ctx.reply(page.text, page.extra);
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
        'Как это работает: бот сам принимает и отклоняет очевидные заявки (без сообщений). ' +
        'Сомнительные приходят вам одной карточкой с кнопками — после решения карточка сворачивается в строку. ' +
        'Раз в сутки приходит сводка.\n\n' +
        '/pending — список открытых заявок с кнопками\n' +
        '/auto — кого бот принял или отклонил сам за 24 часа (/auto 72 — за 72 часа)\n' +
        '/stats — статистика с понедельника (/stats prev — прошлая неделя, /stats 30 — за 30 дней, /stats all — всё время)\n' +
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

  return {
    onJoinRequest, onPrivateMessage, onOwnerCallback, ownerCommand,
    recoverInterrupted, onStart, maybeSendDigest, sendDigest
  };
}

module.exports = { createHandlers };
