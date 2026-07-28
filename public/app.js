const state = {
  config: null,
  conversations: [],
  globalRevision: null,
  selectedConversationId: null,
  conversationRevision: null,
  messages: [],
  total: 0,
  hasMore: false,
  hasNewer: false,
  olderCursor: null,
  searchQuery: "",
  searchResults: [],
  searchTimer: null,
  searchRequestToken: 0,
  searchTargetMessageId: null,
  selectionToken: 0,
  loadingOlder: false,
  refreshing: false,
  generating: false,
  generationController: null,
  streamingMessageId: null,
  pollTimer: null,
  refreshInterval: 5000,
  dialogMode: "create",
};

const elements = {
  conversationList: document.querySelector("#conversation-list"),
  conversationHeadingTitle: document.querySelector(
    "#conversation-heading-title",
  ),
  conversationCount: document.querySelector("#conversation-count"),
  conversationEmpty: document.querySelector("#conversation-empty"),
  conversationEmptyTitle: document.querySelector("#conversation-empty-title"),
  conversationEmptyCopy: document.querySelector("#conversation-empty-copy"),
  newConversation: document.querySelector("#new-conversation"),
  searchInput: document.querySelector("#search-input"),
  searchClear: document.querySelector("#search-clear"),
  currentConversationName: document.querySelector(
    "#current-conversation-name",
  ),
  connectionStatus: document.querySelector("#connection-status"),
  connectionDot: document.querySelector("#connection-dot"),
  renameConversation: document.querySelector("#rename-conversation"),
  deleteConversation: document.querySelector("#delete-conversation"),
  refreshButton: document.querySelector("#refresh-button"),
  backToConversations: document.querySelector("#back-to-conversations"),
  noSelection: document.querySelector("#no-selection"),
  chatScroll: document.querySelector("#chat-scroll"),
  loadOlder: document.querySelector("#load-older"),
  messageEmpty: document.querySelector("#message-empty"),
  messageList: document.querySelector("#message-list"),
  jumpLatest: document.querySelector("#jump-latest"),
  composer: document.querySelector("#composer"),
  aiModelLabel: document.querySelector("#ai-model-label"),
  composerModeLabel: document.querySelector("#composer-mode-label"),
  input: document.querySelector("#message-input"),
  characterCount: document.querySelector("#character-count"),
  submit: document.querySelector("#submit-message"),
  stop: document.querySelector("#stop-generation"),
  formStatus: document.querySelector("#form-status"),
  dialog: document.querySelector("#conversation-dialog"),
  dialogForm: document.querySelector("#conversation-form"),
  dialogEyebrow: document.querySelector("#dialog-eyebrow"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogDescription: document.querySelector("#dialog-description"),
  dialogName: document.querySelector("#conversation-name"),
  dialogError: document.querySelector("#dialog-error"),
  dialogCancel: document.querySelector("#dialog-cancel"),
  dialogConfirm: document.querySelector("#dialog-confirm"),
};

const desktopMedia = window.matchMedia("(min-width: 900px)");

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    let message = "请求失败，请稍后重试";

    try {
      const body = await response.json();
      message = body.error || message;
    } catch {
      // Keep the fallback when the response is not JSON.
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function responseError(response) {
  try {
    const body = await response.json();
    return body.error || `请求失败（HTTP ${response.status}）`;
  } catch {
    return `请求失败（HTTP ${response.status}）`;
  }
}

async function consumeEventStream(response, onEvent) {
  if (!response.body) {
    throw new Error("浏览器没有收到流式响应");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeBlock = (block) => {
    let eventName = "message";
    const dataLines = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) {
      return;
    }

    const raw = dataLines.join("\n");
    let payload = {};

    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("服务器返回了无法解析的流式数据");
    }

    onEvent(eventName, payload);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        if (block.trim()) {
          consumeBlock(block);
        }
      }

      if (done) {
        if (buffer.trim()) {
          consumeBlock(buffer);
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function selectedConversation() {
  return (
    state.conversations.find(
      (conversation) => conversation.id === state.selectedConversationId,
    ) || null
  );
}

function setConnection(message, type = "online") {
  elements.connectionStatus.textContent = message;
  elements.connectionDot.classList.toggle("is-online", type === "online");
  elements.connectionDot.classList.toggle("is-error", type === "error");
  elements.connectionDot.classList.toggle("is-busy", type === "busy");
}

function setFormStatus(message, type = "success") {
  elements.formStatus.textContent = message;
  elements.formStatus.classList.toggle("is-error", type === "error");
}

function isNearBottom() {
  const distance =
    elements.chatScroll.scrollHeight -
    elements.chatScroll.scrollTop -
    elements.chatScroll.clientHeight;
  return distance < 140;
}

function scrollToBottom(behavior = "smooth") {
  elements.chatScroll.scrollTo({
    top: elements.chatScroll.scrollHeight,
    behavior,
  });

  if (!state.searchTargetMessageId && !state.hasNewer) {
    elements.jumpLatest.classList.add("is-hidden");
  }
}

function upsertConversation(conversation) {
  const index = state.conversations.findIndex(
    (item) => item.id === conversation.id,
  );

  if (index >= 0) {
    state.conversations[index] = conversation;
  } else {
    state.conversations.push(conversation);
  }

  state.conversations.sort(
    (left, right) =>
      right.sortOrder - left.sortOrder || left.name.localeCompare(right.name),
  );
}

function createConversationItem(conversation) {
  const button = document.createElement("button");
  button.className = "conversation-item";
  button.type = "button";
  button.dataset.conversationId = conversation.id;
  button.classList.toggle(
    "is-active",
    conversation.id === state.selectedConversationId &&
      !state.searchTargetMessageId,
  );

  const avatar = document.createElement("span");
  avatar.className = "conversation-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = Array.from(conversation.name)[0] || "P";

  const copy = document.createElement("span");
  copy.className = "conversation-copy";

  const top = document.createElement("span");
  top.className = "conversation-item-top";

  const name = document.createElement("span");
  name.className = "conversation-name";
  name.textContent = conversation.name;

  const preview = document.createElement("span");
  preview.className = "conversation-preview";
  preview.textContent = conversation.lastMessagePreview
    ? `${conversation.messageCount} 条 · ${conversation.lastMessagePreview}`
    : "新的独立上下文";

  top.append(name);
  copy.append(top, preview);
  button.append(avatar, copy);
  return button;
}

function createSearchResultItem(result) {
  const button = document.createElement("button");
  button.className = "conversation-item";
  button.type = "button";
  button.dataset.conversationId = result.conversationId;

  if (result.messageId) {
    button.dataset.messageId = result.messageId;
    button.classList.add("search-result-message");
  }

  button.classList.toggle(
    "is-active",
    result.conversationId === state.selectedConversationId &&
      result.messageId === state.searchTargetMessageId,
  );

  const avatar = document.createElement("span");
  avatar.className = "conversation-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent =
    result.type === "message" ? (result.sender === "A" ? "我" : "AI") : "会";

  const copy = document.createElement("span");
  copy.className = "conversation-copy";
  const top = document.createElement("span");
  top.className = "conversation-item-top";
  const name = document.createElement("span");
  name.className = "conversation-name";
  name.textContent = result.conversationName;
  const preview = document.createElement("span");
  preview.className = "conversation-preview";
  const label = document.createElement("span");
  label.className = "search-result-label";
  label.textContent =
    result.type === "message"
      ? result.sender === "A"
        ? "我"
        : "AI"
      : "对话";
  preview.append(label, document.createTextNode(result.snippet));
  top.append(name);
  copy.append(top, preview);
  button.append(avatar, copy);
  return button;
}

function renderConversationDirectory() {
  const fragment = document.createDocumentFragment();
  const searching = Boolean(state.searchQuery);
  const items = searching ? state.searchResults : state.conversations;

  for (const item of items) {
    fragment.append(
      searching ? createSearchResultItem(item) : createConversationItem(item),
    );
  }

  elements.conversationList.replaceChildren(fragment);
  elements.conversationHeadingTitle.textContent = searching
    ? "查找结果"
    : "所有对话";
  elements.conversationCount.textContent = searching
    ? `${items.length} 条`
    : `${items.length} 个`;
  elements.conversationEmpty.classList.toggle("is-hidden", items.length > 0);

  if (searching) {
    elements.conversationEmptyTitle.textContent = "没有找到相关内容";
    elements.conversationEmptyCopy.textContent = "换一个关键词再试试。";
  } else {
    elements.conversationEmptyTitle.textContent = "还没有对话";
    elements.conversationEmptyCopy.textContent =
      "点击“新建对话”开始和 AI 聊天。";
  }
}

function updateComposerState() {
  const selected = Boolean(state.selectedConversationId);
  const configured = Boolean(state.config?.ai?.configured);
  const enabled = selected && configured && !state.generating;

  elements.composer.classList.toggle("is-disabled", !selected || !configured);
  elements.input.disabled = !enabled;
  elements.submit.disabled = !enabled || !elements.input.value.trim();
  elements.submit.classList.toggle("is-hidden", state.generating);
  elements.stop.classList.toggle("is-hidden", !state.generating);
  elements.renameConversation.disabled = !selected || state.generating;
  elements.deleteConversation.disabled = !selected || state.generating;

  if (state.generating) {
    elements.composerModeLabel.textContent = "AI 正在生成回复";
  } else {
    elements.composerModeLabel.textContent = "Markdown 已启用";
  }
}

function renderSelectedConversation() {
  const conversation = selectedConversation();
  const hasSelection = Boolean(conversation);

  elements.currentConversationName.textContent = conversation
    ? conversation.name
    : "请选择一个对话";
  elements.noSelection.classList.toggle("is-hidden", hasSelection);
  elements.chatScroll.classList.toggle("is-hidden", !hasSelection);
  updateComposerState();
}

function createMessageRow(message) {
  const row = document.createElement("article");
  row.className = `message-row ${message.sender === "A" ? "is-mine" : "is-theirs"}`;
  row.dataset.messageId = message.id;
  row.classList.toggle("is-streaming", Boolean(message.streaming));

  if (message.id === state.searchTargetMessageId) {
    row.classList.add("is-search-target");
  }

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = message.sender === "A" ? "我" : "AI";

  const column = document.createElement("div");
  column.className = "message-column";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  const markdown = document.createElement("div");
  markdown.className = "markdown-body";

  if (message.streaming) {
    if (message.content) {
      markdown.textContent = message.content;
      markdown.classList.add("streaming-text");
    } else {
      const thinking = document.createElement("span");
      thinking.className = "thinking-dots";
      thinking.innerHTML = "<i></i><i></i><i></i>";
      thinking.setAttribute("aria-label", "AI 正在思考");
      markdown.append(thinking);
    }
  } else {
    markdown.innerHTML = message.renderedHtml;
  }

  bubble.append(markdown);
  column.append(bubble);

  if (message.edited) {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = "已编辑";
    column.append(meta);
  }

  row.append(avatar, column);
  return row;
}

function renderMessages() {
  const fragment = document.createDocumentFragment();

  for (const message of state.messages) {
    fragment.append(createMessageRow(message));
  }

  elements.messageList.replaceChildren(fragment);
  elements.messageEmpty.classList.toggle(
    "is-hidden",
    state.messages.length > 0,
  );
  elements.loadOlder.classList.toggle(
    "is-hidden",
    !state.hasMore || state.messages.length === 0,
  );
  elements.jumpLatest.classList.toggle(
    "is-hidden",
    !state.searchTargetMessageId && !state.hasNewer,
  );
}

function resetMessageState() {
  state.messages = [];
  state.conversationRevision = null;
  state.total = 0;
  state.hasMore = false;
  state.hasNewer = false;
  state.olderCursor = null;
  state.searchTargetMessageId = null;
  state.streamingMessageId = null;
  renderMessages();
}

function updateCharacterCount() {
  const maximum = state.config?.maxMessageLength || 20_000;
  elements.characterCount.textContent = `${elements.input.value.length} / ${maximum}`;
  updateComposerState();
}

async function loadInitial() {
  setConnection("正在读取对话列表…", "busy");

  try {
    const [config, result] = await Promise.all([
      api("/api/config"),
      api("/api/conversations"),
    ]);

    state.config = config;
    state.refreshInterval = config.refreshInterval || 5000;
    state.conversations = result.conversations;
    state.globalRevision = result.revision;
    elements.input.maxLength = config.maxMessageLength || 20_000;
    elements.aiModelLabel.textContent = config.ai.configured
      ? `已连接 · ${config.ai.model}`
      : "AI 接口尚未配置";

    if (!config.ai.configured) {
      setFormStatus(
        "请先在服务器 .env 中配置 OpenAI 兼容接口，再重启服务。",
        "error",
      );
    }

    renderConversationDirectory();
    renderSelectedConversation();
    updateCharacterCount();

    if (desktopMedia.matches && state.conversations.length > 0) {
      await selectConversation(state.conversations[0].id, {
        openMobile: false,
      });
    } else {
      setConnection(
        state.conversations.length > 0
          ? "选择一个对话开始聊天"
          : "新建一个独立对话",
        "online",
      );
    }

    startPolling();
  } catch (error) {
    setConnection(error.message, "error");
  }
}

async function selectConversation(
  conversationId,
  { openMobile = true, force = false, targetMessageId = null } = {},
) {
  const conversation = state.conversations.find(
    (item) => item.id === conversationId,
  );

  if (!conversation) {
    return;
  }

  if (
    state.generating &&
    conversationId !== state.selectedConversationId
  ) {
    stopGeneration();
  }

  if (openMobile && !desktopMedia.matches) {
    document.body.classList.add("mobile-chat-open");
  }

  if (
    !force &&
    state.selectedConversationId === conversationId &&
    state.conversationRevision !== null &&
    state.searchTargetMessageId === targetMessageId
  ) {
    renderConversationDirectory();
    return;
  }

  const token = state.selectionToken + 1;
  state.selectionToken = token;
  state.selectedConversationId = conversationId;
  resetMessageState();
  state.searchTargetMessageId = targetMessageId;
  renderConversationDirectory();
  renderSelectedConversation();
  setConnection(
    targetMessageId ? "正在定位查找结果…" : "正在读取聊天记录…",
    "busy",
  );

  const parameters = new URLSearchParams({ limit: "60" });
  if (targetMessageId) {
    parameters.set("around", targetMessageId);
  }

  try {
    const result = await api(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?${parameters}`,
    );

    if (
      token !== state.selectionToken ||
      state.selectedConversationId !== conversationId
    ) {
      return;
    }

    state.messages = result.messages;
    state.conversationRevision = result.conversationRevision;
    state.hasMore = result.hasMore;
    state.hasNewer = result.hasNewer;
    state.olderCursor = result.olderCursor;
    state.total = result.total;

    if (targetMessageId && !result.searchTargetFound) {
      state.searchTargetMessageId = null;
    }

    renderMessages();
    requestAnimationFrame(() => {
      if (state.searchTargetMessageId) {
        focusSearchTarget();
      } else {
        scrollToBottom("auto");
      }
    });
    setConnection(`${result.total} 条消息 · 上下文独立`, "online");
  } catch (error) {
    if (token === state.selectionToken) {
      setConnection(error.message, "error");
    }
  }
}

function focusSearchTarget() {
  const target = elements.messageList.querySelector(
    `[data-message-id="${CSS.escape(state.searchTargetMessageId || "")}"]`,
  );
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function loadOlderMessages() {
  const conversationId = state.selectedConversationId;

  if (
    !conversationId ||
    !state.hasMore ||
    state.loadingOlder ||
    !state.olderCursor
  ) {
    return;
  }

  state.loadingOlder = true;
  elements.loadOlder.disabled = true;
  elements.loadOlder.textContent = "正在加载…";
  const previousHeight = elements.chatScroll.scrollHeight;
  const previousTop = elements.chatScroll.scrollTop;

  try {
    const result = await api(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=60&before=${encodeURIComponent(state.olderCursor)}`,
    );

    if (state.selectedConversationId !== conversationId) {
      return;
    }

    const existing = new Set(state.messages.map((message) => message.id));
    const older = result.messages.filter((message) => !existing.has(message.id));
    state.messages = [...older, ...state.messages];
    state.hasMore = result.hasMore;
    state.olderCursor = result.olderCursor;
    state.conversationRevision = result.conversationRevision;
    state.total = result.total;
    renderMessages();

    requestAnimationFrame(() => {
      elements.chatScroll.scrollTop =
        previousTop + elements.chatScroll.scrollHeight - previousHeight;
    });
  } catch (error) {
    setConnection(error.message, "error");
  } finally {
    state.loadingOlder = false;
    elements.loadOlder.disabled = false;
    elements.loadOlder.textContent = "加载更早的消息";
  }
}

async function refreshSelectedMessages({ scroll = false } = {}) {
  const conversationId = state.selectedConversationId;
  if (!conversationId || state.generating) {
    return;
  }

  const result = await api(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`,
  );

  if (state.selectedConversationId !== conversationId) {
    return;
  }

  state.messages = result.messages;
  state.conversationRevision = result.conversationRevision;
  state.total = result.total;
  state.hasMore = result.hasMore;
  state.hasNewer = result.hasNewer;
  state.olderCursor = result.olderCursor;
  state.searchTargetMessageId = null;
  renderMessages();

  if (scroll) {
    requestAnimationFrame(() => scrollToBottom("smooth"));
  }
}

async function syncConversationList() {
  const result = await api("/api/conversations");
  state.conversations = result.conversations;
  state.globalRevision = result.revision;

  if (state.searchQuery) {
    await performSearch({ keepStatus: true });
  } else {
    renderConversationDirectory();
  }

  renderSelectedConversation();
}

async function refreshApp({ manual = false } = {}) {
  if (state.refreshing || state.generating) {
    return;
  }

  state.refreshing = true;
  elements.refreshButton.disabled = true;

  try {
    const result = await api("/api/conversations");
    const changed = result.revision !== state.globalRevision;
    state.conversations = result.conversations;
    state.globalRevision = result.revision;

    if (state.searchQuery) {
      await performSearch({ keepStatus: true });
    } else {
      renderConversationDirectory();
    }

    if (
      state.selectedConversationId &&
      !state.conversations.some(
        (conversation) => conversation.id === state.selectedConversationId,
      )
    ) {
      state.selectedConversationId = null;
      resetMessageState();
      renderSelectedConversation();
      return;
    }

    const conversation = selectedConversation();
    if (
      changed &&
      conversation &&
      conversation.revision !== state.conversationRevision
    ) {
      await refreshSelectedMessages();
    }

    renderSelectedConversation();

    if (manual) {
      setConnection(
        state.selectedConversationId
          ? `${state.total} 条消息 · 已刷新`
          : "对话列表已刷新",
        "online",
      );
    }
  } catch (error) {
    setConnection(error.message, "error");
  } finally {
    state.refreshing = false;
    elements.refreshButton.disabled = false;
  }
}

function scheduleSearch() {
  window.clearTimeout(state.searchTimer);
  state.searchQuery = elements.searchInput.value.trim();
  elements.searchClear.classList.toggle("is-hidden", !state.searchQuery);

  if (!state.searchQuery) {
    state.searchResults = [];
    state.searchRequestToken += 1;
    renderConversationDirectory();
    return;
  }

  state.searchTimer = window.setTimeout(() => performSearch(), 280);
}

async function performSearch({ keepStatus = false } = {}) {
  const query = state.searchQuery;
  if (!query) {
    state.searchResults = [];
    renderConversationDirectory();
    return;
  }

  const token = state.searchRequestToken + 1;
  state.searchRequestToken = token;
  elements.conversationHeadingTitle.textContent = "正在查找…";
  elements.conversationCount.textContent = "";

  try {
    const result = await api(
      `/api/search?q=${encodeURIComponent(query)}&limit=100`,
    );

    if (token !== state.searchRequestToken || query !== state.searchQuery) {
      return;
    }

    state.searchResults = result.results;
    renderConversationDirectory();

    if (!keepStatus) {
      setConnection(`找到 ${result.results.length} 条结果`, "online");
    }
  } catch (error) {
    if (token === state.searchRequestToken) {
      setConnection(error.message, "error");
    }
  }
}

function clearSearch() {
  elements.searchInput.value = "";
  state.searchQuery = "";
  state.searchResults = [];
  state.searchRequestToken += 1;
  elements.searchClear.classList.add("is-hidden");
  renderConversationDirectory();
}

function appendOrReplaceMessage(message) {
  const index = state.messages.findIndex((item) => item.id === message.id);
  if (index >= 0) {
    state.messages[index] = message;
  } else {
    state.messages.push(message);
  }
}

function ensureStreamingMessage() {
  if (state.streamingMessageId) {
    return state.messages.find(
      (message) => message.id === state.streamingMessageId,
    );
  }

  state.streamingMessageId = `stream-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const message = {
    id: state.streamingMessageId,
    sender: "B",
    content: "",
    renderedHtml: "",
    edited: false,
    streaming: true,
  };
  state.messages.push(message);
  state.total += 1;
  renderMessages();
  requestAnimationFrame(() => scrollToBottom("smooth"));
  return message;
}

async function submitMessage() {
  const conversationId = state.selectedConversationId;
  const content = elements.input.value.trim();

  if (
    !conversationId ||
    !content ||
    state.generating ||
    !state.config?.ai?.configured
  ) {
    return;
  }

  if (state.searchTargetMessageId || state.hasNewer) {
    await selectConversation(conversationId, {
      force: true,
      openMobile: false,
    });
  }

  state.generating = true;
  state.generationController = new AbortController();
  state.streamingMessageId = null;
  updateComposerState();
  setFormStatus("");
  setConnection("AI 正在回复…", "busy");

  try {
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: state.generationController.signal,
      },
    );

    if (!response.ok) {
      throw new Error(await responseError(response));
    }

    let streamError = null;

    await consumeEventStream(response, (eventName, payload) => {
      if (state.selectedConversationId !== conversationId) {
        return;
      }

      if (eventName === "user") {
        appendOrReplaceMessage(payload.message);
        upsertConversation(payload.conversation);
        state.conversationRevision = payload.conversation.revision;
        state.total = Math.max(state.total + 1, payload.conversation.messageCount);
        elements.input.value = "";
        updateCharacterCount();
        renderConversationDirectory();
        renderMessages();
        requestAnimationFrame(() => scrollToBottom("smooth"));
      } else if (eventName === "delta") {
        const streaming = ensureStreamingMessage();
        streaming.content += payload.content || "";
        renderMessages();
        requestAnimationFrame(() => scrollToBottom("auto"));
      } else if (eventName === "done") {
        state.messages = state.messages.filter(
          (message) => message.id !== state.streamingMessageId,
        );
        state.streamingMessageId = null;
        appendOrReplaceMessage(payload.message);
        upsertConversation(payload.conversation);
        state.conversationRevision = payload.conversation.revision;
        state.total = payload.conversation.messageCount;
        renderConversationDirectory();
        renderMessages();
        requestAnimationFrame(() => scrollToBottom("smooth"));
      } else if (eventName === "error") {
        streamError = new Error(payload.error || "AI 回复生成失败");
      }
    });

    if (streamError) {
      throw streamError;
    }

    setConnection(`${state.total} 条消息 · AI 回复完成`, "online");
  } catch (error) {
    const stopped =
      error?.name === "AbortError" || state.generationController?.signal.aborted;

    state.messages = state.messages.filter(
      (message) => message.id !== state.streamingMessageId,
    );
    state.streamingMessageId = null;
    renderMessages();

    if (stopped) {
      setFormStatus("已停止生成，已收到的部分会保存在服务器。");
      setConnection("AI 回复已停止", "online");
    } else {
      setFormStatus(error.message, "error");
      setConnection("AI 回复失败", "error");
    }

    window.setTimeout(() => {
      refreshSelectedMessages({ scroll: true }).catch(() => {});
      syncConversationList().catch(() => {});
    }, 180);
  } finally {
    state.generating = false;
    state.generationController = null;
    updateComposerState();
    syncConversationList().catch(() => {});
  }
}

function stopGeneration() {
  state.generationController?.abort();
}

function openConversationDialog(mode) {
  const conversation = selectedConversation();
  if (mode === "rename" && !conversation) {
    return;
  }

  state.dialogMode = mode;
  elements.dialogError.textContent = "";

  if (mode === "create") {
    elements.dialogEyebrow.textContent = "NEW CONVERSATION";
    elements.dialogTitle.textContent = "新建对话";
    elements.dialogDescription.textContent =
      "新对话不会携带其他对话的历史，每个对话都是独立上下文。";
    elements.dialogName.value = "";
    elements.dialogConfirm.textContent = "创建对话";
  } else {
    elements.dialogEyebrow.textContent = "RENAME CONVERSATION";
    elements.dialogTitle.textContent = "重命名对话";
    elements.dialogDescription.textContent =
      "修改名称不会改变这个对话已经保存的上下文。";
    elements.dialogName.value = conversation.name;
    elements.dialogConfirm.textContent = "保存名称";
  }

  elements.dialog.showModal();
  requestAnimationFrame(() => {
    elements.dialogName.focus();
    elements.dialogName.select();
  });
}

async function saveConversation(event) {
  event.preventDefault();
  const name = elements.dialogName.value.trim();

  if (!name) {
    elements.dialogError.textContent = "请输入对话名称";
    elements.dialogName.focus();
    return;
  }

  elements.dialogConfirm.disabled = true;
  elements.dialogError.textContent = "";

  try {
    if (state.dialogMode === "create") {
      const result = await api("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      await syncConversationList();
      elements.dialog.close();
      await selectConversation(result.conversation.id, {
        openMobile: true,
        force: true,
      });
      elements.input.focus();
      setFormStatus("新对话已创建，这是一个全新的上下文。");
    } else {
      const conversationId = state.selectedConversationId;
      await api(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      });
      await syncConversationList();
      state.conversationRevision = selectedConversation()?.revision ?? null;
      elements.dialog.close();
      setConnection(`${state.total} 条消息 · 名称已修改`, "online");
    }
  } catch (error) {
    elements.dialogError.textContent = error.message;
  } finally {
    elements.dialogConfirm.disabled = false;
  }
}

async function deleteCurrentConversation() {
  const conversation = selectedConversation();
  if (!conversation || state.generating) {
    return;
  }

  const confirmed = window.confirm(
    `确定删除对话“${conversation.name}”吗？\n\n其中的 ${conversation.messageCount} 条消息也会一起删除，且无法恢复。`,
  );

  if (!confirmed) {
    return;
  }

  try {
    await api(`/api/conversations/${encodeURIComponent(conversation.id)}`, {
      method: "DELETE",
    });
    state.selectedConversationId = null;
    resetMessageState();
    await syncConversationList();

    if (desktopMedia.matches && state.conversations.length > 0) {
      await selectConversation(state.conversations[0].id, {
        openMobile: false,
        force: true,
      });
    } else {
      renderSelectedConversation();
      document.body.classList.remove("mobile-chat-open");
      setConnection("选择或新建一个对话", "online");
    }
  } catch (error) {
    setConnection(error.message, "error");
  }
}

function startPolling() {
  window.clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(() => {
    if (!document.hidden && !state.generating) {
      refreshApp();
    }
  }, state.refreshInterval);
}

elements.conversationList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-conversation-id]");
  if (!item) {
    return;
  }

  selectConversation(item.dataset.conversationId, {
    targetMessageId: item.dataset.messageId || null,
  });
});

