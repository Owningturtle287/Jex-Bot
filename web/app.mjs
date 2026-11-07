const byId = id => document.getElementById(id);
const form = byId("composer-form");
const prompt = byId("prompt");
const chat = byId("chat");
const list = byId("messages");
const send = byId("send");
const stop = byId("stop");
const install = byId("install");
const storageKey = "jex-pilot-chat-v1";
let history = [];
let active = null;
let worker;
let ready = false;
let installPrompt;

try {
  const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (Array.isArray(stored) && stored.length % 2 === 0 && stored.every((turn, index) =>
    turn?.role === (index % 2 ? "assistant" : "user") && typeof turn.text === "string"
  )) history = stored.slice(-60);
} catch {
  // Chat remains usable when storage is disabled.
}

function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(history.slice(-60))); } catch {}
}

function update() {
  send.disabled = !ready || !!active || !prompt.value.trim();
  send.hidden = !!active;
  stop.hidden = !active;
  chat.hidden = !list.childElementCount;
  byId("welcome").hidden = !chat.hidden;
  prompt.style.height = "44px";
  prompt.style.height = Math.min(130, Math.max(44, prompt.scrollHeight)) + "px";
}

function addMessage(role, text) {
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
  body.textContent = text;
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

function state(value, label) {
  byId("connection").dataset.state = value;
  byId("connection-label").textContent = label;
  byId("retry").hidden = value !== "error";
  update();
}

function finish(error, canceled) {
  if (!active) return;
  const { user, reply, body, row } = active;
  delete row.dataset.pending;
  body.textContent = reply.trim() || (error ? "Generation failed. You can send another message." :
    canceled ? "Reply stopped." : "Jex didn’t produce a reply. Try a short, specific question.");
  if (!error && reply.trim()) {
    history.push({ role: "user", text: user }, { role: "assistant", text: reply.trim() });
    history = history.slice(-60);
    save();
  }
  byId("announcement").textContent = "Jex Bot: " + body.textContent;
  active = null;
  update();
  scrollToLatest();
}

function connect() {
  worker?.terminate();
  ready = false;
  state("loading", "Loading Jex Pilot…");
  const unavailable = () => {
    ready = false;
    finish(true, false);
    state("error", "Model unavailable");
  };
  try {
    worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
    worker.addEventListener("error", unavailable);
    worker.addEventListener("message", ({ data }) => {
      if (data.type === "ready") {
        ready = true;
        state("ready", "Running on this device");
      } else if (data.type === "unavailable") {
        unavailable();
      } else if (data.type === "delta" && active) {
        active.reply += data.text;
        delete active.row.dataset.pending;
        active.body.textContent = active.reply;
        scrollToLatest();
      } else if (data.type === "done" || data.type === "error") {
        finish(data.type === "error", data.canceled);
      }
    });
  } catch {
    unavailable();
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const user = prompt.value.trim();
  if (!user || active || !ready) return;
  addMessage("user", user);
  active = { ...addMessage("assistant", "Thinking…"), user, reply: "" };
  active.row.dataset.pending = "";
  prompt.value = "";
  update();
  window.scrollTo(0, document.documentElement.scrollHeight);
  worker.postMessage({
    type: "chat",
    messages: [...history.slice(-10), { role: "user", text: user }],
  });
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
byId("new-chat").addEventListener("click", () => {
  const interrupted = !!active;
  active = null;
  history = [];
  save();
  list.replaceChildren();
  prompt.value = "";
  if (interrupted) connect();
  update();
  prompt.focus();
});
for (const button of document.querySelectorAll("[data-prompt]")) {
  button.addEventListener("click", () => {
    prompt.value = button.dataset.prompt;
    update();
    if (ready) form.requestSubmit();
    else prompt.focus();
  });
}

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

for (const turn of history) addMessage(turn.role, turn.text);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
connect();
