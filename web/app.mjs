import {
  ACTIVE_KEY, chatTitle, contextMessages, createChat, migrateLegacy,
  openChatDatabase, readChats, readMemories, sortedChats, writeChat, writeMemories,
} from "./chats.mjs";
import { arithmeticReply } from "./calculator.mjs";
import { explicitFactReply } from "./facts.mjs";
import { conversationRecall } from "./conversation-recall.mjs";
import { forgetRequest, memoryChanges, memoryOverview } from "./memory.mjs";
import { loadLocalModel } from "./local-model.mjs";
import { MODELS } from "./model-settings.mjs";

const byId = id => document.getElementById(id);
const form = byId("composer-form");
const prompt = byId("prompt");
const chat = byId("chat");
const list = byId("messages");
const send = byId("send");
const stop = byId("stop");
const install = byId("install");
const downloadModel = byId("download-model");
const historyDialog = byId("history-dialog");
const settingsDialog = byId("settings-dialog");
const chats = new Map();
const memories = new Map();
const savedModels = new Set();
let memoryEnabled = true;
try { memoryEnabled = localStorage.getItem("jex-memory-enabled") !== "false"; } catch {}
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
let current = createChat();
let database;
let saves = Promise.resolve();
let storageReady = false;
let active = null;
let worker;
let localModel;
let mode;
let preferredModel = "local";
let connecting = false;
let ready = false;
let installPrompt;
let waitingUpdate;
let applyingUpdate = false;

function saveWarning(text) {
  byId("save-status").textContent = text;
  byId("save-status").hidden = false;
}

function persist(thread) {
  if (!database) return;
  saves = saves.then(async () => {
    thread.revision = await writeChat(database, structuredClone(thread));
  }).catch(error => {
    saveWarning(error.message === "conflict"
      ? "This chat changed in another tab. Keep this tab open to preserve your unsaved changes."
      : "This browser couldn’t save the latest changes. Keep this tab open.");
  });
}

function saveMemoryChanges(changes) {
  for (const change of changes) {
    if (change.deleted) memories.delete(change.key);
    else memories.set(change.key, change);
  }
  renderMemories();
  if (!database || !changes.length) return;
  saves = saves.then(() => writeMemories(database, changes)).catch(() => {
    saveWarning("This browser couldn’t save the latest memory changes.");
  });
}

function renderMemories() {
  byId("memory-enabled").checked = memoryEnabled;
  byId("memory-summary").textContent = memoryEnabled
    ? memories.size + " saved notes can carry across chats on this device."
    : "Memory is off. Saved notes aren’t used or updated.";
  const items = [...memories.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(memory => {
    const item = document.createElement("li");
    const text = document.createElement("p");
    text.textContent = memory.text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove saved note";
    remove.addEventListener("click", () => saveMemoryChanges([
      { key: memory.key, deleted: true, updatedAt: Date.now() },
    ]));
    item.append(text, remove);
    return item;
  });
  byId("memory-list").replaceChildren(...items);
}

function rememberUser(thread, message) {
  const removal = forgetRequest(message.text);
  if (removal) {
    const existed = memories.has(removal.key);
    saveMemoryChanges([{ key: removal.key, deleted: true, updatedAt: message.createdAt }]);
    return existed ? "I removed the saved note about your " + removal.subject + "." : "I don’t have that saved.";
  }
  if (memoryEnabled) saveMemoryChanges(memoryChanges(message.text, {
    chatId: thread.id, messageId: message.id, at: message.createdAt,
  }));
}

function rememberSelection() {
  try { localStorage.setItem(ACTIVE_KEY, current.id); } catch {}
}

function renderHistory() {
  const ordered = sortedChats(chats.values());
  for (const id of ["chat-list", "mobile-chat-list"]) {
    const items = ordered.map(thread => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const title = document.createElement("strong");
      title.textContent = chatTitle(thread);
      const time = document.createElement("time");
      time.dateTime = new Date(thread.updatedAt).toISOString();
      time.textContent = dateFormat.format(thread.updatedAt);
      button.append(title, time);
      button.title = title.textContent;
      if (thread.id === current.id) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => selectChat(thread));
      item.append(button);
      return item;
    });
    byId(id).replaceChildren(...items);
  }
  for (const node of document.querySelectorAll(".history-empty")) node.hidden = !!ordered.length;
}

