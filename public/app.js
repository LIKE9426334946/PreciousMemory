const state = {
  conversations: [],
  globalRevision: null,
  selectedConversationId: null,
  messages: [],
  conversationRevision: null,
  hasMore: false,
  olderCursor: null,
  latestSeq: 0,
  total: 0,
  sender: "A",
  editingMessageId: null,
  dialogMode: "create",
  loadingOlder: false,
  refreshing: false,
  submitting: false,
  refreshInterval: 5000,
  pollTimer: null,
  selectionToken: 0,
};

const elements = {
  conversationList: document.querySelector("#conversation-list"),
  conversationCount: document.querySelector("#conversation-count"),
  conversationEmpty: document.querySelector("#conversation-empty"),
  newConversation: document.querySelector("#new-conversation"),
  renameConversation: document.querySelector("#rename-conversation"),
  deleteConversation: document.querySelector("#delete-conversation"),
  currentConversationName: document.querySelector(
    "#current-conversation-name",
  ),
  backToConversations: document.querySelector("#back-to-conversations"),
  noSelection: document.querySelector("#no-selection"),
  chatScroll: document.querySelector("#chat-scroll"),
  messageList: document.querySelector("#message-list"),
  messageEmpty: document.querySelector("#message-empty"),
  loadOlder: document.querySelector("#load-older"),
  jumpLatest: document.querySelector("#jump-latest"),
  refreshButton: document.querySelector("#refresh-button"),
  connectionDot: document.querySelector("#connection-dot"),
  connectionStatus: document.querySelector("#connection-status"),
  composer: document.querySelector("#composer"),
  senderOptions: [...document.querySelectorAll(".sender-option")],
  input: document.querySelector("#message-input"),
  characterCount: document.querySelector("#character-count"),
  submit: document.querySelector("#submit-message"),
  cancelEdit: document.querySelector("#cancel-edit"),
  composerModeLabel: document.querySelector("#composer-mode-label"),
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
      // Keep the fallback message when the response is not JSON.
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function selectedConversation() {
  return (
    state.conversations.find(
      (conversation) => conversation.id === state.selectedConversationId,
    ) || null
  );
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

function formatConversationTime(isoString) {
  if (!isoString) {
    return "";
  }

  const date = new Date(isoString);
  const current = new Date();
  const sameDay = date.toDateString() === current.toDateString();

  if (sameDay) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function formatDividerTime(isoString) {
  const date = new Date(isoString);
  const current = new Date();
  const sameYear = date.getFullYear() === current.getFullYear();

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

function createConversationItem(conversation) {
  const button = document.createElement("button");
  button.className = "conversation-item";
  button.type = "button";
  button.dataset.conversationId = conversation.id;
  button.classList.toggle(
    "is-active",
    conversation.id === state.selectedConversationId,
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

  const time = document.createElement("time");
  time.className = "conversation-time";
  time.dateTime = conversation.lastMessageAt || conversation.updatedAt;
  time.textContent = formatConversationTime(
    conversation.lastMessageAt || conversation.updatedAt,
  );

  const preview = document.createElement("span");
  preview.className = "conversation-preview";
  preview.textContent =
    conversation.lastMessagePreview ||
    (conversation.messageCount === 0 ? "还没有聊天记录" : "消息记录");

  top.append(name, time);
  copy.append(top, preview);
  button.append(avatar, copy);
  return button;
}

function renderConversationList() {
  const fragment = document.createDocumentFragment();

  for (const conversation of state.conversations) {
    fragment.append(createConversationItem(conversation));
  }

  elements.conversationList.replaceChildren(fragment);
  elements.conversationCount.textContent = `${state.conversations.length} 个`;
  elements.conversationEmpty.classList.toggle(
    "is-hidden",
    state.conversations.length > 0,
  );
}

function setComposerEnabled(enabled) {
  elements.composer.classList.toggle("is-disabled", !enabled);
  elements.input.disabled = !enabled;
  elements.submit.disabled = !enabled || state.submitting;

  for (const option of elements.senderOptions) {
    option.disabled = !enabled || Boolean(state.editingMessageId);
  }
}

function renderSelectedConversation() {
  const conversation = selectedConversation();
  const hasSelection = Boolean(conversation);

  elements.currentConversationName.textContent = conversation
    ? conversation.name
    : "请选择一个对话";
  elements.renameConversation.disabled = !hasSelection;
  elements.deleteConversation.disabled = !hasSelection;
  elements.noSelection.classList.toggle("is-hidden", hasSelection);
  elements.chatScroll.classList.toggle("is-hidden", !hasSelection);
  setComposerEnabled(hasSelection);
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
  elements.messageEmpty.classList.toggle(
    "is-hidden",
    state.messages.length > 0,
  );
  elements.loadOlder.classList.toggle(
    "is-hidden",
    !state.hasMore || state.messages.length === 0,
  );
}

function resetMessageState() {
  state.messages = [];
  state.conversationRevision = null;
  state.hasMore = false;
  state.olderCursor = null;
  state.latestSeq = 0;
  state.total = 0;
  renderMessages();
}

function clearSelection() {
  state.selectionToken += 1;
  state.selectedConversationId = null;
  resetMessageState();
  exitEditMode();
  renderConversationList();
  renderSelectedConversation();
  document.body.classList.remove("mobile-chat-open");
  setConnection("请选择一个对话", "online");
}

async function loadInitial() {
  setConnection("正在读取对话列表…", "loading");

  try {
    const [config, result] = await Promise.all([
      api("/api/config"),
      api("/api/conversations"),
    ]);

    state.refreshInterval = config.refreshInterval || 5000;
    state.conversations = result.conversations;
    state.globalRevision = result.revision;
    renderConversationList();
    renderSelectedConversation();

    if (desktopMedia.matches && state.conversations.length > 0) {
      await selectConversation(state.conversations[0].id, {
        openMobile: false,
      });
    } else {
      setConnection(
        state.conversations.length > 0
          ? "选择一个对话查看记录"
          : "还没有对话",
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
  { openMobile = true, force = false } = {},
) {
  const conversation = state.conversations.find(
    (item) => item.id === conversationId,
  );

  if (!conversation) {
    return;
  }

  if (openMobile && !desktopMedia.matches) {
    document.body.classList.add("mobile-chat-open");
  }

  if (
    !force &&
    state.selectedConversationId === conversationId &&
    state.conversationRevision !== null
  ) {
    renderConversationList();
    return;
  }

  const token = state.selectionToken + 1;
  state.selectionToken = token;
  state.selectedConversationId = conversationId;
  resetMessageState();
  exitEditMode();
  renderConversationList();
  renderSelectedConversation();
  setConnection("正在读取聊天记录…", "loading");

  try {
    const result = await api(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=60`,
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
    state.olderCursor = result.olderCursor;
    state.latestSeq = result.latestSeq;
    state.total = result.total;
    renderMessages();
    requestAnimationFrame(() => scrollToBottom("auto"));
    setConnection(
      `${result.total} 条记录 · 已同步到服务器`,
      "online",
    );
  } catch (error) {
    if (token === state.selectionToken) {
      setConnection(error.message, "error");
    }
  }
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
  const oldHeight = elements.chatScroll.scrollHeight;
  const oldTop = elements.chatScroll.scrollTop;

  try {
    const result = await api(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=60&before=${encodeURIComponent(state.olderCursor)}`,
    );

    if (state.selectedConversationId !== conversationId) {
      return;
    }

    const existingIds = new Set(state.messages.map((message) => message.id));
    const older = result.messages.filter((message) => !existingIds.has(message.id));

    state.messages = [...older, ...state.messages];
    state.hasMore = result.hasMore;
    state.olderCursor = result.olderCursor;
    state.conversationRevision = result.conversationRevision;
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

async function refreshSelectedMessages({ preservePosition = true } = {}) {
  const conversationId = state.selectedConversationId;
  if (!conversationId) {
    return;
  }

  const nearBottom = isNearBottom();
  const previousScrollTop = elements.chatScroll.scrollTop;
  const recentLimit = Math.min(200, Math.max(60, state.messages.length));
  const result = await api(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${recentLimit}`,
  );

  if (state.selectedConversationId !== conversationId) {
    return;
  }

  if (result.total <= result.messages.length) {
    state.messages = result.messages;
  } else if (result.messages.length > 0) {
    const recentStart = result.messages[0].seq;
    const olderLoaded = state.messages.filter(
      (message) => message.seq < recentStart,
    );
    state.messages = [...olderLoaded, ...result.messages];
  }

  state.latestSeq = result.latestSeq;
  state.conversationRevision = result.conversationRevision;
  state.total = result.total;
  state.hasMore = state.messages.length < result.total;
  state.olderCursor =
    state.hasMore && state.messages.length > 0 ? state.messages[0].seq : null;
  renderMessages();

  requestAnimationFrame(() => {
    if (nearBottom || !preservePosition) {
      scrollToBottom(nearBottom ? "smooth" : "auto");
    } else {
      elements.chatScroll.scrollTop = previousScrollTop;
      elements.jumpLatest.classList.remove("is-hidden");
    }
  });
}

async function refreshApp({ manual = false } = {}) {
  if (state.refreshing) {
    return;
  }

  state.refreshing = true;
  elements.refreshButton.disabled = true;

  try {
    const result = await api("/api/conversations");

    if (result.revision === state.globalRevision) {
      if (manual) {
        setConnection(
          state.selectedConversationId
            ? `${state.total} 条记录 · 已经是最新内容`
            : "对话列表已经是最新内容",
          "online",
        );
      }
      return;
    }

    state.conversations = result.conversations;
    state.globalRevision = result.revision;

    if (
      state.selectedConversationId &&
      !state.conversations.some(
        (conversation) => conversation.id === state.selectedConversationId,
      )
    ) {
      clearSelection();

      if (desktopMedia.matches && state.conversations.length > 0) {
        await selectConversation(state.conversations[0].id, {
          openMobile: false,
        });
      }

      return;
    }

    renderConversationList();
    renderSelectedConversation();

    const conversation = selectedConversation();
    if (
      conversation &&
      conversation.revision !== state.conversationRevision
    ) {
      await refreshSelectedMessages();
    }

    setConnection(
      state.selectedConversationId
        ? `${state.total} 条记录 · 刚刚同步`
        : "对话列表已同步",
      "online",
    );
  } catch (error) {
    setConnection(error.message, "error");
  } finally {
    state.refreshing = false;
    elements.refreshButton.disabled = false;
  }
}

async function syncConversationList() {
  const result = await api("/api/conversations");
  state.conversations = result.conversations;
  state.globalRevision = result.revision;
  renderConversationList();
  renderSelectedConversation();
}

function setSender(sender) {
  if (!["A", "B"].includes(sender) || state.editingMessageId) {
    return;
  }

  state.sender = sender;
  setSenderVisual(sender);
}

function setSenderVisual(sender) {
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
  state.editingMessageId = message.id;
  state.sender = message.sender;
  elements.input.value = message.content;
  elements.composerModeLabel.textContent = "正在修改消息";
  elements.submit.textContent = "保存修改";
  elements.cancelEdit.classList.remove("is-hidden");
  setSenderVisual(message.sender);
  setComposerEnabled(true);
  updateCharacterCount();
  setFormStatus("");
  elements.input.focus();
}

function exitEditMode({ clear = true } = {}) {
  state.editingMessageId = null;
  elements.composerModeLabel.textContent = "记录新消息";
  elements.submit.textContent = "保存消息";
  elements.cancelEdit.classList.add("is-hidden");

  if (clear) {
    elements.input.value = "";
  }

  setSenderVisual(state.sender);
  setComposerEnabled(Boolean(state.selectedConversationId));
  updateCharacterCount();
}

async function submitMessage() {
  const conversationId = state.selectedConversationId;
  if (!conversationId || state.submitting) {
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
  setFormStatus(state.editingMessageId ? "正在保存修改…" : "正在保存消息…");

  try {
    if (state.editingMessageId) {
      const messageId = state.editingMessageId;
      const result = await api(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: "PUT",
          body: JSON.stringify({ content }),
        },
      );
      const index = state.messages.findIndex(
        (message) => message.id === messageId,
      );

      if (index !== -1) {
        state.messages[index] = result.message;
      }

      state.conversationRevision = result.conversation.revision;
      exitEditMode();
      renderMessages();
      setFormStatus("修改已保存");
    } else {
      const result = await api(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            sender: state.sender,
            content,
          }),
        },
      );

      state.messages.push(result.message);
      state.latestSeq = Math.max(state.latestSeq, result.message.seq);
      state.conversationRevision = result.conversation.revision;
      state.total += 1;
      elements.input.value = "";
      updateCharacterCount();
      renderMessages();
      requestAnimationFrame(() => scrollToBottom("smooth"));
      setFormStatus("消息已保存");
    }

    await syncConversationList();
    setConnection(`${state.total} 条记录 · 刚刚保存`, "online");
  } catch (error) {
    setFormStatus(error.message, "error");
  } finally {
    state.submitting = false;
    elements.submit.disabled = !state.selectedConversationId;
  }
}

async function deleteMessage(message) {
  const conversationId = state.selectedConversationId;
  if (!conversationId) {
    return;
  }

  const summary = message.content.replace(/\s+/g, " ").slice(0, 38);
  const confirmed = window.confirm(`确定删除这条记录吗？\n\n${summary}`);

  if (!confirmed) {
    return;
  }

  try {
    await api(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(message.id)}`,
      { method: "DELETE" },
    );
    state.messages = state.messages.filter((item) => item.id !== message.id);
    state.total = Math.max(0, state.total - 1);

    if (state.editingMessageId === message.id) {
      exitEditMode();
    }

    await syncConversationList();
    state.conversationRevision = selectedConversation()?.revision ?? null;
    renderMessages();
    setFormStatus("消息已删除");
    setConnection(`${state.total} 条记录 · 刚刚保存`, "online");
  } catch (error) {
    setFormStatus(error.message, "error");
  }
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
      "给这段聊天记录起一个容易辨认的名字。";
    elements.dialogName.value = "";
    elements.dialogConfirm.textContent = "创建对话";
  } else {
    elements.dialogEyebrow.textContent = "RENAME CONVERSATION";
    elements.dialogTitle.textContent = "重命名对话";
    elements.dialogDescription.textContent =
      "修改名称不会影响这个对话中已经保存的消息。";
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
        openMobile: false,
        force: true,
      });
      setFormStatus("新对话已创建");
    } else {
      const conversationId = state.selectedConversationId;
      await api(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      });
      await syncConversationList();
      state.conversationRevision = selectedConversation()?.revision ?? null;
      elements.dialog.close();
      setConnection(`${state.total} 条记录 · 名称已修改`, "online");
    }
  } catch (error) {
    elements.dialogError.textContent = error.message;
  } finally {
    elements.dialogConfirm.disabled = false;
  }
}

async function deleteCurrentConversation() {
  const conversation = selectedConversation();
  if (!conversation) {
    return;
  }

  const confirmed = window.confirm(
    `确定删除对话“${conversation.name}”吗？\n\n其中的 ${conversation.messageCount} 条聊天记录也会一起删除，且无法恢复。`,
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
    exitEditMode();
    await syncConversationList();

    if (desktopMedia.matches && state.conversations.length > 0) {
      await selectConversation(state.conversations[0].id, {
        openMobile: false,
        force: true,
      });
    } else {
      clearSelection();
    }
  } catch (error) {
    setConnection(error.message, "error");
  }
}

function startPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
  }

  state.pollTimer = window.setInterval(() => {
    if (!document.hidden) {
      refreshApp();
    }
  }, state.refreshInterval);
}

elements.conversationList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-conversation-id]");
  if (item) {
    selectConversation(item.dataset.conversationId);
  }
});

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
  document.body.classList.remove("mobile-chat-open");
});

elements.dialogForm.addEventListener("submit", saveConversation);
elements.dialogCancel.addEventListener("click", () => elements.dialog.close());
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) {
    elements.dialog.close();
  }
});

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
  refreshApp({ manual: true }),
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

desktopMedia.addEventListener("change", (event) => {
  renderMessages();

  if (event.matches) {
    document.body.classList.remove("mobile-chat-open");

    if (!state.selectedConversationId && state.conversations.length > 0) {
      selectConversation(state.conversations[0].id, {
        openMobile: false,
      });
    }
  } else {
    document.body.classList.remove("mobile-chat-open");

    if (state.editingMessageId) {
      exitEditMode();
    }
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshApp();
  }
});

updateCharacterCount();
loadInitial();
