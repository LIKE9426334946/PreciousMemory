const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

class ConversationStore {
  constructor(databasePath) {
    this.databasePath = databasePath;
    this.db = null;
    this.statements = {};
  }

  init() {
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new Database(this.databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("temp_store = MEMORY");

    this.initializeSchema();
    this.prepareStatements();
    this.prepareTransactions();
  }

  initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );

      INSERT OR IGNORE INTO metadata (key, value)
      VALUES ('global_revision', 0), ('activity_counter', 0);

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        next_message_seq INTEGER NOT NULL DEFAULT 1,
        message_count INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_sort_order
      ON conversations (sort_order DESC);

      CREATE TABLE IF NOT EXISTS messages (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        sender TEXT NOT NULL CHECK (sender IN ('A', 'B')),
        content TEXT NOT NULL,
        edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
          ON DELETE CASCADE,
        UNIQUE (conversation_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq
      ON messages (conversation_id, seq);

      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts
      USING fts5(content, tokenize='trigram');

      CREATE TRIGGER IF NOT EXISTS messages_fts_insert
      AFTER INSERT ON messages
      BEGIN
        INSERT INTO message_fts(rowid, content)
        VALUES (new.row_id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_delete
      AFTER DELETE ON messages
      BEGIN
        DELETE FROM message_fts WHERE rowid = old.row_id;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_update
      AFTER UPDATE OF content ON messages
      BEGIN
        DELETE FROM message_fts WHERE rowid = old.row_id;
        INSERT INTO message_fts(rowid, content)
        VALUES (new.row_id, new.content);
      END;
    `);
  }

  prepareStatements() {
    this.statements.getMetadata = this.db.prepare(
      "SELECT value FROM metadata WHERE key = ?",
    );
    this.statements.incrementGlobalRevision = this.db.prepare(`
      UPDATE metadata
      SET value = value + 1
      WHERE key = 'global_revision'
    `);
    this.statements.nextActivity = this.db.prepare(`
      UPDATE metadata
      SET value = value + 1
      WHERE key = 'activity_counter'
      RETURNING value
    `);

    this.statements.listConversations = this.db.prepare(`
      SELECT
        c.id,
        c.name,
        c.revision,
        c.message_count,
        c.sort_order,
        COALESCE((
          SELECT m.content
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.seq DESC
          LIMIT 1
        ), '') AS last_message_preview
      FROM conversations c
      ORDER BY c.sort_order DESC, c.name ASC
    `);
    this.statements.getConversation = this.db.prepare(`
      SELECT
        c.id,
        c.name,
        c.revision,
        c.next_message_seq,
        c.message_count,
        c.sort_order,
        COALESCE((
          SELECT m.content
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.seq DESC
          LIMIT 1
        ), '') AS last_message_preview
      FROM conversations c
      WHERE c.id = ?
    `);
    this.statements.insertConversation = this.db.prepare(`
      INSERT INTO conversations (
        id, name, revision, next_message_seq, message_count, sort_order
      )
      VALUES (?, ?, 0, 1, 0, ?)
    `);
    this.statements.renameConversation = this.db.prepare(`
      UPDATE conversations
      SET name = ?, revision = revision + 1
      WHERE id = ?
    `);
    this.statements.deleteConversation = this.db.prepare(
      "DELETE FROM conversations WHERE id = ?",
    );

    this.statements.insertMessage = this.db.prepare(`
      INSERT INTO messages (id, conversation_id, seq, sender, content, edited)
      VALUES (?, ?, ?, ?, ?, 0)
    `);
    this.statements.updateConversationAfterMessage = this.db.prepare(`
      UPDATE conversations
      SET
        next_message_seq = next_message_seq + 1,
        message_count = message_count + 1,
        revision = revision + 1,
        sort_order = ?
      WHERE id = ?
    `);
    this.statements.getMessage = this.db.prepare(`
      SELECT id, conversation_id, seq, sender, content, edited
      FROM messages
      WHERE conversation_id = ? AND id = ?
    `);
    this.statements.getMessageBySeq = this.db.prepare(`
      SELECT id, conversation_id, seq, sender, content, edited
      FROM messages
      WHERE conversation_id = ? AND seq = ?
    `);
    this.statements.updateMessage = this.db.prepare(`
      UPDATE messages
      SET content = ?, edited = 1
      WHERE conversation_id = ? AND id = ?
    `);
    this.statements.touchConversation = this.db.prepare(`
      UPDATE conversations
      SET revision = revision + 1, sort_order = ?
      WHERE id = ?
    `);
    this.statements.deleteMessage = this.db.prepare(`
      DELETE FROM messages
      WHERE conversation_id = ? AND id = ?
    `);
    this.statements.updateConversationAfterDelete = this.db.prepare(`
      UPDATE conversations
      SET
        message_count = MAX(0, message_count - 1),
        revision = revision + 1,
        sort_order = ?
      WHERE id = ?
    `);

    this.statements.listLatestMessages = this.db.prepare(`
      SELECT id, conversation_id, seq, sender, content, edited
      FROM messages
      WHERE conversation_id = ?
      ORDER BY seq DESC
      LIMIT ?
    `);
    this.statements.listMessagesBefore = this.db.prepare(`
      SELECT id, conversation_id, seq, sender, content, edited
      FROM messages
      WHERE conversation_id = ? AND seq < ?
      ORDER BY seq DESC
      LIMIT ?
    `);
    this.statements.listMessagesAfter = this.db.prepare(`
      SELECT id, conversation_id, seq, sender, content, edited
      FROM messages
      WHERE conversation_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `);
    this.statements.hasMessageBefore = this.db.prepare(`
      SELECT 1 AS found
      FROM messages
      WHERE conversation_id = ? AND seq < ?
      LIMIT 1
    `);
    this.statements.hasMessageAfter = this.db.prepare(`
      SELECT 1 AS found
      FROM messages
      WHERE conversation_id = ? AND seq > ?
      LIMIT 1
    `);
    this.statements.latestMessageSeq = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS latest_seq
      FROM messages
      WHERE conversation_id = ?
    `);

    this.statements.searchConversationNames = this.db.prepare(`
      SELECT id, name, revision, message_count, sort_order
      FROM conversations
      WHERE instr(lower(name), lower(?)) > 0
      ORDER BY sort_order DESC
      LIMIT ?
    `);
    this.statements.searchMessagesFts = this.db.prepare(`
      SELECT
        m.id AS message_id,
        m.conversation_id,
        m.seq,
        m.sender,
        m.content,
        c.name AS conversation_name,
        c.sort_order
      FROM message_fts
      JOIN messages m ON m.row_id = message_fts.rowid
      JOIN conversations c ON c.id = m.conversation_id
      WHERE message_fts MATCH ?
      ORDER BY c.sort_order DESC, m.seq DESC
      LIMIT ?
    `);
    this.statements.searchMessagesLike = this.db.prepare(`
      SELECT
        m.id AS message_id,
        m.conversation_id,
        m.seq,
        m.sender,
        m.content,
        c.name AS conversation_name,
        c.sort_order
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE instr(lower(m.content), lower(?)) > 0
      ORDER BY c.sort_order DESC, m.seq DESC
      LIMIT ?
    `);
  }

  prepareTransactions() {
    this.createConversationTransaction = this.db.transaction((name) => {
      const id = crypto.randomUUID();
      const sortOrder = this.nextActivity();
      this.statements.insertConversation.run(id, name, sortOrder);
      this.incrementGlobalRevision();
      return this.summarizeConversation(this.statements.getConversation.get(id));
    });

    this.renameConversationTransaction = this.db.transaction((id, name) => {
      if (!this.statements.getConversation.get(id)) {
        return null;
      }

      this.statements.renameConversation.run(name, id);
      this.incrementGlobalRevision();
      return this.summarizeConversation(this.statements.getConversation.get(id));
    });

    this.removeConversationTransaction = this.db.transaction((id) => {
      const result = this.statements.deleteConversation.run(id);
      if (result.changes === 0) {
        return false;
      }

      this.incrementGlobalRevision();
      return true;
    });

    this.addMessageTransaction = this.db.transaction(
      (conversationId, sender, content) => {
        const conversation = this.statements.getConversation.get(conversationId);
        if (!conversation) {
          return null;
        }

        const id = crypto.randomUUID();
        const seq = conversation.next_message_seq;
        const sortOrder = this.nextActivity();
        this.statements.insertMessage.run(
          id,
          conversationId,
          seq,
          sender,
          content,
        );
        this.statements.updateConversationAfterMessage.run(
          sortOrder,
          conversationId,
        );
        this.incrementGlobalRevision();

        return {
          conversation: this.summarizeConversation(
            this.statements.getConversation.get(conversationId),
          ),
          message: this.presentStoredMessage(
            this.statements.getMessage.get(conversationId, id),
          ),
        };
      },
    );

    this.updateMessageTransaction = this.db.transaction(
      (conversationId, messageId, content) => {
        const conversation = this.statements.getConversation.get(conversationId);
        if (!conversation) {
          return { conversationFound: false, message: null };
        }

        if (!this.statements.getMessage.get(conversationId, messageId)) {
          return { conversationFound: true, message: null };
        }

        const sortOrder = this.nextActivity();
        this.statements.updateMessage.run(content, conversationId, messageId);
        this.statements.touchConversation.run(sortOrder, conversationId);
        this.incrementGlobalRevision();

        return {
          conversationFound: true,
          conversation: this.summarizeConversation(
            this.statements.getConversation.get(conversationId),
          ),
          message: this.presentStoredMessage(
            this.statements.getMessage.get(conversationId, messageId),
          ),
        };
      },
    );

    this.removeMessageTransaction = this.db.transaction(
      (conversationId, messageId) => {
        if (!this.statements.getConversation.get(conversationId)) {
          return { conversationFound: false, removed: false };
        }

        const result = this.statements.deleteMessage.run(
          conversationId,
          messageId,
        );
        if (result.changes === 0) {
          return { conversationFound: true, removed: false };
        }

        const sortOrder = this.nextActivity();
        this.statements.updateConversationAfterDelete.run(
          sortOrder,
          conversationId,
        );
        this.incrementGlobalRevision();

        return {
          conversationFound: true,
          removed: true,
          conversation: this.summarizeConversation(
            this.statements.getConversation.get(conversationId),
          ),
        };
      },
    );
  }

  nextActivity() {
    return this.statements.nextActivity.get().value;
  }

  incrementGlobalRevision() {
    this.statements.incrementGlobalRevision.run();
  }

  getGlobalRevision() {
    return this.statements.getMetadata.get("global_revision").value;
  }

  summarizeConversation(row) {
    const preview = String(row.last_message_preview || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);

    return {
      id: row.id,
      name: row.name,
      revision: row.revision,
      messageCount: row.message_count,
      lastMessagePreview: preview,
      sortOrder: row.sort_order,
    };
  }

  presentStoredMessage(row) {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      seq: row.seq,
      sender: row.sender,
      content: row.content,
      edited: Boolean(row.edited),
    };
  }

