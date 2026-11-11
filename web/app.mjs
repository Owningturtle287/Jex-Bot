import {
  ACTIVE_KEY, chatTitle, contextMessages, createChat, migrateLegacy,
  openChatDatabase, readChats, sortedChats, writeChat,
} from "./chats.mjs";
import { arithmeticReply } from "./calculator.mjs";
import { explicitFactReply } from "./facts.mjs";
import { loadLocalModel } from "./local-model.mjs";
import { MODEL_BYTES, MODEL_DOWNLOAD_MB } from "./model-settings.mjs";

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
const chats = new Map();
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
let current = createChat();
let database;
let saves = Promise.resolve();
let storageReady = false;
let active = null;
let worker;
let localModel;
let savedModel = false;
let mode;
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
  downloadModel.hidden = value === "loading" || (ready && mode === "local");
  downloadModel.textContent = savedModel
    ? (value === "error" ? "Retry Jex v3" : "Start Jex v3")
    : "Get Jex v3 (" + MODEL_DOWNLOAD_MB + " MB)";
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
  state("ready", mode === "local" ? "Running on this device" : "Lite model · running on this device");
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
  connecting = true;
  ready = false;
  mode = nextMode;
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
    localModel = await loadLocalModel({
      allowDownload,
      onStatus() {
        savedModel = true;
        state("loading", "Starting saved Jex v3…");
      },
      onProgress({ loaded }) {
        const next = Math.min(100, Math.floor(loaded / MODEL_BYTES * 100));
        if (next === percent || !Number.isFinite(next)) return;
        percent = next;
        state("loading", next === 100 ? "Starting Jex v3…" : "Downloading Jex v3 · " + next + "%");
      },
    });
    connecting = false;
    if (localModel) modelReady(localModel.name);
    else state("setup", "Choose a model to start");
  } catch (error) {
    console.warn("Couldn’t start Jex model", error);
    connecting = false;
    const detail = error.stage === "startup"
      ? "Jex v3 is saved but couldn’t start. Retry or use Lite."
      : "Couldn’t prepare Jex v3. Retry or use Lite.";
    state("error", mode === "lite" ? "Lite model unavailable" : detail);
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const user = prompt.value.trim();
  if (!user || active || !ready || !storageReady) return;
  const context = contextMessages(current.messages);
  const message = { role: "assistant", text: "", status: "pending" };
  current.messages.push({ role: "user", text: user }, message);
  current.updatedAt = Math.max(Date.now(), current.updatedAt + 1);
  chats.set(current.id, current);
  active = {
    id: crypto.randomUUID(), thread: current, message, savedAt: performance.now(), controller: new AbortController(),
  };
  persist(current);
  rememberSelection();
  addMessage({ role: "user", text: user });
  addMessage(message);
  renderHistory();
  prompt.value = "";
  update();
  window.scrollTo(0, document.documentElement.scrollHeight);
  const messages = [...context, { role: "user", text: user }];
  const localReply = arithmeticReply(messages) ?? explicitFactReply(user, current.messages.slice(0, -2));
  if (localReply !== undefined) {
    addReplyText(localReply);
    finish(false, false);
  } else if (localModel) {
    const signal = active.controller.signal;
    localModel.reply(messages, signal, addReplyText).then(
      () => finish(false, signal.aborted),
      () => finish(!signal.aborted, signal.aborted),
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
downloadModel.textContent = "Get Jex v3 (" + MODEL_DOWNLOAD_MB + " MB)";
downloadModel.addEventListener("click", () => connect("local", true));
byId("use-lite").addEventListener("click", () => connect("lite"));
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
    let selected;
    try { selected = localStorage.getItem(ACTIVE_KEY); } catch {}
    current = chats.get(selected) || sortedChats(chats.values())[0] || current;
  } catch {
    saveWarning("Chat storage is unavailable. Conversations will last only while this tab stays open.");
    database = undefined;
  }
  for (const message of current.messages) addMessage(message);
  storageReady = true;
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
connect(previousMode === "lite" ? "lite" : "local");