elements.searchInput.addEventListener("input", scheduleSearch);
elements.searchClear.addEventListener("click", clearSearch);
elements.newConversation.addEventListener("click", () =>
  openConversationDialog("create"),
);
elements.renameConversation.addEventListener("click", () =>
  openConversationDialog("rename"),
);
elements.deleteConversation.addEventListener(
  "click",
  deleteCurrentConversation,
);
elements.backToConversations.addEventListener("click", () => {
  if (state.generating) {
    stopGeneration();
  }
  document.body.classList.remove("mobile-chat-open");
});

elements.dialogForm.addEventListener("submit", saveConversation);
elements.dialogCancel.addEventListener("click", () => elements.dialog.close());
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) {
    elements.dialog.close();
  }
});

elements.input.addEventListener("input", updateCharacterCount);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submitMessage();
  }
});
elements.submit.addEventListener("click", submitMessage);
elements.stop.addEventListener("click", stopGeneration);
elements.loadOlder.addEventListener("click", loadOlderMessages);
elements.refreshButton.addEventListener("click", () =>
  refreshApp({ manual: true }),
);
elements.jumpLatest.addEventListener("click", () => {
  if (state.searchTargetMessageId || state.hasNewer) {
    selectConversation(state.selectedConversationId, {
      force: true,
      openMobile: false,
    });
  } else {
    scrollToBottom();
  }
});

elements.chatScroll.addEventListener(
  "scroll",
  () => {
    if (elements.chatScroll.scrollTop < 90) {
      loadOlderMessages();
    }

    if (
      isNearBottom() &&
      !state.searchTargetMessageId &&
      !state.hasNewer
    ) {
      elements.jumpLatest.classList.add("is-hidden");
    }
  },
  { passive: true },
);

desktopMedia.addEventListener("change", (event) => {
  if (event.matches) {
    document.body.classList.remove("mobile-chat-open");

    if (!state.selectedConversationId && state.conversations.length > 0) {
      selectConversation(state.conversations[0].id, {
        openMobile: false,
      });
    }
  } else {
    document.body.classList.remove("mobile-chat-open");
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !state.generating) {
    refreshApp();
  }
});

loadInitial();