  listConversations() {
    return {
      revision: this.getGlobalRevision(),
      conversations: this.statements.listConversations
        .all()
        .map((row) => this.summarizeConversation(row)),
    };
  }

  createConversation(name) {
    return this.createConversationTransaction(name);
  }

  renameConversation(id, name) {
    return this.renameConversationTransaction(id, name);
  }

  removeConversation(id) {
    return this.removeConversationTransaction(id);
  }

  listMessages(
    conversationId,
    { limit = 60, before = null, after = null, around = null } = {},
  ) {
    const conversationRow = this.statements.getConversation.get(conversationId);
    if (!conversationRow) {
      return null;
    }

    let rows;
    let searchTargetFound = false;

    if (around) {
      const target = this.statements.getMessage.get(conversationId, around);

      if (target) {
        rows = this.listMessagesAround(conversationId, target.seq, limit);
        searchTargetFound = true;
      } else {
        rows = this.statements.listLatestMessages
          .all(conversationId, limit)
          .reverse();
      }
    } else if (Number.isInteger(after)) {
      rows = this.statements.listMessagesAfter.all(
        conversationId,
        after,
        limit,
      );
    } else if (Number.isInteger(before)) {
      rows = this.statements.listMessagesBefore
        .all(conversationId, before, limit)
        .reverse();
    } else {
      rows = this.statements.listLatestMessages
        .all(conversationId, limit)
        .reverse();
    }

    const firstSeq = rows[0]?.seq || 0;
    const lastSeq = rows.at(-1)?.seq || 0;
    const hasMore = Boolean(
      firstSeq &&
        this.statements.hasMessageBefore.get(conversationId, firstSeq),
    );
    const hasNewer = Boolean(
      lastSeq && this.statements.hasMessageAfter.get(conversationId, lastSeq),
    );

    return {
      conversation: this.summarizeConversation(conversationRow),
      messages: rows.map((row) => this.presentStoredMessage(row)),
      hasMore,
      hasNewer,
      olderCursor: hasMore ? firstSeq : null,
      latestSeq:
        this.statements.latestMessageSeq.get(conversationId).latest_seq,
      conversationRevision: conversationRow.revision,
      total: conversationRow.message_count,
      searchTargetFound,
    };
  }

