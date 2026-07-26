const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const EMPTY_STORE = {
  version: 1,
  revision: 0,
  nextSeq: 1,
  messages: [],
};

function cloneEmptyStore() {
  return JSON.parse(JSON.stringify(EMPTY_STORE));
}

class MessageStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = cloneEmptyStore();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = this.normalize(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      this.data = cloneEmptyStore();
      await this.persist();
    }
  }

  normalize(input) {
    if (Array.isArray(input)) {
      const messages = input.map((message, index) => ({
        id: message.id || crypto.randomUUID(),
        seq: index + 1,
        sender: message.sender === "B" ? "B" : "A",
        content: String(message.content || ""),
        createdAt: message.createdAt || new Date().toISOString(),
        updatedAt: message.updatedAt || message.createdAt || new Date().toISOString(),
      }));

      return {
        version: 1,
        revision: 0,
        nextSeq: messages.length + 1,
        messages,
      };
    }

    if (!input || typeof input !== "object" || !Array.isArray(input.messages)) {
      throw new Error("messages.json 的数据结构无效");
    }

    const messages = input.messages
      .filter((message) => message && typeof message === "object")
      .map((message, index) => ({
        id: message.id || crypto.randomUUID(),
        seq: Number.isInteger(message.seq) ? message.seq : index + 1,
        sender: message.sender === "B" ? "B" : "A",
        content: String(message.content || ""),
        createdAt: message.createdAt || new Date().toISOString(),
        updatedAt: message.updatedAt || message.createdAt || new Date().toISOString(),
      }))
      .sort((a, b) => a.seq - b.seq);

    const highestSeq = messages.reduce(
      (maximum, message) => Math.max(maximum, message.seq),
      0,
    );

    return {
      version: 1,
      revision: Number.isInteger(input.revision) ? input.revision : 0,
      nextSeq: Math.max(
        Number.isInteger(input.nextSeq) ? input.nextSeq : 1,
        highestSeq + 1,
      ),
      messages,
    };
  }

  list({ limit = 60, before = null, after = null } = {}) {
    let candidates = this.data.messages;
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

    const newest = this.data.messages.at(-1);

    return {
      messages: page.map((message) => ({ ...message })),
      hasMore,
      olderCursor: hasMore && page.length > 0 ? page[0].seq : null,
      latestSeq: newest ? newest.seq : 0,
      revision: this.data.revision,
      total: this.data.messages.length,
    };
  }

  async add({ sender, content }) {
    return this.mutate((data) => {
      const timestamp = new Date().toISOString();
      const message = {
        id: crypto.randomUUID(),
        seq: data.nextSeq,
        sender,
        content,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      data.nextSeq += 1;
      data.revision += 1;
      data.messages.push(message);

      return { ...message };
    });
  }

  async update(id, { content }) {
    return this.mutate((data) => {
      const message = data.messages.find((item) => item.id === id);

      if (!message) {
        return null;
      }

      message.content = content;
      message.updatedAt = new Date().toISOString();
      data.revision += 1;

      return { ...message };
    });
  }

  async remove(id) {
    return this.mutate((data) => {
      const index = data.messages.findIndex((message) => message.id === id);

      if (index === -1) {
        return false;
      }

      data.messages.splice(index, 1);
      data.revision += 1;
      return true;
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
  MessageStore,
};

