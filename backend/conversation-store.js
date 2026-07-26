const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const EMPTY_STORE = {
  version: 2,
  revision: 0,
  conversations: [],
};

function cloneEmptyStore() {
  return JSON.parse(JSON.stringify(EMPTY_STORE));
}

function now() {
  return new Date().toISOString();
}

class ConversationStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = cloneEmptyStore();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);

      if (parsed?.version === 2 && Array.isArray(parsed.conversations)) {
        this.data = this.normalize(parsed);
      } else {
        this.data = cloneEmptyStore();
        await this.persist();
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      this.data = cloneEmptyStore();
      await this.persist();
    }
  }

  normalize(input) {
    const conversations = input.conversations
      .filter((conversation) => conversation && typeof conversation === "object")
      .map((conversation) => this.normalizeConversation(conversation));

    return {
      version: 2,
      revision: Number.isInteger(input.revision) ? input.revision : 0,
      conversations,
    };
  }

  normalizeConversation(conversation) {
    const timestamp = now();
    const messages = Array.isArray(conversation.messages)
      ? conversation.messages
          .filter((message) => message && typeof message === "object")
          .map((message, index) => ({
            id: message.id || crypto.randomUUID(),
            seq: Number.isInteger(message.seq) ? message.seq : index + 1,
            sender: message.sender === "B" ? "B" : "A",
            content: String(message.content || ""),
            createdAt: message.createdAt || timestamp,
            updatedAt: message.updatedAt || message.createdAt || timestamp,
          }))
          .sort((a, b) => a.seq - b.seq)
      : [];

    const highestSeq = messages.reduce(
      (maximum, message) => Math.max(maximum, message.seq),
      0,
    );

    return {
      id: conversation.id || crypto.randomUUID(),
      name: String(conversation.name || "未命名对话").trim() || "未命名对话",
      revision: Number.isInteger(conversation.revision)
        ? conversation.revision
        : 0,
      nextMessageSeq: Math.max(
        Number.isInteger(conversation.nextMessageSeq)
          ? conversation.nextMessageSeq
          : 1,
        highestSeq + 1,
      ),
      createdAt: conversation.createdAt || timestamp,
      updatedAt: conversation.updatedAt || conversation.createdAt || timestamp,
      messages,
    };
  }

  listConversations() {
    return {
      revision: this.data.revision,
      conversations: this.data.conversations
        .map((conversation) => this.summarizeConversation(conversation))
        .sort((a, b) => {
          const timeDifference =
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
          return timeDifference || a.name.localeCompare(b.name, "zh-CN");
        }),
    };
  }

  summarizeConversation(conversation) {
    const lastMessage = conversation.messages.at(-1) || null;
    const preview = lastMessage
      ? lastMessage.content.replace(/\s+/g, " ").trim().slice(0, 80)
      : "";

    return {
      id: conversation.id,
      name: conversation.name,
      revision: conversation.revision,
      messageCount: conversation.messages.length,
      lastMessagePreview: preview,
      lastMessageAt: lastMessage?.createdAt || null,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  async createConversation(name) {
    return this.mutate((data) => {
      const timestamp = now();
      const conversation = {
        id: crypto.randomUUID(),
        name,
        revision: 0,
        nextMessageSeq: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
      };

      data.revision += 1;
      data.conversations.push(conversation);
      return this.summarizeConversation(conversation);
    });
  }

  async renameConversation(id, name) {
    return this.mutate((data) => {
      const conversation = data.conversations.find((item) => item.id === id);

      if (!conversation) {
        return null;
      }

      conversation.name = name;
      conversation.revision += 1;
      conversation.updatedAt = now();
      data.revision += 1;
      return this.summarizeConversation(conversation);
    });
  }

  async removeConversation(id) {
    return this.mutate((data) => {
      const index = data.conversations.findIndex((item) => item.id === id);

      if (index === -1) {
        return false;
      }

      data.conversations.splice(index, 1);
      data.revision += 1;
      return true;
    });
  }

  listMessages(conversationId, { limit = 60, before = null, after = null } = {}) {
    const conversation = this.data.conversations.find(
      (item) => item.id === conversationId,
    );

    if (!conversation) {
      return null;
    }

    let candidates = conversation.messages;
    let page;
    let hasMore = false;

    if (Number.isInteger(after)) {
      candidates = candidates.filter((message) => message.seq > after);
      page = candidates.slice(0, limit);
      hasMore = candidates.length > page.length;
    } else {
      if (Number.isInteger(before)) {
        candidates = candidates.filter((message) => message.seq < before);
      }

      const start = Math.max(0, candidates.length - limit);
      page = candidates.slice(start);
      hasMore = start > 0;
    }

    const newest = conversation.messages.at(-1);

    return {
      conversation: this.summarizeConversation(conversation),
      messages: page.map((message) => ({ ...message })),
      hasMore,
      olderCursor: hasMore && page.length > 0 ? page[0].seq : null,
      latestSeq: newest ? newest.seq : 0,
      conversationRevision: conversation.revision,
      total: conversation.messages.length,
    };
  }

  async addMessage(conversationId, { sender, content }) {
    return this.mutate((data) => {
      const conversation = data.conversations.find(
        (item) => item.id === conversationId,
      );

      if (!conversation) {
        return null;
      }

      const timestamp = now();
      const message = {
        id: crypto.randomUUID(),
        seq: conversation.nextMessageSeq,
        sender,
        content,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      conversation.nextMessageSeq += 1;
      conversation.revision += 1;
      conversation.updatedAt = timestamp;
      conversation.messages.push(message);
      data.revision += 1;

      return {
        conversation: this.summarizeConversation(conversation),
        message: { ...message },
      };
    });
  }

  async updateMessage(conversationId, messageId, content) {
    return this.mutate((data) => {
      const conversation = data.conversations.find(
        (item) => item.id === conversationId,
      );

      if (!conversation) {
        return { conversationFound: false, message: null };
      }

      const message = conversation.messages.find((item) => item.id === messageId);

      if (!message) {
        return { conversationFound: true, message: null };
      }

      const timestamp = now();
      message.content = content;
      message.updatedAt = timestamp;
      conversation.revision += 1;
      conversation.updatedAt = timestamp;
      data.revision += 1;

      return {
        conversationFound: true,
        conversation: this.summarizeConversation(conversation),
        message: { ...message },
      };
    });
  }

  async removeMessage(conversationId, messageId) {
    return this.mutate((data) => {
      const conversation = data.conversations.find(
        (item) => item.id === conversationId,
      );

      if (!conversation) {
        return { conversationFound: false, removed: false };
      }

      const index = conversation.messages.findIndex(
        (message) => message.id === messageId,
      );

      if (index === -1) {
        return { conversationFound: true, removed: false };
      }

      conversation.messages.splice(index, 1);
      conversation.revision += 1;
      conversation.updatedAt = now();
      data.revision += 1;

      return {
        conversationFound: true,
        removed: true,
        conversation: this.summarizeConversation(conversation),
      };
    });
  }

  async mutate(operation) {
    const run = this.writeQueue.then(async () => {
      const result = operation(this.data);
      await this.persist();
      return result;
    });

    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const serialized = `${JSON.stringify(this.data, null, 2)}\n`;

    await fs.writeFile(temporaryPath, serialized, "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }
}

module.exports = {
  ConversationStore,
};

