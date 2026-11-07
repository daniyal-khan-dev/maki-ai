// Saved chats: kept in this browser (localStorage), so a refresh, a closed tab or a lost
// connection doesn't lose the conversation. Nothing is sent anywhere to be stored. Every read
// and write is guarded: in a private window or with storage blocked, chats simply aren't saved.

export interface SavedMessage {
  who: "you" | "maki";
  text: string;
  teacher?: string;
  aside?: boolean;
  cut?: boolean;
  plain?: boolean;
}

export interface SavedChat {
  id: string;
  title: string; // the first question
  updatedAt: number;
  messages: SavedMessage[];
}

const CHATS_KEY = "maki-ai:chats";
const CURRENT_KEY = "maki-ai:current-chat";
export const MAX_CHATS = 50;
export const MAX_MESSAGES = 300; // per chat; the oldest go first

const isMessage = (m: unknown): m is SavedMessage =>
  !!m && typeof m === "object" && ((m as SavedMessage).who === "you" || (m as SavedMessage).who === "maki") && typeof (m as SavedMessage).text === "string";

const isChat = (c: unknown): c is SavedChat =>
  !!c && typeof c === "object" && typeof (c as SavedChat).id === "string" && typeof (c as SavedChat).title === "string" &&
  typeof (c as SavedChat).updatedAt === "number" && Array.isArray((c as SavedChat).messages);

/** Saved chats, newest first. */
export function loadChats(): SavedChat[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(CHATS_KEY) || "[]");
    if (!Array.isArray(list)) return [];
    return list.filter(isChat).map((c) => ({ ...c, messages: c.messages.filter(isMessage) })).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveChats(chats: SavedChat[]) {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
  } catch {
    // Storage full: keep the newest chats only. Blocked: nothing to do, the chat stays on screen.
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, 10)));
    } catch {}
  }
}

/** The chat that was open last, reopened when the page loads. */
export function loadCurrentId(): string {
  try {
    return localStorage.getItem(CURRENT_KEY) || "";
  } catch {
    return "";
  }
}

export function saveCurrentId(id: string) {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {}
}

const VOICE_OFF_KEY = "maki-ai:voice-off";

/** "Mute" under Maki's answers: remembered, so Maki stays quiet until unmuted. */
export function loadVoiceOff(): boolean {
  try {
    return localStorage.getItem(VOICE_OFF_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveVoiceOff(off: boolean) {
  try {
    localStorage.setItem(VOICE_OFF_KEY, off ? "1" : "0");
  } catch {}
}

export const newChatId = (): string =>
  typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** A chat's name in the list: its first question, shortened. */
export function chatTitle(firstQuestion: string): string {
  const text = firstQuestion.replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text || "New chat";
}
