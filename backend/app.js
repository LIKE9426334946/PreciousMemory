const path = require("node:path");
const express = require("express");
const MarkdownIt = require("markdown-it");
const sanitizeHtml = require("sanitize-html");

const MAX_MESSAGE_LENGTH = 20_000;
const MAX_CONVERSATION_NAME_LENGTH = 80;
const MAX_SEARCH_LENGTH = 100;
const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;
const DEFAULT_SEARCH_LIMIT = 80;

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
});

function renderMarkdown(content) {
  return sanitizeHtml(markdown.render(content), {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "img",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "pre",
      "code",
      "del",
    ],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title"],
      code: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        target: "_blank",
        rel: "noopener noreferrer",
      }),
    },
  });
}

function presentMessage(message) {
  return {
    ...message,
    renderedHtml: renderMarkdown(message.content),
  };
}

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, maximum);
}

function validateConversationName(body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";

  if (!name) {
    return { error: "对话名称不能为空" };
  }

  if (name.length > MAX_CONVERSATION_NAME_LENGTH) {
    return {
      error: `对话名称不能超过 ${MAX_CONVERSATION_NAME_LENGTH} 个字符`,
    };
  }

  return { name };
}

function validateMessageBody(body, { requireSender = true } = {}) {
  const sender = body?.sender;
  const content = typeof body?.content === "string" ? body.content.trim() : "";

  if (requireSender && !["A", "B"].includes(sender)) {
    return { error: "发送者只能是我（A）或 AI（B）" };
  }

  if (!content) {
    return { error: "消息内容不能为空" };
  }

  if (content.length > MAX_MESSAGE_LENGTH) {
    return { error: `消息内容不能超过 ${MAX_MESSAGE_LENGTH} 个字符` };
  }

  return { sender, content };
}