function update() {
  send.disabled = !ready || !storageReady || !!active || !prompt.value.trim();
  send.hidden = !!active;
  stop.hidden = !active;
  byId("app-update").disabled = !!active || connecting;
  downloadModel.disabled = !!active;
  byId("use-lite").disabled = !!active;
  byId("settings-open").disabled = !!active || connecting;
  chat.hidden = !list.childElementCount;
  byId("welcome").hidden = !chat.hidden;
  prompt.style.height = "44px";
  prompt.style.height = Math.min(130, Math.max(44, prompt.scrollHeight)) + "px";
}

function addMessage(message) {
  const { role, text, status } = message;
  const row = document.createElement("article");
  row.className = "message " + role;
  if (role === "assistant") {
    const avatar = document.createElement("img");
    avatar.src = "./icons/jex-64.png";
    avatar.alt = "";
    avatar.width = avatar.height = 28;
    row.append(avatar);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const label = document.createElement("h2");
  label.textContent = role === "assistant" ? "Jex Bot" : "You";
  const body = document.createElement("p");
  body.textContent = text || (status === "pending" ? "Thinking…" :
    status === "error" ? "Generation failed. You can send another message." : "Reply interrupted.");
  if (status === "pending") row.dataset.pending = "";
  bubble.append(label, body);
  row.append(bubble);
  list.append(row);
  return { row, body };
}

function scrollToLatest() {
  if (document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 220) {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }
}

function selectChat(thread) {
  if (thread.id === current.id) {
    if (historyDialog.open) historyDialog.close();
    return;
  }
  stopGeneration();
  current = thread;
  rememberSelection();
  list.replaceChildren();
  for (const message of current.messages) addMessage(message);
  prompt.value = "";
  if (historyDialog.open) historyDialog.close();
  renderHistory();
  update();
  window.scrollTo(0, document.documentElement.scrollHeight);
}

function state(value, label) {
  byId("connection").dataset.state = value;
  byId("connection-label").textContent = label;
  const selected = MODELS[preferredModel];
  downloadModel.hidden = value === "loading" || (ready && mode !== "lite");
  downloadModel.textContent = savedModels.has(preferredModel)
    ? (value === "error" ? "Retry " : "Start ") + selected.label
    : "Get " + selected.label + " (" + Math.round(selected.bytes / 1_000_000) + " MB)";
  byId("use-lite").hidden = value === "loading" || (ready && mode === "lite");
  update();
}

function finish(error, canceled) {
  if (!active) return;
  const { thread, message } = active;
  message.text = message.text.trim();
  error ||= !canceled && !message.text;
  message.status = error ? "error" : canceled ? "stopped" : "complete";
  persist(thread);
  if (current.id === thread.id) {
    list.replaceChildren();
    for (const item of current.messages) addMessage(item);
    byId("announcement").textContent = "Jex Bot: " + (message.text ||
      (error ? "Generation failed." : "Reply interrupted."));
  }
  active = null;
  update();
  scrollToLatest();
}

function addReplyText(text) {
  active.message.text += text;
  if (current.id === active.thread.id) {
    const row = list.lastElementChild;
    delete row.dataset.pending;
    row.querySelector("p").textContent = active.message.text;
    scrollToLatest();
  }
  if (performance.now() - active.savedAt > 500) {
    persist(active.thread);
    active.savedAt = performance.now();
  }
}

function stopGeneration() {
  if (!active) return;
  active.controller.abort();
  worker?.postMessage({ type: "stop" });
}

function modelReady(name) {
  ready = true;
  byId("model-name").textContent = name;
  byId("welcome-model").textContent = name.toUpperCase();
  try { localStorage.setItem("jex-model-mode", mode); } catch {}
  state("ready", mode === "lite" ? "Lite model · running on this device" : "Running on this device");
}

function startLite() {
  const connection = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  worker = connection;
  const unavailable = () => {
    if (worker !== connection) return;
    connecting = false;
    ready = false;
    finish(true, false);
    state("error", "Lite model unavailable");
  };
  connection.addEventListener("error", unavailable);
  connection.addEventListener("message", ({ data }) => {
    if (worker !== connection) return;
    if (data.type === "ready") {
      connecting = false;
      modelReady(data.name);
    } else if (data.type === "unavailable") {
      unavailable();
    } else if (active && data.id === active.id) {
      if (data.type === "delta" && !active.controller.signal.aborted) addReplyText(data.text);
      if (data.type === "done" || data.type === "error") {
        finish(data.type === "error", data.canceled || active.controller.signal.aborted);
      }
    }
  });
}

async function connect(nextMode, allowDownload = false) {
  if (active || connecting) return;
  if (ready && mode === nextMode) return;
  connecting = true;
  ready = false;
  mode = nextMode;
  if (mode !== "lite") preferredModel = mode;
  state("loading", "Loading Jex…");
  try {
    worker?.terminate();
    worker = undefined;
    await localModel?.close();
    localModel = undefined;
    if (mode === "lite") {
      startLite();
      return;
    }
    let percent = -1;
    const selected = MODELS[mode];
    localModel = await loadLocalModel({
      modelId: mode,
      allowDownload,
      onStatus() {
        savedModels.add(mode);
        state("loading", "Starting saved " + selected.label + "…");
      },
      onProgress({ loaded }) {
        const next = Math.min(100, Math.floor(loaded / selected.bytes * 100));
        if (next === percent || !Number.isFinite(next)) return;
        percent = next;
        state("loading", next === 100 ? "Starting " + selected.label + "…" : "Downloading " + selected.label + " · " + next + "%");
      },
    });
    connecting = false;
    if (localModel) modelReady(localModel.name);
    else state("setup", "Download " + selected.label + " to start");
  } catch (error) {
    console.warn("Couldn’t start Jex model", error);
    connecting = false;
    const detail = error.stage === "startup"
      ? "The model is saved but couldn’t start. Retry or choose a smaller model."
      : "Couldn’t prepare the model. Retry or use Lite.";
    state("error", mode === "lite" ? "Lite model unavailable" : detail);
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const user = prompt.value.trim();
  if (!user || active || !ready || !storageReady) return;
  const context = contextMessages(current.messages);
  const message = { role: "assistant", text: "", status: "pending" };
  current.updatedAt = Math.max(Date.now(), current.updatedAt + 1);
  const userMessage = { role: "user", text: user, id: crypto.randomUUID(), createdAt: current.updatedAt };
  current.messages.push(userMessage, message);
  chats.set(current.id, current);
  active = {
    id: crypto.randomUUID(), thread: current, message, savedAt: performance.now(), controller: new AbortController(),
  };
  persist(current);
  const memoryAcknowledgment = rememberUser(current, userMessage);
  rememberSelection();
  addMessage({ role: "user", text: user });
  addMessage(message);
  renderHistory();
  prompt.value = "";
  update();
  window.scrollTo(0, document.documentElement.scrollHeight);
  const messages = [...context, { role: "user", text: user }];
  const notes = memoryEnabled ? [...memories.values()] : [];
  const history = current.messages.slice(0, -2);
  const localReply = arithmeticReply(messages) ?? conversationRecall(user, history) ??
    memoryAcknowledgment ?? memoryOverview(user, notes) ?? explicitFactReply(user, history, notes);
  if (!localModel && localReply !== undefined) {
    addReplyText(localReply);
    finish(false, false);
  } else if (localModel) {
    const signal = active.controller.signal;
    localModel.reply(messages, signal, addReplyText, notes, localReply).then(
      () => finish(false, signal.aborted),
      error => {
        if (!signal.aborted) console.warn("Jex generation failed", error);
        finish(!signal.aborted, signal.aborted);
      },
    );
  } else {
    worker.postMessage({ type: "chat", id: active.id, messages });
  }
});
prompt.addEventListener("input", update);
prompt.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
stop.addEventListener("click", stopGeneration);
downloadModel.addEventListener("click", () => connect(preferredModel, true));
byId("use-lite").addEventListener("click", () => connect("lite"));
byId("settings-open").addEventListener("click", () => {
  renderMemories();
  settingsDialog.showModal();
});
byId("settings-close").addEventListener("click", () => settingsDialog.close());
for (const button of document.querySelectorAll("[data-model]")) {
  button.addEventListener("click", () => {
    settingsDialog.close();
    connect(button.dataset.model);
  });
}
byId("memory-enabled").addEventListener("change", event => {
  memoryEnabled = event.target.checked;
  try { localStorage.setItem("jex-memory-enabled", String(memoryEnabled)); } catch {}
  renderMemories();
});
function newChat() {
  selectChat(createChat());
  prompt.focus();
}
byId("new-chat").addEventListener("click", newChat);
byId("history-new-chat").addEventListener("click", newChat);
byId("history-toggle").addEventListener("click", () => historyDialog.showModal());
byId("history-close").addEventListener("click", () => historyDialog.close());
for (const button of document.querySelectorAll("[data-prompt]")) {
  button.addEventListener("click", () => {
    prompt.value = button.dataset.prompt;
    update();
    if (ready && storageReady) form.requestSubmit();
    else prompt.focus();
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden && active) persist(active.thread);
});

install.hidden = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener("appinstalled", () => { install.hidden = true; });
install.addEventListener("click", async () => {
  if (installPrompt) {
    await installPrompt.prompt();
    installPrompt = null;
  } else {
    byId("install-dialog").showModal();
  }
});

async function loadHistory() {
  try {
    database = await openChatDatabase();
    try { await migrateLegacy(database, localStorage); } catch {
      saveWarning("An older chat couldn’t be imported. Its original copy has been kept.");
    }
    for (const thread of await readChats(database)) {
      for (const message of thread.messages) {
        if (message.status === "pending") message.status = "stopped";
      }
      chats.set(thread.id, thread);
    }
    for (const memory of await readMemories(database)) memories.set(memory.key, memory);
    let selected;
    try { selected = localStorage.getItem(ACTIVE_KEY); } catch {}
    current = chats.get(selected) || sortedChats(chats.values())[0] || current;
  } catch {
    saveWarning("Chat storage is unavailable. Conversations will last only while this tab stays open.");
    database = undefined;
  }
  for (const message of current.messages) addMessage(message);
  storageReady = true;
  renderMemories();
  renderHistory();
  update();
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (applyingUpdate) window.location.reload();
  });
  navigator.serviceWorker.register("./sw.js").then(registration => {
    function checkUpdate() {
      if (registration.waiting && navigator.serviceWorker.controller) {
        waitingUpdate = registration.waiting;
        byId("app-update").hidden = false;
      }
    }
    checkUpdate();
    registration.addEventListener("updatefound", () => {
      registration.installing?.addEventListener("statechange", checkUpdate);
    });
  }).catch(() => {});
}
byId("app-update").addEventListener("click", async () => {
  if (!waitingUpdate || active || connecting) return;
  await saves;
  applyingUpdate = true;
  waitingUpdate.postMessage({ type: "SKIP_WAITING" });
});
loadHistory();
let previousMode;
try { previousMode = localStorage.getItem("jex-model-mode"); } catch {}
connect(previousMode === "lite" || MODELS[previousMode] ? previousMode : "local");
