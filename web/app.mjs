import {
  ACTIVE_KEY, chatTitle, contextMessages, createChat, migrateLegacy,
  openChatDatabase, readChats, sortedChats, writeChat,
} from "./chats.mjs";

const byId = id => document.getElementById(id);
const form = byId("composer-form");
const prompt = byId("prompt");
const chat = byId("chat");
const list = byId("messages");
const send = byId("send");
const stop = byId("stop");
const install = byId("install");
const historyDialog = byId("history-dialog");
const chats = new Map();
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
let current = createChat();
let database;
let saves = Promise.resolve();
let storageReady = false;
let active = null;
let worker;
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
  byId("app-update").disabled = !!active;
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
  if (active) worker.postMessage({ type: "stop" });
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
  byId("retry").hidden = value !== "error";
  update();
}

function finish(error, canceled) {
  if (!active) return;
  const { thread, message } = active;
  message.text = message.text.trim();
  message.status = error ? "error" : canceled ? "stopped" : "complete";
  persist(thread);
  if (current.id === thread.id) {
    list.replaceChildren();
    for (const item of current.messages) addMessage(item);
    byId("announcement").textContent = "Jex Bot: " + (message.text || "Reply interrupted.");
  }
  active = null;
  renderHistory();
  update();
  scrollToLatest();
}

function connect() {
  worker?.terminate();
  ready = false;
  state("loading", "Loading Jex…");
  try {
    const connection = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
    worker = connection;
    const unavailable = () => {
      if (worker !== connection) return;
      ready = false;
      finish(true, false);
      state("error", "Model unavailable");
    };
    connection.addEventListener("error", unavailable);
    connection.addEventListener("message", ({ data }) => {
      if (worker !== connection) return;
      if (data.type === "ready") {
        ready = true;
        byId("model-name").textContent = data.name;
        byId("welcome-model").textContent = data.name.toUpperCase();
        state("ready", "Running on this device");
      } else if (data.type === "unavailable") {
        unavailable();
      } else if (active && data.id === active.id) {
        if (data.type === "delta") {
          active.message.text += data.text;
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
        } else if (data.type === "done" || data.type === "error") {
          finish(data.type === "error", data.canceled);
        }
      }
    });
  } catch {
    state("error", "Model unavailable");
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
  active = { id: crypto.randomUUID(), thread: current, message, savedAt: performance.now() };
  persist(current);
  rememberSelection();
  addMessage({ role: "user", text: user });
  addMessage(message);
  renderHistory();
  prompt.value = "";
  update();
  window.scrollTo(0, document.documentElement.scrollHeight);
  worker.postMessage({ type: "chat", id: active.id, messages: [...context, { role: "user", text: user }] });
});
prompt.addEventListener("input", update);
prompt.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
stop.addEventListener("click", () => worker.postMessage({ type: "stop" }));
byId("retry").addEventListener("click", connect);
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
  if (!waitingUpdate || active) return;
  await saves;
  applyingUpdate = true;
  waitingUpdate.postMessage({ type: "SKIP_WAITING" });
});
loadHistory();
connect();
