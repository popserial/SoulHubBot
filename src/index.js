const { Telegraf } = require('telegraf');
const config = require('./config');
const { createStorage } = require('./storage');
const { createRulesProvider } = require('./rules');
const { createHandlers } = require('./handlers');
require('dotenv').config();

const OWNER_ID = Number(process.env.OWNER_ID);
if (!Number.isSafeInteger(OWNER_ID) || OWNER_ID <= 0) {
  throw new Error('OWNER_ID не задан или имеет неверный формат в .env');
}

const storage = createStorage(config.databasePath);
const bot = new Telegraf(config.botToken);

// Словари перечитываются автоматически, когда файлы меняются (командами бота или вручную).
const rulesProvider = createRulesProvider(config, {
  onError: (error) => bot.telegram.sendMessage(
    OWNER_ID,
    `⚠️ Не удалось перезагрузить словари, действуют прежние.\nОшибка: ${error.message}`
  ).catch(() => {})
});

function getRules() {
  return rulesProvider.get();
}

const handlers = createHandlers({ bot, config, storage, getRules });

bot.on('chat_join_request', handlers.onJoinRequest);
bot.on(['new_chat_members', 'left_chat_member'], async (ctx) => {
  if (String(ctx.chat.id) !== String(config.groupId)) return;
  try {
    await ctx.deleteMessage();
  } catch (error) {
    console.warn('[service message delete]', error.message);
  }
});
bot.on('message', async (ctx, next) => {
  try {
    const firstWord = (ctx.message?.text || '').split(/\s+/)[0].split('@')[0];
    if (ctx.chat?.type === 'private' && firstWord === '/start') {
      await handlers.onStart(ctx);
      return;
    }
    if (ctx.chat?.type === 'private' && ctx.message?.text?.startsWith('/')) {
      await handlers.ownerCommand(ctx);
    }
    await handlers.onPrivateMessage(ctx);
  } catch (error) {
    console.error('[message handler]', error);
  }
});
bot.on('callback_query', async (ctx) => {
  try {
    await handlers.onOwnerCallback(ctx);
  } catch (error) {
    console.error('[callback handler]', error);
    await ctx.answerCbQuery('Произошла ошибка.').catch(() => {});
  }
});

bot.catch((error) => {
  console.error('[telegraf error]', error);
});

async function shutdown(signal) {
  console.log(`Received ${signal}, stopping bot...`);
  try {
    await bot.stop(signal);
  } catch {}
  try {
    storage.close();
  } catch {}
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

const defaultCommands = [
  { command: 'start', description: 'Запустить бота' }
];

const ownerCommands = [
  { command: 'start', description: 'Запустить бота' },
  { command: 'pending', description: 'Открытые заявки' },
  { command: 'stats', description: 'Статистика заявок (с понедельника)' },
  { command: 'allow_add', description: 'Добавить фразу в разрешающий словарь' },
  { command: 'deny_add', description: 'Добавить фразу в запрещающий словарь' },
  { command: 'allow_remove', description: 'Удалить фразу из разрешающего словаря' },
  { command: 'deny_remove', description: 'Удалить фразу из запрещающего словаря' },
  { command: 'dictionaries', description: 'Количество фраз в словарях' },
  { command: 'backup', description: 'Прислать бэкап базы и словарей' },
  { command: 'forget', description: 'Сбросить отказы и снять блокировку пользователя' },
  { command: 'help', description: 'Справка по командам' },
];

// Устанавливаем команды для всех по умолчанию
bot.telegram.setMyCommands(defaultCommands, {
  scope: { type: 'default' }
}).then(() => {
  // Устанавливаем команды лично для владельца
  return bot.telegram.setMyCommands(ownerCommands, {
    scope: { type: 'chat', chat_id: OWNER_ID }
  });
}).catch((error) => {
  console.error('[setMyCommands failed]', error.message);
});

// В Telegraf 4 промис launch() завершается только при остановке бота, поэтому «запущен» пишем в onLaunch.
bot.launch({
  allowedUpdates: ['message', 'callback_query', 'chat_join_request']
}, () => {
  console.log('Soul Hub Moderation Bot started.');
  console.log(`Target group: ${config.groupId}`);
  handlers.recoverInterrupted().catch((error) => console.error('[recoverInterrupted]', error));
}).catch((error) => {
  console.error('Failed to launch bot:', error);
  process.exit(1);
});
