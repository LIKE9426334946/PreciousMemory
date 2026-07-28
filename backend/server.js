const fs = require("node:fs");
const path = require("node:path");
const { createApp } = require("./app");
const { ConversationStore } = require("./conversation-store");
const { OpenAICompatibleClient } = require("./openai-client");

const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "3023", 10);
const databaseFile =
  process.env.DATABASE_FILE ||
  path.join(__dirname, "..", "data", "precious-memory.sqlite");
const systemPromptFile =
  process.env.AI_SYSTEM_PROMPT_FILE ||
  path.join(__dirname, "..", "config", "system-prompt.txt");

function readPositiveInteger(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name] || "", 10);

  if (!Number.isInteger(value) || value < 1) {
    return fallback;
  }

  return Math.min(value, maximum);
}

function readSystemPrompt() {
  if (process.env.AI_SYSTEM_PROMPT?.trim()) {
    return process.env.AI_SYSTEM_PROMPT.trim();
  }

  try {
    return fs.readFileSync(systemPromptFile, "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    return "";
  }
}

async function start() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT 必须是 1 到 65535 之间的整数");
  }

  const store = new ConversationStore(databaseFile);
  await store.init();

  const aiClient = new OpenAICompatibleClient({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL || "gpt-5.6",
    systemPrompt: readSystemPrompt(),
    timeoutMs: readPositiveInteger("OPENAI_TIMEOUT_MS", 180_000, 900_000),
  });
  const maxContextMessages = readPositiveInteger(
    "AI_MAX_CONTEXT_MESSAGES",
    200,
    2_000,
  );
  const maxContextCharacters = readPositiveInteger(
    "AI_MAX_CONTEXT_CHARACTERS",
    120_000,
    4_000_000,
  );

  const app = createApp({
    store,
    aiClient,
    maxContextMessages,
    maxContextCharacters,
  });
  const server = app.listen(port, host, () => {
    console.log(`PreciousMemory is running at http://${host}:${port}`);
    console.log(
      aiClient.isConfigured()
        ? `AI model: ${aiClient.model}`
        : "AI API is not configured. Set OPENAI_API_KEY before chatting.",
    );
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);
    server.close((error) => {
      store.close();

      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((error) => {
  console.error("PreciousMemory failed to start:", error);
  process.exitCode = 1;
});
