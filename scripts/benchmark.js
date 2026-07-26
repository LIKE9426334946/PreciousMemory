const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { ConversationStore } = require("../backend/conversation-store");

const conversationCount = 500;
const messagesPerConversation = 10;
const charactersPerMessage = 1000;
const searchPhrase = "稀有搜索词ABC";

function createMessageContent(conversationIndex, messageIndex) {
  const prefix = `对话${conversationIndex}消息${messageIndex} `;
  const marker =
    conversationIndex === 321 && messageIndex === 7 ? ` ${searchPhrase} ` : " ";
  const repeated = "这是用于验证SQLite容量和全文查找能力的聊天内容。";
  const body = repeated.repeat(
    Math.ceil((charactersPerMessage - prefix.length - marker.length) / repeated.length),
  );
  return `${prefix}${marker}${body}`.slice(0, charactersPerMessage);
}

function main() {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "precious-memory-benchmark-"),
  );
  const databasePath = path.join(
    temporaryDirectory,
    "precious-memory.sqlite",
  );
  const store = new ConversationStore(databasePath);

  try {
    store.init();
    const insertStarted = performance.now();

    for (
      let conversationIndex = 1;
      conversationIndex <= conversationCount;
      conversationIndex += 1
    ) {
      const conversation = store.createConversation(
        `容量测试对话 ${conversationIndex}`,
      );

      for (
        let messageIndex = 1;
        messageIndex <= messagesPerConversation;
        messageIndex += 1
      ) {
        store.addMessage(conversation.id, {
          sender: messageIndex % 2 === 0 ? "B" : "A",
          content: createMessageContent(conversationIndex, messageIndex),
        });
      }
    }

    const insertMilliseconds = performance.now() - insertStarted;
    const searchStarted = performance.now();
    const search = store.search(searchPhrase, 100);
    const searchMilliseconds = performance.now() - searchStarted;
    const listStarted = performance.now();
    const conversations = store.listConversations();
    const listMilliseconds = performance.now() - listStarted;
    const stats = store.getStats();

    if (
      stats.conversationCount !== conversationCount ||
      stats.messageCount !== conversationCount * messagesPerConversation ||
      search.results.length !== 1
    ) {
      throw new Error("Benchmark data verification failed");
    }

    store.close();
    const databaseBytes = fs.statSync(databasePath).size;

    console.log(
      JSON.stringify(
        {
          stats,
          databaseMegabytes: Number(
            (databaseBytes / 1024 / 1024).toFixed(2),
          ),
          insertMilliseconds: Number(insertMilliseconds.toFixed(1)),
          searchMilliseconds: Number(searchMilliseconds.toFixed(1)),
          listMilliseconds: Number(listMilliseconds.toFixed(1)),
          listedConversations: conversations.conversations.length,
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main();