function writeStreamEvent(response, event, payload) {
  if (response.destroyed || response.writableEnded) {
    return false;
  }

  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

function createApp({
  store,
  aiClient,
  publicDirectory,
  maxContextMessages = 200,
  maxContextCharacters = 120_000,
}) {
  const app = express();
  const publicDir = publicDirectory || path.join(__dirname, "..", "public");
  const activeChats = new Set();

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: "256kb" }));

  app.use("/api", (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", (request, response) => {
    response.json({
      status: "ok",
      service: "PreciousMemory",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/config", (request, response) => {
    response.json({
      appName: "PreciousMemory",
      users: {
        A: "我",
        B: "AI",
      },
      ai: aiClient?.publicConfig?.() || {
        configured: false,
        model: null,
      },
      maxMessageLength: MAX_MESSAGE_LENGTH,
      maxConversationNameLength: MAX_CONVERSATION_NAME_LENGTH,
      maxSearchLength: MAX_SEARCH_LENGTH,
      maxContextMessages,
      maxContextCharacters,
      refreshInterval: 5000,
    });
  });

  app.get("/api/stats", (request, response) => {
    response.json(store.getStats());
  });

  app.get("/api/search", (request, response) => {
    const query =
      typeof request.query.q === "string" ? request.query.q.trim() : "";

    if (!query) {
      return response.json({ query: "", results: [] });
    }

    if (query.length > MAX_SEARCH_LENGTH) {
      return response.status(400).json({
        error: `搜索内容不能超过 ${MAX_SEARCH_LENGTH} 个字符`,
      });
    }

    const limit = parsePositiveInteger(
      request.query.limit,
      DEFAULT_SEARCH_LIMIT,
      MAX_PAGE_SIZE,
    );
    return response.json(store.search(query, limit));
  });

  app.get("/api/conversations", (request, response) => {
    response.json(store.listConversations());
  });

  app.post("/api/conversations", async (request, response, next) => {
    try {
      const validation = validateConversationName(request.body);

      if (validation.error) {
        return response.status(400).json({ error: validation.error });
      }

      const conversation = await store.createConversation(validation.name);
      return response.status(201).json({ conversation });
    } catch (error) {
      return next(error);
    }
  });

  app.put("/api/conversations/:conversationId", async (request, response, next) => {
    try {
      const validation = validateConversationName(request.body);

      if (validation.error) {
        return response.status(400).json({ error: validation.error });
      }

      const conversation = await store.renameConversation(
        request.params.conversationId,
        validation.name,
      );

      if (!conversation) {
        return response.status(404).json({ error: "没有找到这个对话" });
      }

      return response.json({ conversation });
    } catch (error) {
      return next(error);
    }
  });

  app.delete(
    "/api/conversations/:conversationId",
    async (request, response, next) => {
      try {
        const removed = await store.removeConversation(
          request.params.conversationId,
        );

        if (!removed) {
          return response.status(404).json({ error: "没有找到这个对话" });
        }

        return response.status(204).end();
      } catch (error) {
        return next(error);
      }
    },
  );

  app.get(
    "/api/conversations/:conversationId/messages",
    (request, response) => {
      const limit = parsePositiveInteger(
        request.query.limit,
        DEFAULT_PAGE_SIZE,
        MAX_PAGE_SIZE,
      );
      const before = parsePositiveInteger(request.query.before, null);
      const after = parsePositiveInteger(request.query.after, null);
      const around =
        typeof request.query.around === "string" && request.query.around
          ? request.query.around
          : null;
      const result = store.listMessages(request.params.conversationId, {
        limit,
        before,
        after,
        around,
      });

      if (!result) {
        return response.status(404).json({ error: "没有找到这个对话" });
      }

      return response.json({
        ...result,
        messages: result.messages.map(presentMessage),
      });
    },
  );

  app.post(
    "/api/conversations/:conversationId/chat",
    async (request, response) => {
      const conversationId = request.params.conversationId;
      const validation = validateMessageBody(request.body, {
        requireSender: false,
      });

      if (validation.error) {
        return response.status(400).json({ error: validation.error });
      }

      if (!aiClient?.isConfigured?.()) {
        return response.status(503).json({
          error:
            "AI 接口尚未配置，请在服务器设置 OPENAI_API_KEY、OPENAI_BASE_URL 和 OPENAI_MODEL",
        });
      }

      if (activeChats.has(conversationId)) {
        return response.status(409).json({
          error: "这个对话正在生成回复，请等待完成或先停止生成",
        });
      }

      activeChats.add(conversationId);

      let userResult;
      let contextMessages;

      try {
        userResult = store.addMessage(conversationId, {
          sender: "A",
          content: validation.content,
        });

        if (!userResult) {
          activeChats.delete(conversationId);
          return response.status(404).json({ error: "没有找到这个对话" });
        }

        contextMessages = store.getContextMessages(conversationId, {
          maxMessages: maxContextMessages,
          maxCharacters: maxContextCharacters,
        });
      } catch (error) {
        activeChats.delete(conversationId);
        throw error;
      }

      response.status(200);
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();

      writeStreamEvent(response, "user", {
        conversation: userResult.conversation,
        message: presentMessage(userResult.message),
      });

      const abortController = new AbortController();
      response.on("close", () => {
        if (!response.writableEnded) {
          abortController.abort();
        }
      });

      let assistantContent = "";

      try {
        for await (const delta of aiClient.streamChat(contextMessages, {
          signal: abortController.signal,
        })) {
          assistantContent += delta;
          writeStreamEvent(response, "delta", { content: delta });
        }

        if (!assistantContent.trim()) {
          writeStreamEvent(response, "error", {
            error: "AI 接口返回了空回复，请重试",
          });
          return response.end();
        }

        const assistantResult = store.addMessage(conversationId, {
          sender: "B",
          content: assistantContent,
        });

        writeStreamEvent(response, "done", {
          conversation: assistantResult.conversation,
          message: presentMessage(assistantResult.message),
        });
        return response.end();
      } catch (error) {
        if (error?.name === "AbortError") {
          if (assistantContent.trim()) {
            store.addMessage(conversationId, {
              sender: "B",
              content: assistantContent,
            });
          }

          if (!response.destroyed && !response.writableEnded) {
            writeStreamEvent(response, "stopped", {});
            response.end();
          }
          return;
        }

        console.error("AI chat failed:", error);
        writeStreamEvent(response, "error", {
          error: String(error?.message || "AI 回复生成失败").slice(0, 500),
        });

        if (!response.destroyed && !response.writableEnded) {
          response.end();
        }
      } finally {
        activeChats.delete(conversationId);
      }
    },
  );

  app.post(
    "/api/conversations/:conversationId/messages",
    async (request, response, next) => {
      try {
        const validation = validateMessageBody(request.body);

        if (validation.error) {
          return response.status(400).json({ error: validation.error });
        }

        const result = await store.addMessage(
          request.params.conversationId,
          validation,
        );

        if (!result) {
          return response.status(404).json({ error: "没有找到这个对话" });
        }

        return response.status(201).json({
          conversation: result.conversation,
          message: presentMessage(result.message),
        });
      } catch (error) {
        return next(error);
      }
    },
  );

  app.put(
    "/api/conversations/:conversationId/messages/:messageId",
    async (request, response, next) => {
      try {
        const validation = validateMessageBody(request.body, {
          requireSender: false,
        });

        if (validation.error) {
          return response.status(400).json({ error: validation.error });
        }

        const result = await store.updateMessage(
          request.params.conversationId,
          request.params.messageId,
          validation.content,
        );

        if (!result.conversationFound) {
          return response.status(404).json({ error: "没有找到这个对话" });
        }

        if (!result.message) {
          return response.status(404).json({ error: "没有找到这条消息" });
        }

        return response.json({
          conversation: result.conversation,
          message: presentMessage(result.message),
        });
      } catch (error) {
        return next(error);
      }
    },
  );

  app.delete(
    "/api/conversations/:conversationId/messages/:messageId",
    async (request, response, next) => {
      try {
        const result = await store.removeMessage(
          request.params.conversationId,
          request.params.messageId,
        );

        if (!result.conversationFound) {
          return response.status(404).json({ error: "没有找到这个对话" });
        }

        if (!result.removed) {
          return response.status(404).json({ error: "没有找到这条消息" });
        }

        return response.status(204).end();
      } catch (error) {
        return next(error);
      }
    },
  );

  app.use(
    express.static(publicDir, {
      etag: true,
      maxAge: 0,
      index: "index.html",
    }),
  );

  app.use("/api", (request, response) => {
    response.status(404).json({ error: "接口不存在" });
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      return next(error);
    }

    console.error(error);
    return response.status(500).json({ error: "服务器处理请求时发生错误" });
  });

  return app;
}

module.exports = {
  createApp,
  renderMarkdown,
};
