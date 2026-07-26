const state = {
  messages: [],
  hasMore: false,
  olderCursor: null,
  latestSeq: 0,
  revision: null,
  total: 0,
  sender: "A",
  editingId: null,
  loadingOlder: false,
  refreshing: false,
  submitting: false,
  refreshInterval: 5000,
  pollTimer: null,
};

const elements = {
  chatScroll: document.querySelector("#chat-scroll"),
  messageList: document.querySelector("#message-list"),
  emptyState: document.querySelector("#empty-state"),
  loadOlder: document.querySelector("#load-older"),
  jumpLatest: document.querySelector("#jump-latest"),
  refreshButton: document.querySelector("#refresh-button"),
  connectionDot: document.querySelector("#connection-dot"),
  connectionStatus: document.querySelector("#connection-status"),
  senderFieldset: document.querySelector("#sender-fieldset"),
  senderOptions: [...document.querySelectorAll(".sender-option")],
  input: document.querySelector("#message-input"),
  characterCount: document.querySelector("#character-count"),
  submit: document.querySelector("#submit-message"),
  cancelEdit: document.querySelector("#cancel-edit"),
  composerTitle: document.querySelector("#composer-title"),
  formStatus: document.querySelector("#form-status"),
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
      // Keep the fallback message when the response is not JSON.
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function setConnection(status, type = "online") {
  elements.connectionStatus.textContent = status;
  elements.connectionDot.classList.toggle("is-online", type === "online");
  elements.connectionDot.classList.toggle("is-error", type === "error");
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
  return distance < 120;
}

function scrollToBottom(behavior = "smooth") {
  elements.chatScroll.scrollTo({
    top: elements.chatScroll.scrollHeight,
    behavior,
  });
  elements.jumpLatest.classList.add("is-hidden");
}

function formatDividerTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();

  return new Intl.DateTimeFormat("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatMessageTime(isoString) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoString));
}

function needsTimeDivider(previous, current) {
  if (!previous) {
    return true;
  }

  const previousTime = new Date(previous.createdAt).getTime();
  const currentTime = new Date(current.createdAt).getTime();
  return currentTime - previousTime >= 10 * 60 * 1000;
}

function createTimeDivider(message) {
  const divider = document.createElement("div");
  divider.className = "time-divider";
  const label = document.createElement("span");
  label.textContent = formatDividerTime(message.createdAt);
  divider.append(label);
  return divider;
}

function createMessageRow(message) {
  const row = document.createElement("article");
  row.className = `message-row ${message.sender === "A" ? "is-mine" : "is-theirs"}`;
  row.dataset.messageId = message.id;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = message.sender === "A" ? "我" : "TA";

  const column = document.createElement("div");
  column.className = "message-column";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  const markdown = document.createElement("div");
  markdown.className = "markdown-body";
  markdown.innerHTML = message.renderedHtml;
  bubble.append(markdown);

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const time = document.createElement("time");
  time.dateTime = message.createdAt;
  time.textContent = formatMessageTime(message.createdAt);
  meta.append(time);

  if (message.updatedAt !== message.createdAt) {
    const edited = document.createElement("span");
    edited.className = "edited-label";
    edited.textContent = "已编辑";
    meta.append(edited);
  }

  if (desktopMedia.matches) {
    const actions = document.createElement("span");
    actions.className = "message-actions";

    const edit = document.createElement("button");
    edit.className = "message-action";
    edit.type = "button";
    edit.dataset.action = "edit";
    edit.textContent = "修改";

    const remove = document.createElement("button");
    remove.className = "message-action is-danger";
    remove.type = "button";
    remove.dataset.action = "delete";
    remove.textContent = "删除";

    actions.append(edit, remove);
    meta.append(actions);
  }

  column.append(bubble, meta);
  row.append(avatar, column);
  return row;
}

function renderMessages() {
  const fragment = document.createDocumentFragment();
  let previous = null;

  for (const message of state.messages) {
    if (needsTimeDivider(previous, message)) {
      fragment.append(createTimeDivider(message));
    }

    fragment.append(createMessageRow(message));
    previous = message;
  }

  elements.messageList.replaceChildren(fragment);
  elements.emptyState.classList.toggle("is-hidden", state.messages.length > 0);
  elements.loadOlder.classList.toggle(
    "is-hidden",
    !state.hasMore || state.messages.length === 0,
  );
}

async function loadInitial() {
  setConnection("正在读取聊天记录…", "loading");

  try {
    const [config, result] = await Promise.all([
      api("/api/config"),
      api("/api/messages?limit=60"),
    ]);

    state.refreshInterval = config.refreshInterval || 5000;
    state.messages = result.messages;
    state.hasMore = result.hasMore;
    state.olderCursor = result.olderCursor;
    state.latestSeq = result.latestSeq;
    state.revision = result.revision;
    state.total = result.total;

    renderMessages();
    requestAnimationFrame(() => scrollToBottom("auto"));
    setConnection("已同步 · 内容保存在服务器", "online");
    startPolling();
  } catch (error) {
    setConnection(error.message, "error");
  }
}

async function loadOlderMessages() {
  if (!state.hasMore || state.loadingOlder || !state.olderCursor) {
    return;
  }

  state.loadingOlder = true;
  elements.loadOlder.disabled = true;
  elements.loadOlder.textContent = "正在加载…";
  const oldHeight = elements.chatScroll.scrollHeight;
  const oldTop = elements.chatScroll.scrollTop;

  try {
    const result = await api(
      `/api/messages?limit=60&before=${encodeURIComponent(state.olderCursor)}`,
    );
    const existingIds = new Set(state.messages.map((message) => message.id));
    const older = result.messages.filter((message) => !existingIds.has(message.id));

    state.messages = [...older, ...state.messages];
    state.hasMore = result.hasMore;
    state.olderCursor = result.olderCursor;
    state.revision = result.revision;
    state.total = result.total;

    renderMessages();
    requestAnimationFrame(() => {
      const addedHeight = elements.chatScroll.scrollHeight - oldHeight;
      elements.chatScroll.scrollTop = oldTop + addedHeight;
    });
  } catch (error) {
    setConnection(error.message, "error");
  } finally {
    state.loadingOlder = false;
    elements.loadOlder.disabled = false;
    elements.loadOlder.textContent = "加载更早的记录";
  }
}

async function refreshMessages({ manual = false } = {}) {
  if (state.refreshing) {
    return;
  }

  state.refreshing = true;
  elements.refreshButton.disabled = true;
  const nearBottom = isNearBottom();
  const previousScrollTop = elements.chatScroll.scrollTop;

  try {
    const probe = await api(
      `/api/messages?limit=200&after=${encodeURIComponent(state.latestSeq)}`,
    );

    if (probe.revision === state.revision) {
      if (manual) {
        setConnection("已经是最新内容", "online");
      }
      return;
    }

    const recentLimit = Math.min(
      200,
      Math.max(60, state.messages.length + probe.messages.length),
    );
    const recent = await api(`/api/messages?limit=${recentLimit}`);

    if (recent.total <= recent.messages.length) {
      state.messages = recent.messages;
    } else if (recent.messages.length > 0) {
      const recentStart = recent.messages[0].seq;
      const olderLoaded = state.messages.filter(
        (message) => message.seq < recentStart,
      );
      state.messages = [...olderLoaded, ...recent.messages];
    }

    state.latestSeq = recent.latestSeq;
    state.revision = recent.revision;
    state.total = recent.total;
    state.hasMore = state.messages.length < recent.total;
    state.olderCursor =
      state.hasMore && state.messages.length > 0 ? state.messages[0].seq : null;

    renderMessages();

    requestAnimationFrame(() => {
      if (nearBottom) {
        scrollToBottom("smooth");
      } else {
        elements.chatScroll.scrollTop = previousScrollTop;
        elements.jumpLatest.classList.remove("is-hidden");
      }
    });

    setConnection("刚刚同步 · 内容保存在服务器", "online");
  } catch (error) {
    setConnection(error.message, "error");
  } finally {
    state.refreshing = false;
    elements.refreshButton.disabled = false;
  }
}

function setSender(sender) {
  if (!["A", "B"].includes(sender) || state.editingId) {
    return;
  }

  state.sender = sender;
  for (const option of elements.senderOptions) {
    const isActive = option.dataset.sender === sender;
    option.classList.toggle("is-active", isActive);
    option.setAttribute("aria-checked", String(isActive));
  }
}

function updateCharacterCount() {
  elements.characterCount.textContent = `${elements.input.value.length} / 20000`;
}

function enterEditMode(message) {
  state.editingId = message.id;
  state.sender = message.sender;
  elements.input.value = message.content;
  elements.composerTitle.textContent = "修改这条消息";
  elements.submit.textContent = "保存修改";
  elements.cancelEdit.classList.remove("is-hidden");
  elements.senderOptions.forEach((option) => {
    option.disabled = true;
  });
  setSenderVisual(message.sender);
  updateCharacterCount();
  setFormStatus("");
  elements.input.focus();
}

function setSenderVisual(sender) {
  for (const option of elements.senderOptions) {
    const isActive = option.dataset.sender === sender;
    option.classList.toggle("is-active", isActive);
    option.setAttribute("aria-checked", String(isActive));
  }
}

function exitEditMode({ clear = true } = {}) {
  state.editingId = null;
  elements.composerTitle.textContent = "记录一段对话";
  elements.submit.textContent = "保存消息";
  elements.cancelEdit.classList.add("is-hidden");
  elements.senderOptions.forEach((option) => {
    option.disabled = false;
  });

  if (clear) {
    elements.input.value = "";
  }

  setSenderVisual(state.sender);
  updateCharacterCount();
}

async function submitMessage() {
  if (state.submitting) {
    return;
  }

  const content = elements.input.value.trim();
  if (!content) {
    setFormStatus("请先输入消息内容", "error");
    elements.input.focus();
    return;
  }

  state.submitting = true;
  elements.submit.disabled = true;
  setFormStatus(state.editingId ? "正在保存修改…" : "正在保存消息…");

  try {
    if (state.editingId) {
      const id = state.editingId;
      const result = await api(`/api/messages/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      const index = state.messages.findIndex((message) => message.id === id);

      if (index !== -1) {
        state.messages[index] = result.message;
      }

      state.revision += 1;
      exitEditMode();
      renderMessages();
      setFormStatus("修改已保存");
    } else {
      const result = await api("/api/messages", {
        method: "POST",
        body: JSON.stringify({
          sender: state.sender,
          content,
        }),
      });

      state.messages.push(result.message);
      state.latestSeq = Math.max(state.latestSeq, result.message.seq);
      state.revision += 1;
      state.total += 1;
      elements.input.value = "";
      updateCharacterCount();
      renderMessages();
      requestAnimationFrame(() => scrollToBottom("smooth"));
      setFormStatus("消息已保存");
    }

    setConnection("刚刚同步 · 内容保存在服务器", "online");
  } catch (error) {
    setFormStatus(error.message, "error");
  } finally {
    state.submitting = false;
    elements.submit.disabled = false;
  }
}

async function deleteMessage(message) {
  const summary = message.content.replace(/\s+/g, " ").slice(0, 38);
  const confirmed = window.confirm(`确定删除这条记录吗？\n\n${summary}`);

  if (!confirmed) {
    return;
  }

  try {
    await api(`/api/messages/${encodeURIComponent(message.id)}`, {
      method: "DELETE",
    });
    state.messages = state.messages.filter((item) => item.id !== message.id);
    state.revision += 1;
    state.total = Math.max(0, state.total - 1);

    if (state.editingId === message.id) {
      exitEditMode();
    }

    renderMessages();
    setFormStatus("消息已删除");
  } catch (error) {
    setFormStatus(error.message, "error");
  }
}

function startPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
  }

  state.pollTimer = window.setInterval(() => {
    if (!document.hidden) {
      refreshMessages();
    }
  }, state.refreshInterval);
}

elements.senderOptions.forEach((option) => {
  option.addEventListener("click", () => setSender(option.dataset.sender));
});

elements.input.addEventListener("input", updateCharacterCount);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    submitMessage();
  }
});

elements.submit.addEventListener("click", submitMessage);
elements.cancelEdit.addEventListener("click", () => {
  exitEditMode();
  setFormStatus("");
});

elements.messageList.addEventListener("click", (event) => {
  if (!desktopMedia.matches) {
    return;
  }

  const action = event.target.closest("[data-action]");
  const row = event.target.closest("[data-message-id]");
  if (!action || !row) {
    return;
  }

  const message = state.messages.find((item) => item.id === row.dataset.messageId);
  if (!message) {
    return;
  }

  if (action.dataset.action === "edit") {
    enterEditMode(message);
  } else if (action.dataset.action === "delete") {
    deleteMessage(message);
  }
});

elements.loadOlder.addEventListener("click", loadOlderMessages);
elements.refreshButton.addEventListener("click", () =>
  refreshMessages({ manual: true }),
);
elements.jumpLatest.addEventListener("click", () => scrollToBottom());

elements.chatScroll.addEventListener(
  "scroll",
  () => {
    if (elements.chatScroll.scrollTop < 90) {
      loadOlderMessages();
    }

    if (isNearBottom()) {
      elements.jumpLatest.classList.add("is-hidden");
    }
  },
  { passive: true },
);

desktopMedia.addEventListener("change", () => {
  renderMessages();
  if (!desktopMedia.matches && state.editingId) {
    exitEditMode();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshMessages();
  }
});

updateCharacterCount();
loadInitial();

