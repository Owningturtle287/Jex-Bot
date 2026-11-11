import { memoriesFromChats, validMemory } from "./memory.mjs";

// IndexedDB stores each conversation separately so other tabs cannot overwrite the whole history.
export const LEGACY_KEY = "jex-pilot-chat-v1";
export const ACTIVE_KEY = "jex-active-chat-v2";

export function createChat(now = Date.now()) {
  return { id: crypto.randomUUID(), createdAt: now, updatedAt: now, messages: [], revision: 0 };
}

export function validMessages(messages) {
  return Array.isArray(messages) && messages.every((message, index) =>
    message?.role === (index % 2 ? "assistant" : "user") && typeof message.text === "string"
  );
}

export function sortedChats(chats) {
  return [...chats].filter(chat => chat.messages.length).sort((a, b) =>
    b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)
  );
}

export function contextMessages(messages) {
  const context = [];
  for (let index = 0; index + 1 < messages.length; index += 2) {
    const user = messages[index], assistant = messages[index + 1];
    if (user.role === "user" && assistant.role === "assistant" &&
        (!assistant.status || assistant.status === "complete") && assistant.text.trim()) {
      context.push({ role: "user", text: user.text }, { role: "assistant", text: assistant.text });
    }
  }
  return context;
}

export function chatTitle(chat) {
  const first = chat.messages.find(message => message.role === "user");
  return first ? first.text.replace(/\s+/g, " ").slice(0, 56) : "New chat";
}

export function openChatDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("jex-chat-history", 2);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (event.oldVersion === 0) db.createObjectStore("chats", { keyPath: "id" });
      const memories = db.createObjectStore("memories", { keyPath: "key" });
      const previous = request.transaction.objectStore("chats").getAll();
      previous.onsuccess = () => {
        for (const memory of memoriesFromChats(previous.result)) memories.put(memory);
      };
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

export function readChats(database) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("chats", "readonly");
    const request = transaction.objectStore("chats").getAll();
    transaction.oncomplete = () => resolve(request.result.filter(chat =>
      typeof chat.id === "string" && Number.isFinite(chat.updatedAt) &&
      Number.isFinite(chat.createdAt) && validMessages(chat.messages)
    ));
    transaction.onabort = () => reject(transaction.error);
  });
}

export function writeChat(database, chat) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("chats", "readwrite");
    const store = transaction.objectStore("chats");
    const request = store.get(chat.id);
    let revision;
    request.onsuccess = () => {
      const current = request.result?.revision || 0;
      if (current !== (chat.revision || 0)) {
        reject(new Error("conflict"));
        transaction.abort();
        return;
      }
      revision = current + 1;
      store.put({ ...chat, revision });
    };
    transaction.oncomplete = () => resolve(revision);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function migrateLegacy(database, storage) {
  const messages = JSON.parse(storage.getItem(LEGACY_KEY) || "[]");
  if (!messages.length || !validMessages(messages)) return;
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(["chats", "memories"], "readwrite");
    const store = transaction.objectStore("chats");
    const request = store.get("legacy-pilot-chat");
    request.onsuccess = () => {
      if (!request.result) {
        const now = Date.now();
        const chat = { id: "legacy-pilot-chat", createdAt: now, updatedAt: now, messages, revision: 1 };
        store.put(chat);
        const notes = transaction.objectStore("memories");
        for (const memory of memoriesFromChats([chat])) {
          const previous = notes.get(memory.key);
          previous.onsuccess = () => {
            if (!previous.result || previous.result.updatedAt <= memory.updatedAt) notes.put(memory);
          };
        }
      }
    };
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  storage.removeItem(LEGACY_KEY);
}


export function readMemories(database) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("memories", "readonly");
    const request = transaction.objectStore("memories").getAll();
    transaction.oncomplete = () => resolve(request.result.filter(validMemory));
    transaction.onabort = () => reject(transaction.error);
  });
}

export function writeMemories(database, changes) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("memories", "readwrite");
    const store = transaction.objectStore("memories");
    for (const change of changes) {
      const request = store.get(change.key);
      request.onsuccess = () => {
        if (!request.result || request.result.updatedAt <= change.updatedAt) store.put(change);
      };
    }
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
}