  listMessagesAround(conversationId, targetSeq, limit) {
    const olderLimit = Math.floor((limit - 1) / 2);
    let older = this.statements.listMessagesBefore
      .all(conversationId, targetSeq, olderLimit)
      .reverse();
    const target = this.statements.getMessageBySeq.get(
      conversationId,
      targetSeq,
    );
    const newerLimit = Math.max(0, limit - older.length - 1);
    const newer = this.statements.listMessagesAfter.all(
      conversationId,
      targetSeq,
      newerLimit,
    );

    const remaining = limit - older.length - 1 - newer.length;
    if (remaining > 0 && older.length > 0) {
      const additional = this.statements.listMessagesBefore
        .all(conversationId, older[0].seq, remaining)
        .reverse();
      older = [...additional, ...older];
    }

    return [...older, target, ...newer].filter(Boolean);
  }

  addMessage(conversationId, { sender, content }) {
    return this.addMessageTransaction(conversationId, sender, content);
  }

  updateMessage(conversationId, messageId, content) {
    return this.updateMessageTransaction(
      conversationId,
      messageId,
      content,
    );
  }

  removeMessage(conversationId, messageId) {
    return this.removeMessageTransaction(conversationId, messageId);
  }

  search(query, limit = 80) {
    const conversationLimit = Math.min(20, limit);
    const conversationRows = this.statements.searchConversationNames.all(
      query,
      conversationLimit,
    );
    const results = conversationRows.map((row) => ({
      type: "conversation",
      conversationId: row.id,
      conversationName: row.name,
      messageId: null,
      sender: null,
      snippet: `${row.message_count} 条聊天记录`,
    }));

    const remaining = Math.max(0, limit - results.length);
    if (remaining === 0) {
      return { query, results };
    }

    let messageRows;
    const characterCount = Array.from(query).length;

    if (characterCount >= 3) {
      try {
        const ftsQuery = `"${query.replace(/"/g, '""')}"`;
        messageRows = this.statements.searchMessagesFts.all(
          ftsQuery,
          remaining,
        );
      } catch {
        messageRows = this.statements.searchMessagesLike.all(query, remaining);
      }
    } else {
      messageRows = this.statements.searchMessagesLike.all(query, remaining);
    }

    for (const row of messageRows) {
      results.push({
        type: "message",
        conversationId: row.conversation_id,
        conversationName: row.conversation_name,
        messageId: row.message_id,
        sender: row.sender,
        snippet: this.makeSearchSnippet(row.content, query),
      });
    }

    return { query, results };
  }

  makeSearchSnippet(content, query) {
    const normalizedContent = content.toLocaleLowerCase();
    const normalizedQuery = query.toLocaleLowerCase();
    const matchIndex = normalizedContent.indexOf(normalizedQuery);
    const maximumLength = 120;

    if (content.length <= maximumLength) {
      return content.replace(/\s+/g, " ").trim();
    }

    const start = Math.max(0, matchIndex >= 0 ? matchIndex - 42 : 0);
    const end = Math.min(content.length, start + maximumLength);
    const snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
    return `${start > 0 ? "…" : ""}${snippet}${end < content.length ? "…" : ""}`;
  }

  getStats() {
    const conversationCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM conversations")
      .get().count;
    const messageCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM messages")
      .get().count;
    const characterCount = this.db
      .prepare("SELECT COALESCE(SUM(length(content)), 0) AS count FROM messages")
      .get().count;

    return {
      conversationCount,
      messageCount,
      characterCount,
    };
  }

  close() {
    if (this.db?.open) {
      this.db.close();
    }
  }
}

module.exports = {
  ConversationStore,
};
