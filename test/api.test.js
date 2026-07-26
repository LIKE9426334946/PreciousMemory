const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp, renderMarkdown } = require("../backend/app");
const { MessageStore } = require("../backend/message-store");

async function startTestServer(t) {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "precious-memory-"),
  );
  const store = new MessageStore(
    path.join(temporaryDirectory, "data", "messages.json"),
  );
  await store.init();

  const app = createApp({
    store,
    publicDirectory: path.join(__dirname, "..", "public"),
  });
  const server = app.listen(0, "127.0.0.1");

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

test("Markdown is rendered and unsafe HTML is not preserved", () => {
  const html = renderMarkdown(
    "**重点** <script>alert('x')</script> [链接](javascript:alert(1))",
  );

  assert.match(html, /<strong>重点<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href=["']javascript:/);
});

test("message API supports add, history, edit and delete", async (t) => {
  const baseUrl = await startTestServer(t);

  const health = await requestJson(`${baseUrl}/api/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, "ok");

  const invalid = await requestJson(`${baseUrl}/api/messages`, {
    method: "POST",
    body: JSON.stringify({ sender: "C", content: "invalid" }),
  });
  assert.equal(invalid.response.status, 400);

  const first = await requestJson(`${baseUrl}/api/messages`, {
    method: "POST",
    body: JSON.stringify({
      sender: "A",
      content: "今天学习了 **Transformer**。",
    }),
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.message.sender, "A");
  assert.match(first.body.message.renderedHtml, /<strong>Transformer<\/strong>/);

  const second = await requestJson(`${baseUrl}/api/messages`, {
    method: "POST",
    body: JSON.stringify({
      sender: "B",
      content: "可以继续研究 Attention。",
    }),
  });
  assert.equal(second.response.status, 201);
  assert.equal(second.body.message.seq, 2);

  const history = await requestJson(`${baseUrl}/api/messages?limit=60`);
  assert.equal(history.response.status, 200);
  assert.equal(history.body.messages.length, 2);
  assert.equal(history.body.total, 2);
  assert.equal(history.body.latestSeq, 2);

  const edited = await requestJson(
    `${baseUrl}/api/messages/${first.body.message.id}`,
    {
      method: "PUT",
      body: JSON.stringify({ content: "已经学习了 Transformer 架构。" }),
    },
  );
  assert.equal(edited.response.status, 200);
  assert.match(edited.body.message.content, /已经学习/);

  const removed = await requestJson(
    `${baseUrl}/api/messages/${second.body.message.id}`,
    { method: "DELETE" },
  );
  assert.equal(removed.response.status, 204);

  const finalHistory = await requestJson(`${baseUrl}/api/messages?limit=60`);
  assert.equal(finalHistory.body.messages.length, 1);
  assert.equal(finalHistory.body.total, 1);
  assert.equal(finalHistory.body.revision, 4);
});

test("history pagination uses stable sequence cursors", async (t) => {
  const baseUrl = await startTestServer(t);

  for (let index = 1; index <= 5; index += 1) {
    const result = await requestJson(`${baseUrl}/api/messages`, {
      method: "POST",
      body: JSON.stringify({
        sender: index % 2 === 0 ? "B" : "A",
        content: `消息 ${index}`,
      }),
    });
    assert.equal(result.response.status, 201);
  }

  const latest = await requestJson(`${baseUrl}/api/messages?limit=2`);
  assert.deepEqual(
    latest.body.messages.map((message) => message.seq),
    [4, 5],
  );
  assert.equal(latest.body.hasMore, true);
  assert.equal(latest.body.olderCursor, 4);

  const older = await requestJson(
    `${baseUrl}/api/messages?limit=2&before=${latest.body.olderCursor}`,
  );
  assert.deepEqual(
    older.body.messages.map((message) => message.seq),
    [2, 3],
  );
  assert.equal(older.body.olderCursor, 2);
});
