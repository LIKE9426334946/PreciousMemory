const path = require("node:path");
const { createApp } = require("./app");
const { ConversationStore } = require("./conversation-store");

const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "3023", 10);
const dataFile =
  process.env.DATA_FILE ||
  path.join(__dirname, "..", "data", "messages.json");

async function start() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT 必须是 1 到 65535 之间的整数");
  }

  const store = new ConversationStore(dataFile);
  await store.init();

  const app = createApp({ store });
  const server = app.listen(port, host, () => {
    console.log(`PreciousMemory is running at http://${host}:${port}`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down...`);
    server.close((error) => {
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
