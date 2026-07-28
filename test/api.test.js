const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp, renderMarkdown } = require("../backend/app");
const { ConversationStore } = require("../backend/conversation-store");
const {
  OpenAICompatibleClient,
  resolveChatCompletionsUrl,
} = require("../backend/openai-client");

async function startTestServer(t, { aiClient } = {}) {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "precious-memory-"),
  );
  const store = new ConversationStore(
    path.join(temporaryDirectory, "data", "precious-memory.sqlite"),
  );
  await store.init();

  const app = createApp({
    store,
    aiClient,
    publicDirectory: path.join(__dirname, "..", "public"),
  });
  const server = app.listen(0, "127.0.0.1");

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
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

async function createConversation(baseUrl, name) {
  const result = await requestJson(`${baseUrl}/api/conversations`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  assert.equal(result.response.status, 201);
  return result.body.conversation;
}

async function createMessage(baseUrl, conversationId, sender, content) {
  const result = await requestJson(
    `${baseUrl}/api/conversations/${conversationId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ sender, content }),
    },
  );
  assert.equal(result.response.status, 201);
  return result.body.message;
}

async function sendChat(baseUrl, conversationId, content) {
  const response = await fetch(
    `${baseUrl}/api/conversations/${conversationId}/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  return { response, body: await response.text() };
}

class CapturingAIClient {
  constructor() {
    this.calls = [];
  }

  isConfigured() {
    return true;
  }

  publicConfig() {
    return { configured: true, model: "test-model" };
  }

  async *streamChat(messages) {
    this.calls.push(messages.map((message) => ({ ...message })));
    const lastUserMessage = messages.at(-1).content;
    yield "AI 回复：";
    yield lastUserMessage;
  }
}

test("Markdown is rendered and unsafe HTML is not preserved", () => {
  const html = renderMarkdown(
    "**重点** <script>alert('x')</script> [链接](javascript:alert(1))",
  );

  assert.match(html, /<strong>重点<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href=["']javascript:/);
});

test("OpenAI compatible client sends Chat Completions format and reads SSE deltas", async () => {
  let capturedUrl;
  let capturedOptions;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(
      [
        'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"你好"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"呀"}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  };
  const client = new OpenAICompatibleClient({
    apiKey: "test-secret",
    baseUrl: "https://example.test/v1/",
    model: "compatible-model",
    systemPrompt: "只回答测试内容",
    fetchImpl,
  });
  const chunks = [];

  for await (const chunk of client.streamChat([
    { sender: "A", content: "第一问" },
    { sender: "B", content: "第一答" },
    { sender: "A", content: "第二问" },
  ])) {
    chunks.push(chunk);
  }

  assert.equal(
    capturedUrl,
    "https://example.test/v1/chat/completions",
  );
  assert.equal(capturedOptions.headers.Authorization, "Bearer test-secret");
  assert.deepEqual(chunks, ["你好", "呀"]);

  const requestBody = JSON.parse(capturedOptions.body);
  assert.equal(requestBody.model, "compatible-model");
  assert.equal(requestBody.stream, true);
  assert.deepEqual(requestBody.messages, [
    { role: "system", content: "只回答测试内容" },
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
  ]);
  assert.equal(
    resolveChatCompletionsUrl(
      "https://example.test/v1/chat/completions",
    ),
    "https://example.test/v1/chat/completions",
  );
});

test("real-time chat streams and keeps every conversation context isolated", async (t) => {
  const aiClient = new CapturingAIClient();
  const baseUrl = await startTestServer(t, { aiClient });
  const study = await createConversation(baseUrl, "学习");
  const daily = await createConversation(baseUrl, "日常");

  const firstStudy = await sendChat(baseUrl, study.id, "解释 Attention");
  assert.equal(firstStudy.response.status, 200);
  assert.match(firstStudy.response.headers.get("content-type"), /event-stream/);
  assert.match(firstStudy.body, /event: user/);
  assert.match(firstStudy.body, /event: delta/);
  assert.match(firstStudy.body, /event: done/);

  const firstDaily = await sendChat(baseUrl, daily.id, "今天吃什么");
  assert.equal(firstDaily.response.status, 200);

  const secondStudy = await sendChat(baseUrl, study.id, "继续讲");
  assert.equal(secondStudy.response.status, 200);

  assert.deepEqual(
    aiClient.calls[0].map((message) => [
      message.sender,
      message.content,
    ]),
    [["A", "解释 Attention"]],
  );
  assert.deepEqual(
    aiClient.calls[1].map((message) => [
      message.sender,
      message.content,
    ]),
    [["A", "今天吃什么"]],
  );
  assert.deepEqual(
    aiClient.calls[2].map((message) => [
      message.sender,
      message.content,
    ]),
    [
      ["A", "解释 Attention"],
      ["B", "AI 回复：解释 Attention"],
      ["A", "继续讲"],
    ],
  );

  const studyHistory = await requestJson(
    `${baseUrl}/api/conversations/${study.id}/messages?limit=20`,
  );
  const dailyHistory = await requestJson(
    `${baseUrl}/api/conversations/${daily.id}/messages?limit=20`,
  );

  assert.deepEqual(
    studyHistory.body.messages.map((message) => message.sender),
    ["A", "B", "A", "B"],
  );
  assert.deepEqual(
    dailyHistory.body.messages.map((message) => message.content),
    ["今天吃什么", "AI 回复：今天吃什么"],
  );
  assert.equal(
    studyHistory.body.messages.some((message) =>
      message.content.includes("今天吃什么"),
    ),
    false,
  );
});

test("chat endpoint refuses requests before the AI API is configured", async (t) => {
  const baseUrl = await startTestServer(t);
  const conversation = await createConversation(baseUrl, "未配置测试");
  const result = await requestJson(
    `${baseUrl}/api/conversations/${conversation.id}/chat`,
    {
      method: "POST",
      body: JSON.stringify({ content: "你好" }),
    },
  );

  assert.equal(result.response.status, 503);
  assert.match(result.body.error, /OPENAI_API_KEY/);

  const history = await requestJson(
    `${baseUrl}/api/conversations/${conversation.id}/messages`,
  );
  assert.equal(history.body.total, 0);
});

test("conversation API supports create, rename, list and delete", async (t) => {
  const baseUrl = await startTestServer(t);

  const empty = await requestJson(`${baseUrl}/api/conversations`);
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.body.conversations, []);

  const invalid = await requestJson(`${baseUrl}/api/conversations`, {
    method: "POST",
    body: JSON.stringify({ name: "   " }),
  });
  assert.equal(invalid.response.status, 400);

  const study = await createConversation(baseUrl, "学习记录");
  const daily = await createConversation(baseUrl, "日常聊天");

  const listed = await requestJson(`${baseUrl}/api/conversations`);
  assert.equal(listed.body.conversations.length, 2);
  assert.deepEqual(
    new Set(listed.body.conversations.map((item) => item.name)),
    new Set(["学习记录", "日常聊天"]),
  );

  const renamed = await requestJson(
    `${baseUrl}/api/conversations/${study.id}`,
    {
      method: "PUT",
      body: JSON.stringify({ name: "Transformer 学习" }),
    },
  );
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.conversation.name, "Transformer 学习");

  const removed = await requestJson(
    `${baseUrl}/api/conversations/${daily.id}`,
    { method: "DELETE" },
  );
  assert.equal(removed.response.status, 204);

  const finalList = await requestJson(`${baseUrl}/api/conversations`);
  assert.equal(finalList.body.conversations.length, 1);
  assert.equal(finalList.body.conversations[0].name, "Transformer 学习");
});

test("messages stay isolated inside their conversations", async (t) => {
  const baseUrl = await startTestServer(t);
  const study = await createConversation(baseUrl, "学习记录");
  const daily = await createConversation(baseUrl, "日常聊天");

  const studyMessage = await createMessage(
    baseUrl,
    study.id,
    "A",
    "今天学习了 **Transformer**。",
  );
  await createMessage(baseUrl, daily.id, "B", "今天去散步啦。");

  const studyHistory = await requestJson(
    `${baseUrl}/api/conversations/${study.id}/messages?limit=60`,
  );
  assert.equal(studyHistory.body.messages.length, 1);
  assert.equal(studyHistory.body.messages[0].sender, "A");
  assert.match(
    studyHistory.body.messages[0].renderedHtml,
    /<strong>Transformer<\/strong>/,
  );
  assert.equal("createdAt" in studyHistory.body.messages[0], false);
  assert.equal("updatedAt" in studyHistory.body.messages[0], false);

  const dailyHistory = await requestJson(
    `${baseUrl}/api/conversations/${daily.id}/messages?limit=60`,
  );
  assert.equal(dailyHistory.body.messages.length, 1);
  assert.match(dailyHistory.body.messages[0].content, /散步/);

  const edited = await requestJson(
    `${baseUrl}/api/conversations/${study.id}/messages/${studyMessage.id}`,
    {
      method: "PUT",
      body: JSON.stringify({ content: "继续研究 Attention。" }),
    },
  );
  assert.equal(edited.response.status, 200);
  assert.match(edited.body.message.content, /Attention/);

  const removed = await requestJson(
    `${baseUrl}/api/conversations/${study.id}/messages/${studyMessage.id}`,
    { method: "DELETE" },
  );
  assert.equal(removed.response.status, 204);

  const finalStudyHistory = await requestJson(
    `${baseUrl}/api/conversations/${study.id}/messages?limit=60`,
  );
  assert.equal(finalStudyHistory.body.total, 0);

  const finalDailyHistory = await requestJson(
    `${baseUrl}/api/conversations/${daily.id}/messages?limit=60`,
  );
  assert.equal(finalDailyHistory.body.total, 1);
});

test("each conversation has stable message pagination cursors", async (t) => {
  const baseUrl = await startTestServer(t);
  const conversation = await createConversation(baseUrl, "分页测试");

  for (let index = 1; index <= 5; index += 1) {
    await createMessage(
      baseUrl,
      conversation.id,
      index % 2 === 0 ? "B" : "A",
      `消息 ${index}`,
    );
  }

  const latest = await requestJson(
    `${baseUrl}/api/conversations/${conversation.id}/messages?limit=2`,
  );
  assert.deepEqual(
    latest.body.messages.map((message) => message.seq),
    [4, 5],
  );
  assert.equal(latest.body.hasMore, true);
  assert.equal(latest.body.olderCursor, 4);

  const older = await requestJson(
    `${baseUrl}/api/conversations/${conversation.id}/messages?limit=2&before=${latest.body.olderCursor}`,
  );
  assert.deepEqual(
    older.body.messages.map((message) => message.seq),
    [2, 3],
  );
  assert.equal(older.body.olderCursor, 2);
});

test("search finds conversation names and Chinese message fragments", async (t) => {
  const baseUrl = await startTestServer(t);
  const study = await createConversation(baseUrl, "Transformer 学习");
  const daily = await createConversation(baseUrl, "日常聊天");

  const first = await createMessage(
    baseUrl,
    study.id,
    "A",
    "今天继续研究注意力机制和位置编码。",
  );
  await createMessage(
    baseUrl,
    study.id,
    "B",
    "下一步学习多头注意力的张量形状。",
  );
  await createMessage(baseUrl, daily.id, "B", "晚上一起去公园散步。");

  const nameSearch = await requestJson(
    `${baseUrl}/api/search?q=${encodeURIComponent("Transformer")}`,
  );
  assert.equal(nameSearch.response.status, 200);
  assert.equal(nameSearch.body.results[0].type, "conversation");
  assert.equal(nameSearch.body.results[0].conversationId, study.id);

  const trigramSearch = await requestJson(
    `${baseUrl}/api/search?q=${encodeURIComponent("注意力机制")}`,
  );
  assert.equal(trigramSearch.response.status, 200);
  assert.equal(trigramSearch.body.results[0].type, "message");
  assert.equal(trigramSearch.body.results[0].messageId, first.id);

  const shortSearch = await requestJson(
    `${baseUrl}/api/search?q=${encodeURIComponent("学习")}`,
  );
  assert.equal(shortSearch.response.status, 200);
  assert.ok(shortSearch.body.results.length >= 2);

  const context = await requestJson(
    `${baseUrl}/api/conversations/${study.id}/messages?limit=3&around=${first.id}`,
  );
  assert.equal(context.response.status, 200);
  assert.equal(context.body.searchTargetFound, true);
  assert.ok(
    context.body.messages.some((message) => message.id === first.id),
  );

  const edited = await requestJson(
    `${baseUrl}/api/conversations/${study.id}/messages/${first.id}`,
    {
      method: "PUT",
      body: JSON.stringify({ content: "已经改为研究前馈神经网络。" }),
    },
  );
  assert.equal(edited.response.status, 200);

  const oldSearch = await requestJson(
    `${baseUrl}/api/search?q=${encodeURIComponent("注意力机制")}`,
  );
  assert.equal(oldSearch.body.results.length, 0);

  const newSearch = await requestJson(
    `${baseUrl}/api/search?q=${encodeURIComponent("前馈神经网络")}`,
  );
  assert.equal(newSearch.body.results[0].messageId, first.id);

  const stats = await requestJson(`${baseUrl}/api/stats`);
  assert.equal(stats.body.conversationCount, 2);
  assert.equal(stats.body.messageCount, 3);
  assert.ok(stats.body.characterCount > 30);
});

test("SQLite starts empty and ignores the old JSON file", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "precious-memory-migration-"),
  );
  const legacyFilePath = path.join(temporaryDirectory, "messages.json");
  const databasePath = path.join(
    temporaryDirectory,
    "precious-memory.sqlite",
  );
  await fs.writeFile(
    legacyFilePath,
    JSON.stringify({
      version: 1,
      revision: 1,
      nextSeq: 2,
      messages: [{ id: "old", seq: 1, sender: "A", content: "旧消息" }],
    }),
    "utf8",
  );

  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));

  const store = new ConversationStore(databasePath);
  await store.init();
  const result = store.listConversations();

  assert.equal(result.revision, 0);
  assert.deepEqual(result.conversations, []);
  assert.equal((await fs.stat(databasePath)).isFile(), true);
  assert.match(await fs.readFile(legacyFilePath, "utf8"), /旧消息/);
  store.close();
});
