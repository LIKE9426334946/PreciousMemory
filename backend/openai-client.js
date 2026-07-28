class OpenAICompatibleError extends Error {
  constructor(message, { status = 502, code = "upstream_error" } = {}) {
    super(message);
    this.name = "OpenAICompatibleError";
    this.status = status;
    this.code = code;
  }
}

function resolveChatCompletionsUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");

  if (!normalized) {
    return "";
  }

  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }

  return `${normalized}/chat/completions`;
}

function extractTextContent(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (typeof part?.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}

function extractChunkText(payload) {
  const choice = payload?.choices?.[0];
  return extractTextContent(choice?.delta?.content);
}

function extractCompletionText(payload) {
  const choice = payload?.choices?.[0];
  return extractTextContent(choice?.message?.content);
}

function upstreamMessage(payload, fallback) {
  const message =
    payload?.error?.message ||
    payload?.message ||
    (typeof payload?.error === "string" ? payload.error : "");
  return String(message || fallback).slice(0, 500);
}

async function readErrorResponse(response) {
  let payload;

  try {
    payload = await response.json();
  } catch {
    try {
      payload = { message: await response.text() };
    } catch {
      payload = null;
    }
  }

  return upstreamMessage(
    payload,
    `AI 接口请求失败（HTTP ${response.status}）`,
  );
}

async function* parseOpenAIEventStream(body) {
  if (!body) {
    throw new OpenAICompatibleError("AI 接口没有返回响应内容");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";

      for (const eventBlock of events) {
        const data = eventBlock
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
          .trim();

        if (!data) {
          continue;
        }

        if (data === "[DONE]") {
          return;
        }

        let payload;

        try {
          payload = JSON.parse(data);
        } catch {
          throw new OpenAICompatibleError("AI 接口返回了无法解析的流式数据");
        }

        if (payload?.error) {
          throw new OpenAICompatibleError(
            upstreamMessage(payload, "AI 接口返回错误"),
          );
        }

        const content = extractChunkText(payload);
        if (content) {
          yield content;
        }
      }

      if (done) {
        break;
      }
    }

    const trailing = buffer.trim();
    if (trailing && trailing !== "data: [DONE]") {
      const data = trailing
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();

      if (data && data !== "[DONE]") {
        let payload;

        try {
          payload = JSON.parse(data);
        } catch {
          throw new OpenAICompatibleError("AI 接口返回了无法解析的流式数据");
        }

        const content = extractChunkText(payload);
        if (content) {
          yield content;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

class OpenAICompatibleClient {
  constructor({
    apiKey,
    baseUrl = "https://api.openai.com/v1",
    model,
    systemPrompt = "",
    timeoutMs = 180_000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.endpoint = resolveChatCompletionsUrl(baseUrl);
    this.model = String(model || "").trim();
    this.systemPrompt = String(systemPrompt || "").trim();
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(
      this.apiKey &&
        this.endpoint &&
        this.model &&
        typeof this.fetchImpl === "function",
    );
  }

  publicConfig() {
    return {
      configured: this.isConfigured(),
      model: this.model || null,
    };
  }

  buildMessages(messages) {
    const result = [];

    if (this.systemPrompt) {
      result.push({
        role: "system",
        content: this.systemPrompt,
      });
    }

    for (const message of messages) {
      result.push({
        role: message.sender === "B" ? "assistant" : "user",
        content: message.content,
      });
    }

    return result;
  }

  async *streamChat(messages, { signal } = {}) {
    if (!this.isConfigured()) {
      throw new OpenAICompatibleError(
        "AI 接口尚未配置，请先设置 OPENAI_API_KEY、OPENAI_BASE_URL 和 OPENAI_MODEL",
        { status: 503, code: "ai_not_configured" },
      );
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    const timer = setTimeout(
      () => controller.abort(new Error("AI 接口响应超时")),
      this.timeoutMs,
    );

    if (signal?.aborted) {
      controller.abort(signal.reason);
    } else {
      signal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    let response;

    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: this.buildMessages(messages),
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const message = await readErrorResponse(response);
        throw new OpenAICompatibleError(message, {
          status: response.status === 429 ? 429 : 502,
          code: "upstream_http_error",
        });
      }

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        yield* parseOpenAIEventStream(response.body);
        return;
      }

      let payload;

      try {
        payload = await response.json();
      } catch {
        throw new OpenAICompatibleError(
          "AI 接口没有返回 OpenAI 兼容的 JSON 或事件流",
        );
      }

      if (payload?.error) {
        throw new OpenAICompatibleError(
          upstreamMessage(payload, "AI 接口返回错误"),
        );
      }

      const content = extractCompletionText(payload);
      if (!content) {
        throw new OpenAICompatibleError("AI 接口返回了空回复");
      }

      yield content;
    } catch (error) {
      if (error instanceof OpenAICompatibleError) {
        throw error;
      }

      if (controller.signal.aborted) {
        const aborted = new Error("AI 回复已停止");
        aborted.name = "AbortError";
        throw aborted;
      }

      throw new OpenAICompatibleError(
        `无法连接 AI 接口：${String(error?.message || error).slice(0, 300)}`,
        { code: "upstream_network_error" },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

module.exports = {
  OpenAICompatibleClient,
  OpenAICompatibleError,
  extractChunkText,
  parseOpenAIEventStream,
  resolveChatCompletionsUrl,
};
