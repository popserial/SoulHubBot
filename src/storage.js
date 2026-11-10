const Database = require('better-sqlite3');

const OPEN_STATUSES = "('manual_review', 'awaiting_reply', 'awaiting_profile_update', 'action_failed')";

const AUTO_SQL = `
  SELECT * FROM cases
  WHERE created_at >= @from AND created_at < @to
    AND (route IN ('approve', 'reject') OR reason = 'active_ban')
    AND (@kind = 'all' OR (CASE WHEN reason = 'active_ban' THEN 'reject' ELSE route END) = @kind)`;

function createStorage(filePath) {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      request_date INTEGER NOT NULL,
      status TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      bio TEXT,
      display_name TEXT,
      reason TEXT,
      matches_json TEXT NOT NULL DEFAULT '{}',
      prompt_type TEXT,
      prompt_sent_at INTEGER,
      last_user_message_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(chat_id, user_id, request_date)
    );

    CREATE INDEX IF NOT EXISTS idx_cases_user_status ON cases(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);

    CREATE TABLE IF NOT EXISTS refusal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      case_id INTEGER,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY(case_id) REFERENCES cases(id)
    );

    CREATE INDEX IF NOT EXISTS idx_refusals_user ON refusal_events(chat_id, user_id);

    CREATE TABLE IF NOT EXISTS user_bans (
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      until_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY(chat_id, user_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Миграция для существующих баз: что решил бот (route, route_reason), карточка в чате владельца
  // (card_message_id), число повторных подач (repeat_count), ответ человека (user_reply), актуальное bio после ответа (current_bio).
  const caseColumns = db.prepare('PRAGMA table_info(cases)').all().map((column) => column.name);
  for (const [column, type] of [
    ['route', 'TEXT'], ['route_reason', 'TEXT'], ['card_message_id', 'INTEGER'],
    ['repeat_count', 'INTEGER NOT NULL DEFAULT 0'], ['user_reply', 'TEXT'],
    ['current_bio', 'TEXT']
  ]) {
    if (!caseColumns.includes(column)) db.exec(`ALTER TABLE cases ADD COLUMN ${column} ${type}`);
  }

  const insertCase = db.prepare(`
    INSERT OR IGNORE INTO cases
      (chat_id, user_id, request_date, status, first_name, last_name, username, bio, display_name, reason, matches_json, route, route_reason)
    VALUES
      (@chatId, @userId, @requestDate, @status, @firstName, @lastName, @username, @bio, @displayName, @reason, @matchesJson, @route, @routeReason)
  `);
  const getCaseByRequest = db.prepare(`
    SELECT * FROM cases WHERE chat_id = ? AND user_id = ? AND request_date = ?
  `);
  const getLatestCase = db.prepare(`
    SELECT * FROM cases WHERE chat_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1
  `);
  const updateCase = db.prepare(`
    UPDATE cases SET status = @status, reason = COALESCE(@reason, reason),
      prompt_type = COALESCE(@promptType, prompt_type),
      prompt_sent_at = COALESCE(@promptSentAt, prompt_sent_at),
      last_user_message_at = COALESCE(@lastUserMessageAt, last_user_message_at),
      updated_at = unixepoch()
    WHERE id = @id
  `);

  return {
    db,
    createCase(data) {
      const existing = getCaseByRequest.get(data.chatId, data.userId, data.requestDate);
      if (existing) return { record: existing, created: false };
      insertCase.run({ route: null, routeReason: null, ...data });
      return { record: getCaseByRequest.get(data.chatId, data.userId, data.requestDate), created: true };
    },
    getCaseById(id) {
      return db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
    },
    getCaseByRequest(chatId, userId, requestDate) {
      return getCaseByRequest.get(String(chatId), String(userId), Number(requestDate));
    },
    getLatestCase(chatId, userId) {
      return getLatestCase.get(String(chatId), String(userId));
    },
    updateCase(id, status, reason = null, extra = {}) {
      updateCase.run({
        id,
        status,
        reason,
        promptType: extra.promptType ?? null,
        promptSentAt: extra.promptSentAt ?? null,
        lastUserMessageAt: extra.lastUserMessageAt ?? null
      });
    },
    countRefusals(chatId, userId) {
      return db.prepare('SELECT COUNT(*) AS count FROM refusal_events WHERE chat_id = ? AND user_id = ?')
        .get(String(chatId), String(userId)).count;
    },
    clearRefusals(chatId, userId) {
      return db.prepare(
        'DELETE FROM refusal_events WHERE chat_id = ? AND user_id = ?'
      ).run(String(chatId), String(userId)).changes;
    },
    addRefusal(chatId, userId, caseId, reason) {
      db.prepare(`
        INSERT INTO refusal_events (chat_id, user_id, case_id, reason)
        VALUES (?, ?, ?, ?)
      `).run(String(chatId), String(userId), caseId ?? null, reason);
      return this.countRefusals(chatId, userId);
    },
    // Открытая заявка человека: ждёт решения владельца или ответа человека.
    getOpenCase(chatId, userId) {
      return db.prepare(`
        SELECT * FROM cases
        WHERE chat_id = ? AND user_id = ? AND status IN ${OPEN_STATUSES}
        ORDER BY id DESC LIMIT 1
      `).get(String(chatId), String(userId));
    },
    setCardMessage(id, messageId) {
      db.prepare('UPDATE cases SET card_message_id = ? WHERE id = ?').run(messageId, id);
    },
    // Актуальные данные профиля, полученные от Telegram после ответа человека.
    setCurrentProfile(id, { bio, username }) {
      db.prepare('UPDATE cases SET current_bio = @bio, username = @username, updated_at = unixepoch() WHERE id = @id')
        .run({ id, bio, username });
    },
    appendReply(id, text) {
      db.prepare(`
        UPDATE cases SET updated_at = unixepoch(),
          user_reply = substr(CASE WHEN user_reply IS NULL OR user_reply = '' THEN @text
                                   ELSE user_reply || char(10) || @text END, 1, 1500)
        WHERE id = @id
      `).run({ id, text });
    },
    // Повторная подача при открытой заявке: обновляем данные в той же записи.
    refreshCase(id, data) {
      db.prepare(`
        UPDATE cases SET request_date = @requestDate, first_name = @firstName, last_name = @lastName,
          username = @username, bio = @bio, display_name = @displayName, matches_json = @matchesJson,
          route = COALESCE(@route, route), route_reason = COALESCE(@routeReason, route_reason),
          repeat_count = repeat_count + 1, current_bio = NULL, updated_at = unixepoch()
        WHERE id = @id
      `).run({ id, route: null, routeReason: null, ...data });
    },
    // Сначала то, что ждёт решения владельца, потом то, что ждёт ответа человека.
    listPendingCases(limit = 15) {
      return db.prepare(`
        SELECT * FROM cases WHERE status IN ${OPEN_STATUSES}
        ORDER BY (status = 'awaiting_reply') ASC, created_at ASC LIMIT ?
      `).all(limit);
    },
    countPending() {
      const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM cases WHERE status IN ${OPEN_STATUSES} GROUP BY status`).all();
      const waiting = rows.filter((r) => r.status === 'awaiting_reply').reduce((acc, r) => acc + r.n, 0);
      const total = rows.reduce((acc, r) => acc + r.n, 0);
      return { decision: total - waiting, waiting };
    },
    getMeta(key) {
      return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
    },
    setMeta(key, value) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(value));
    },
    statsExtra(fromSec, toSec) {
      const cases = db.prepare(`
        SELECT COALESCE(SUM(repeat_count), 0) AS merged,
               COALESCE(SUM(route_reason = 'repeat_rejected'), 0) AS silent
        FROM cases WHERE created_at >= ? AND created_at < ?
      `).get(fromSec, toSec);
      const bans = db.prepare('SELECT COUNT(*) AS n FROM user_bans WHERE created_at >= ? AND created_at < ?')
        .get(fromSec, toSec).n;
      return { merged: cases.merged, silent: cases.silent, bans };
    },
    // Заявки, обработка которых была прервана (процесс упал после создания записи).
    recoverInterrupted() {
      return db.prepare(`
        UPDATE cases SET status = 'manual_review', reason = 'interrupted', updated_at = unixepoch()
        WHERE status = 'received'
      `).run().changes;
    },
    // Автоматические решения бота (без участия владельца): принятые, отклонённые, отклонённые по бану.
    listAutoCases({ from, to, kind, limit, offset }) {
      return db.prepare(`${AUTO_SQL} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`)
        .all({ from, to, kind, limit, offset });
    },
    countAuto({ from, to, kind }) {
      return db.prepare(`SELECT COUNT(*) AS n FROM (${AUTO_SQL})`).get({ from, to, kind }).n;
    },
    statsBetween(fromSec, toSec) {
      return db.prepare(`
        SELECT route, route_reason AS routeReason, status, reason, COUNT(*) AS n
        FROM cases WHERE created_at >= ? AND created_at < ?
        GROUP BY route, route_reason, status, reason
      `).all(fromSec, toSec);
    },
    saveBan(chatId, userId, untilAt, reason) {
      db.prepare(`
        INSERT INTO user_bans (chat_id, user_id, until_at, reason)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id, user_id) DO UPDATE SET
          until_at = excluded.until_at, reason = excluded.reason, created_at = unixepoch()
      `).run(String(chatId), String(userId), untilAt, reason);
    },
    getBan(chatId, userId) {
      return db.prepare('SELECT * FROM user_bans WHERE chat_id = ? AND user_id = ?')
        .get(String(chatId), String(userId));
    },
    clearBan(chatId, userId) {
      db.prepare('DELETE FROM user_bans WHERE chat_id = ? AND user_id = ?')
        .run(String(chatId), String(userId));
    },
    backupTo(filePath) {
      return db.backup(filePath);
    },
    close() {
      db.close();
    }
  };
}

module.exports = { createStorage };
