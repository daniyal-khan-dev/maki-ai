// Browser side of the demo: streams the microphone to the server, plays Maki's voice without
// gaps, keeps the conversation for the page, and handles interruptions the way a person would:
//  - as soon as the student's voice is heard (0.2 s), Maki's voice dips;
//  - real words stop Maki with a short fade; "okay" / "mm-hmm" / "haan" let Maki carry on;
//  - a cough or noise with no words: the voice comes back after about a second;
//  - the server is told exactly what the student heard, so Maki doesn't repeat itself.
// Typed questions go over the same connection, with or without a call, and Maki says those answers
// too (unless muted); each answer can be replayed. The connection stays open between calls, so
// Maki remembers the whole conversation.
// Each chat is saved in the browser (chatStore.ts); opening one gives the server its history, so
// Maki carries on where it left off (also after a refresh or a lost connection).
// The page (App.tsx) shows `getView()` and re-renders when `subscribe` tells it something changed.

import micWorkletUrl from "./mic-worklet.ts?worker&url";
import { loadChats, saveChats, loadCurrentId, saveCurrentId, loadVoiceOff, saveVoiceOff, newChatId, chatTitle, MAX_CHATS, MAX_MESSAGES, type SavedChat, type SavedMessage } from "./chatStore";

export type SessionState = "idle" | "connecting" | "listening" | "thinking" | "speaking";

/** One message in the conversation. Maki's text keeps its {{written|spoken}} formulas. */
export interface Message {
  id: number;
  who: "you" | "maki";
  text: string;
  live: boolean; // the student is still saying it
  aside: boolean; // "okay" while Maki talked: Maki kept going
  cut: boolean; // the student cut Maki off here
  plain: boolean; // show the text as it is (no formulas)
  teacher: string; // the teacher who answered (Maki's messages)
}

/** What the page shows. */
export interface View {
  state: SessionState;
  error: string;
  muted: boolean;
  ducked: boolean;
  teacher: string;
  teacherPicks: number; // goes up each time a teacher is picked (replays the chip's animation)
  firstWord: string;
  firstSound: string;
  roundTrip: string;
  messages: Message[];
  showEmpty: boolean;
  scrollTick: number; // goes up whenever the newest message should be scrolled into view
  awaiting: boolean; // a question was asked and Maki's first word hasn't arrived yet
  awaitingTeacher: string; // the teacher working on it, once the decision maker has picked one
  chatId: string; // the open chat
  chatTitle: string; // its name ("New chat" until the first question is saved)
  chats: ChatSummary[]; // saved chats, newest first
  streamingId: number; // Maki's message still being written (0: none)
  voiceOff: boolean; // "Mute": answers are shown, not spoken
  speakingAloud: boolean; // Maki's voice is playing (an answer, or a replay)
  playingId: number; // the message whose voice is playing (0: none)
  replayLoading: boolean; // Replay pressed, its voice still on the way
}

/** A saved chat in the list. */
export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
}

/** One turn of a chat, as the server keeps it. */
interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// Events that belong to the chat being left: ignored until the server confirms the switch.
const OLD_CHAT_EVENTS = new Set(["hearing", "user", "user-tail", "assistant-start", "assistant-delta", "assistant-end", "agent", "phrase", "metrics"]);
const SYNC_TURNS = 40; // the most recent turns of a chat given to the server (it uses the last 12)
const KEPT_VOICES = 10; // answers whose voice is kept in memory for an instant Replay

/** Chosen on the page before a conversation starts. */
export interface Settings {
  lang: string;
  voice: string;
  book: string;
}

/** An event from the server. */
interface ServerEvent {
  type: string;
  text: string;
  teacher: string;
  message: string;
  restarted?: boolean;
  aiFirstWordMs?: number;
  firstAudioMs?: number;
}

const VOICE_RATE = 24000;
// Mic level (0–1, after the browser's echo cancellation) that counts as the student talking,
// and how many 40 ms frames in a row before Maki reacts (5 = 0.2 s, Vapi's default).
const VOICE_LEVEL = 0.12;
// While Maki is talking, some of its voice can reach the mic; the student must be clearly louder.
const VOICE_LEVEL_OVER_MAKI = 0.2;
const VOICE_FRAMES = 5;
// Words only stop Maki if the mic heard the student this recently. Late words of the question
// just asked arrive while the mic is quiet, and must not stop the answer before it starts.
const MIC_RECENT_MS = 700;
const DUCK_VOLUME = 0.25; // how quiet Maki goes while checking whether the student is really talking
const BACKOFF_MS = 1200; // no words by then: it was noise, Maki's voice comes back
const FADE_MS = 150;
// A short breath between Maki's phrases. The server trims each phrase's leading silence, so
// this plus the phrase's own trailing silence gives an even, natural pause (about 0.15-0.35 s).
const PHRASE_PAUSE_S = 0.12;

// Agreement sounds that are not interruptions (same list as the server).
const BACKCHANNEL_WORDS = new Set([
  "ok", "okay", "k", "yeah", "yes", "yep", "yup", "right", "sure", "alright", "cool", "nice", "true",
  "mhm", "mm", "mmm", "hmm", "hm", "uh", "huh", "uhhuh", "mmhmm", "i", "see", "got", "it",
  "haan", "han", "ha", "ji", "jee", "acha", "achha", "accha", "acchha", "theek", "thik", "hai",
  "ہاں", "اچھا", "جی", "ٹھیک", "ہے", "हाँ", "हां", "अच्छा", "जी", "ठीक", "है",
]);

export class VoiceSession {
  /** "Let me interrupt Maki" on the page. */
  barge = true;
  /** The mic level for the talk button's ring ("0" to "1"). */
  onLevel: (level: string) => void = () => {};

  private state: SessionState = "idle"; // the voice call ("idle": no call; typing still works)
  private ws: WebSocket | null = null;
  private wsOpen: Promise<WebSocket> | null = null;
  private awaiting = false;
  private micStream: MediaStream | null = null;
  private micCtx: AudioContext | null = null;
  private playCtx: AudioContext | null = null;
  private voiceGain: GainNode | null = null; // Maki's volume: dips and fades go through here
  private nextPlayTime = 0;
  private readonly playing = new Set<AudioBufferSourceNode>();
  private phrases: { text: string; start: number }[] = []; // each phrase of the current answer, in audio-clock time
  private pendingPhrase: string | null = null; // words of the phrase whose audio comes next
  private muted = false;
  private replyFinished = true; // the server has sent all of the current answer
  private liveBubble: Message | null = null; // what the student is saying right now
  private makiBubble: Message | null = null;
  private turnEndedAt = 0;
  private heardAudio = false;
  private voiceFrames = 0;
  private lastVoiceAt = 0; // when the mic last heard the student
  private ducked = false;
  private duckTimer = 0;
  private fading = false; // a fade-out after an interruption is running
  private toldServerSpeaking = false;

  // What the page shows.
  private messages: Message[] = [];
  private nextId = 1;
  private error = "";
  private teacher = "";
  private teacherPicks = 0;
  private firstWord = "–";
  private firstSound = "–";
  private roundTrip = "–";
  private showEmpty = true;
  private scrollTick = 0;

  // Saved chats.
  private chats: SavedChat[] = loadChats();
  private chatId = "";
  private lastSaved = ""; // the open chat as last saved, to save only when it changes
  private saveTimer = 0;
  private syncing = false; // switched chats: the server hasn't confirmed yet
  private syncTimer = 0;
  private openingTurns: ChatTurn[] = []; // the chat's history, given to the server when the connection opens

  // Maki's voice for typed answers, Replay and Mute.
  private voiceOff = loadVoiceOff();
  private voiceMessageId = 0; // the answer whose voice is playing now
  private replayId = 0; // the answer being replayed
  private replayLoading = false;
  private readonly replayNodes = new Set<AudioBufferSourceNode>(); // the replay's pieces, playing or scheduled
  private replayAt = 0; // audio-clock time where the replay's next piece goes
  private readonly streamedVoice = new Map<number, Int16Array[]>(); // each answer's voice as it arrived
  private readonly replayVoice = new Map<number, AudioBuffer>(); // ready to replay

  private view: View = this.snapshot();
  private readonly listeners = new Set<() => void>();

  constructor() {
    // Reopen the chat that was open last.
    const last = this.chats.find((c) => c.id === loadCurrentId());
    if (last) this.showChat(last);
    else this.chatId = newChatId();
    this.view = this.snapshot();
    // Closing or reloading the page: save what hasn't been saved yet.
    window.addEventListener("pagehide", () => this.saveNow());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getView = (): View => this.view;

  private snapshot(): View {
    return {
      state: this.state, error: this.error, muted: this.muted, ducked: this.ducked,
      teacher: this.teacher, teacherPicks: this.teacherPicks,
      firstWord: this.firstWord, firstSound: this.firstSound, roundTrip: this.roundTrip,
      messages: this.messages.map((m) => ({ ...m })), showEmpty: this.showEmpty, scrollTick: this.scrollTick,
      awaiting: this.awaiting, awaitingTeacher: this.awaiting ? this.makiBubble?.teacher || "" : "",
      chatId: this.chatId,
      chatTitle: this.chats.find((c) => c.id === this.chatId)?.title || "New chat",
      chats: this.chats.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length })),
      streamingId: this.makiBubble?.id || 0,
      voiceOff: this.voiceOff,
      speakingAloud: this.playing.size > 0 || (this.replayId !== 0 && !this.replayLoading),
      playingId: this.replayId || (this.playing.size ? this.voiceMessageId : 0),
      replayLoading: this.replayLoading,
    };
  }

  private emit() {
    this.view = this.snapshot();
    for (const listener of this.listeners) listener();
    this.saveSoon();
  }

  /** Show which teacher the decision maker picked (or none). */
  private showTeacher(name: string) {
    this.teacher = name;
    this.teacherPicks++;
    this.emit();
  }

  private setState(next: SessionState) {
    this.state = next;
    // The server needs to know when Maki is audible, to tell "okay" while listening from a new question.
    const speaking = next === "speaking";
    if (speaking !== this.toldServerSpeaking && this.ws?.readyState === WebSocket.OPEN) {
      this.toldServerSpeaking = speaking;
      this.ws.send(JSON.stringify({ type: "playback", speaking }));
    }
    if (!speaking) this.unduck(false);
    this.emit();
  }

  showError(message: string) {
    this.error = message || "";
    this.emit();
  }

  // ── Start / stop ─────────────────────────────────────────────────────────
  async start(settings: Settings) {
    this.showError("");
    this.setState("connecting");
    this.ensurePlayback(); // inside the click, so the browser lets it play sound
    this.stopReplay();
    if (this.playing.size) this.fadeOutAndStop(); // a typed answer still being read out
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.micCtx = new AudioContext();
      await this.micCtx.audioWorklet.addModule(micWorkletUrl);
      const source = this.micCtx.createMediaStreamSource(this.micStream);
      const capture = new AudioWorkletNode(this.micCtx, "mic-capture", { processorOptions: { targetRate: 16000, frameMs: 40 } });
      const silent = this.micCtx.createGain();
      silent.gain.value = 0; // the graph must reach the speakers to run, but we don't want to hear ourselves
      source.connect(capture).connect(silent).connect(this.micCtx.destination);
      capture.port.onmessage = ({ data }: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => this.onMicFrame(data);
    } catch (error) {
      const e = error as { name?: string; message?: string } | undefined;
      this.stop();
      this.showError(e?.name === "NotAllowedError"
        ? "The microphone is blocked. Allow it for this page (the icon in the address bar) and press Start again."
        : `The microphone could not start: ${e?.message || error}`);
      return;
    }

    try {
      const ws = await this.connect(settings, this.turnsForServer());
      if (this.state !== "connecting") return; // ended while connecting
      this.toldServerSpeaking = false;
      ws.send(JSON.stringify({ type: "listen", on: true, ...settings })); // the server answers "ready"
    } catch {
      this.stop();
      this.showError("Could not reach Maki. Check your internet connection and try again.");
    }
  }

  /**
   * The connection to the server: opened on first use (Start talking or a typed question) and kept
   * between calls, so Maki remembers the whole conversation, spoken and typed. `turns` is the open
   * chat's history so far, given to the server first, so a reopened chat (or a reconnection after a
   * lost connection) carries on where it left off.
   */
  private connect(settings: Settings, turns: ChatTurn[]): Promise<WebSocket> {
    if (this.ws && this.wsOpen && this.ws.readyState <= WebSocket.OPEN) return this.wsOpen;
    const params = new URLSearchParams({ lang: settings.lang, voice: settings.voice, book: settings.book, listen: "0", speak: this.voiceOff ? "0" : "1" });
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${params}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.openingTurns = turns;
    ws.onmessage = (event) => (typeof event.data === "string" ? this.onEvent(JSON.parse(event.data)) : this.onAudio(event.data));
    const open = new Promise<WebSocket>((resolve, reject) => {
      ws.onopen = () => {
        if (this.openingTurns.length) ws.send(JSON.stringify({ type: "history", turns: this.openingTurns }));
        resolve(ws);
      };
      ws.onerror = () => reject(new Error("Could not reach the server."));
    });
    open.catch(() => {}); // the caller handles it
    this.wsOpen = open;
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsOpen = null;
      const busy = this.state !== "idle" || this.awaiting;
      if (this.state !== "idle") this.stop();
      this.dropWaitingBubble();
      if (busy) this.showError("The connection to Maki was lost. Check your internet connection and try again.");
      else this.emit();
    };
    return open;
  }

  /**
   * A typed question. Maki shows the answer and says it (unless muted); the microphone isn't
   * needed. In a call, typing over Maki stops it, like talking over it.
   */
  async sendText(raw: string, settings: Settings) {
    const text = raw.trim();
    if (!text) return;
    this.showError("");
    this.ensurePlayback(); // inside the key press or click, so the browser lets it play sound
    this.stopReplay();
    if (this.state === "speaking" || this.state === "thinking") this.interrupt(`typed: ${text}`);
    else if (this.playing.size) this.fadeOutAndStop(); // the last answer still being read out
    const before = this.turnsForServer(); // the history up to this question (the question itself goes as "text")
    this.addMessage("you", text);
    this.beginTurn();
    try {
      const ws = await this.connect(settings, before);
      ws.send(JSON.stringify({ type: "text", text, book: settings.book, voice: settings.voice }));
    } catch {
      this.dropWaitingBubble();
      if (this.state === "thinking") this.setState("listening");
      this.showError("Could not reach Maki. Check your internet connection and try again.");
    }
  }

  /** Ends the call. The connection stays open, so typing carries on the same conversation. */
  stop() {
    if (this.state === "speaking" || this.state === "thinking") this.interrupt(); // tells the server what was heard
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "listen", on: false }));
    this.stopPlayback();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.micCtx?.close().catch(() => {});
    this.micCtx = null;
    this.muted = false;
    this.onLevel("0");
    this.finishLiveBubble();
    this.setState("idle");
  }

  toggleMute() {
    this.muted = !this.muted;
    this.emit();
  }

  // ── Maki's voice: Mute and Replay ────────────────────────────────────────
  /** Maki's speaker: made on the first click or key press (browsers only allow sound after one), then kept. */
  private ensurePlayback() {
    if (!this.playCtx || this.playCtx.state === "closed") {
      this.playCtx = new AudioContext({ sampleRate: VOICE_RATE });
      this.voiceGain = this.playCtx.createGain();
      this.voiceGain.connect(this.playCtx.destination);
    }
    this.playCtx.resume().catch(() => {});
  }

  /** Mute: Maki's answers are shown but not spoken, until unmuted (remembered). Stops what's playing now. */
  toggleVoice() {
    this.voiceOff = !this.voiceOff;
    saveVoiceOff(this.voiceOff);
    if (this.voiceOff) {
      this.stopReplay();
      if (this.playing.size) this.fadeOutAndStop();
      // In a call: if the whole answer has arrived, Maki is done; otherwise the end of the answer says so.
      if (this.state === "speaking" && this.replyFinished) this.setState("listening");
    } else {
      this.ensurePlayback();
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "speak", on: !this.voiceOff }));
    this.emit();
  }

  /** Replay: say a finished answer again. Pressing it again (or another Replay) stops it. Not during a call. */
  async replay(id: number, voice: string) {
    if (this.replayId === id) return this.stopReplay();
    const message = this.messages.find((m) => m.id === id && m.who === "maki" && m.text.trim());
    if (!message || this.state !== "idle") return;
    this.ensurePlayback();
    this.stopReplay();
    if (this.playing.size) this.fadeOutAndStop(); // the latest answer still being read out
    this.showError("");
    this.replayId = id;
    this.replayLoading = true;
    this.emit();
    try {
      // Kept from when it was spoken: instant. Otherwise (a reopened chat, an answer given while
      // muted or cut short) the server makes it again, and it plays as it arrives.
      const kept = this.keptVoice(message);
      if (kept) {
        this.replayLoading = false;
        this.playReplayPiece(id, kept, () => true);
        this.emit();
      } else {
        await this.streamReplay(id, message, voice);
      }
    } catch (error) {
      if (this.replayId !== id) return;
      this.stopReplay();
      this.showError((error as Error).message || "That answer couldn't be played. Try again in a moment.");
    }
  }

  private stopReplay() {
    if (!this.replayId) return;
    this.replayId = 0;
    this.replayLoading = false;
    for (const node of this.replayNodes) {
      try { node.stop(); } catch {}
    }
    this.replayNodes.clear();
    this.replayAt = 0;
    this.emit();
  }

  private finishReplay() {
    this.replayId = 0;
    this.replayLoading = false;
    this.replayAt = 0;
    this.emit();
  }

  /** An answer's voice kept in memory from when it was spoken (not for one cut short). */
  private keptVoice(message: Message): AudioBuffer | null {
    const ready = this.replayVoice.get(message.id);
    if (ready) return ready;
    const streamed = message.cut ? undefined : this.streamedVoice.get(message.id);
    if (!streamed?.length) return null;
    return keepLatest(this.replayVoice, message.id, pcmBuffer(this.playCtx!, streamed), KEPT_VOICES);
  }

  /** The server makes the answer's voice again: each piece plays as it arrives, and the whole is kept. */
  private async streamReplay(id: number, message: Message, voice: string) {
    const res = await fetch("speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message.text.replace(/\s*—\s*$/, ""), voice }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.message || "That answer couldn't be played. Try again in a moment.");
    const reader = res.body.getReader();
    const kept: Int16Array[] = [];
    let carry: number | null = null; // an odd byte held back so every piece is whole 16-bit samples
    let complete = false;
    for (;;) {
      const piece = await reader.read();
      if (this.replayId !== id) {
        reader.cancel().catch(() => {}); // stopped: the server stops making it
        return;
      }
      if (piece.done) break;
      let bytes = piece.value;
      if (carry !== null) {
        const joined = new Uint8Array(bytes.length + 1);
        joined[0] = carry;
        joined.set(bytes, 1);
        bytes = joined;
        carry = null;
      }
      if (bytes.length % 2) {
        carry = bytes[bytes.length - 1];
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (!bytes.length) continue;
      const pcm = new Int16Array(bytes.slice().buffer); // a copy: aligned, and safe to keep
      kept.push(pcm);
      if (this.replayLoading) {
        this.replayLoading = false;
        this.emit();
      }
      this.playReplayPiece(id, pcmBuffer(this.playCtx!, [pcm]), () => complete);
    }
    complete = true;
    if (kept.length) keepLatest(this.replayVoice, message.id, pcmBuffer(this.playCtx!, kept), KEPT_VOICES);
    if (!this.replayNodes.size && this.replayId === id) this.finishReplay(); // everything has already played
  }

  /** One piece of a replay, right after the previous one. The replay is over when the last piece ends. */
  private playReplayPiece(id: number, clip: AudioBuffer, complete: () => boolean) {
    const ctx = this.playCtx!;
    const node = ctx.createBufferSource();
    node.buffer = clip;
    node.connect(this.voiceGain!);
    // Right after a fade-out the volume is still coming back up: start just after it.
    const at = Math.max(this.replayAt, ctx.currentTime + (this.fading ? (FADE_MS + 60) / 1000 : 0.05));
    node.start(at);
    this.replayAt = at + clip.duration;
    this.replayNodes.add(node);
    node.onended = () => {
      if (!this.replayNodes.delete(node)) return; // stopped
      if (!this.replayNodes.size && complete() && this.replayId === id) this.finishReplay();
    };
  }

  // ── Saved chats ──────────────────────────────────────────────────────────
  /** Start a new, empty chat. The current one stays in the list. */
  newChat() {
    if (!this.messages.length) return;
    this.switchTo(null);
  }

  /** Open a saved chat. Maki gets its history, so it carries on with that conversation. */
  openChat(id: string) {
    if (id === this.chatId) return;
    const chat = this.chats.find((c) => c.id === id);
    if (chat) this.switchTo(chat);
  }

  deleteChat(id: string) {
    this.chats = this.chats.filter((c) => c.id !== id);
    saveChats(this.chats);
    if (id !== this.chatId) return this.emit();
    this.messages = []; // so it isn't saved again on the way out
    this.switchTo(null);
  }

  /** Leave the open chat for another one (or a new, empty one). */
  private switchTo(chat: SavedChat | null) {
    this.interrupt(); // in a call, Maki stops talking (its bubble keeps what was heard)
    this.stopReplay();
    if (this.playing.size) this.fadeOutAndStop(); // a typed answer still being read out
    // A typed answer still being written belongs to the chat being left; the server stops it there.
    if (this.makiBubble?.text) this.makiBubble.cut = true;
    this.saveNow();
    this.liveBubble = this.makiBubble = null;
    this.awaiting = false;
    this.replyFinished = true;
    this.firstWord = this.firstSound = this.roundTrip = "–";
    if (chat) this.showChat(chat);
    else {
      this.chatId = newChatId();
      this.messages = [];
      this.lastSaved = "";
      this.showEmpty = true;
    }
    saveCurrentId(this.chatId);
    // Give the server this chat's history. Events still on their way from the old chat are ignored
    // until it confirms ("history-ok").
    const turns = this.turnsForServer();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.syncing = true;
      clearTimeout(this.syncTimer);
      this.syncTimer = window.setTimeout(() => (this.syncing = false), 3000); // never stay deaf if no reply comes
      this.ws.send(JSON.stringify({ type: "history", turns }));
    } else if (this.ws) {
      this.openingTurns = turns; // still connecting: sent when it opens
    }
    this.scrollTick++;
    this.showTeacher("");
  }

  /** Put a saved chat on screen. */
  private showChat(chat: SavedChat) {
    this.chatId = chat.id;
    this.messages = chat.messages.map((m) => ({
      id: this.nextId++, who: m.who, text: m.text, live: false,
      aside: Boolean(m.aside), cut: Boolean(m.cut), plain: Boolean(m.plain), teacher: m.teacher || "",
    }));
    this.lastSaved = JSON.stringify(this.savedMessages());
    this.showEmpty = !this.messages.length;
  }

  /** The open chat's finished messages, as saved (captions still being spoken and empty bubbles left out). */
  private savedMessages(): SavedMessage[] {
    return this.messages
      .filter((m) => !m.live && m.text.trim())
      .slice(-MAX_MESSAGES)
      .map((m) => {
        const saved: SavedMessage = { who: m.who, text: m.text };
        if (m.teacher) saved.teacher = m.teacher;
        if (m.aside) saved.aside = true;
        if (m.cut) saved.cut = true;
        if (m.plain) saved.plain = true;
        return saved;
      });
  }

  /** The open chat as the server keeps it: questions and answers ("okay" while Maki talked left out). */
  private turnsForServer(): ChatTurn[] {
    return this.messages
      .filter((m) => !m.live && !m.aside && m.text.trim())
      .slice(-SYNC_TURNS)
      .map((m) => ({ role: m.who === "you" ? "user" : "assistant", content: m.text.trim() }));
  }

  private saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (this.saveNow()) this.emit(); // the list changed
    }, 400);
  }

  /** Save the open chat if it changed. Returns whether it did. */
  private saveNow(): boolean {
    clearTimeout(this.saveTimer);
    const messages = this.savedMessages();
    if (!messages.length) return false;
    const json = JSON.stringify(messages);
    if (json === this.lastSaved) return false;
    this.lastSaved = json;
    const chat: SavedChat = {
      id: this.chatId,
      title: chatTitle(messages.find((m) => m.who === "you")?.text || ""),
      updatedAt: Date.now(),
      messages,
    };
    this.chats = [chat, ...this.chats.filter((c) => c.id !== this.chatId)].slice(0, MAX_CHATS);
    saveChats(this.chats);
    saveCurrentId(this.chatId);
    return true;
  }

  // ── Microphone ───────────────────────────────────────────────────────────
  private onMicFrame({ pcm, level }: { pcm: ArrayBuffer; level: number }) {
    this.onLevel(this.muted ? "0" : Math.min(1, level * 3).toFixed(2));
    if (this.muted || this.ws?.readyState !== WebSocket.OPEN) return;
    const loud = level > (this.state === "speaking" ? VOICE_LEVEL_OVER_MAKI : VOICE_LEVEL);
    if (loud) this.lastVoiceAt = performance.now();
    if (!this.barge) {
      // Interruptions off: the mic is closed while Maki speaks, so Maki can't hear itself.
      if (this.state === "speaking") return;
    } else if (this.state === "speaking") {
      // The student starts talking: Maki's voice dips at once, like a person pausing to listen.
      this.voiceFrames = loud ? this.voiceFrames + 1 : 0;
      if (this.voiceFrames >= VOICE_FRAMES) this.duck();
    }
    this.ws.send(pcm);
  }

  private duck() {
    if (!this.voiceGain || !this.playCtx) return;
    if (!this.ducked) {
      this.ducked = true;
      this.rampVolume(DUCK_VOLUME, 80);
      this.emit();
    }
    clearTimeout(this.duckTimer);
    this.duckTimer = window.setTimeout(() => this.unduck(), BACKOFF_MS); // no real words by then: carry on
  }

  /** Back to full volume: gently while Maki is talking, at once when it has stopped. */
  private unduck(gently = true) {
    clearTimeout(this.duckTimer);
    if (!this.ducked) return;
    this.ducked = false;
    if (gently) this.rampVolume(1, 250);
    else if (!this.fading) this.setVolume(1); // a fade-out in progress restores the volume itself
    this.emit();
  }

  private setVolume(value: number) {
    if (!this.voiceGain || !this.playCtx) return;
    this.voiceGain.gain.cancelScheduledValues(this.playCtx.currentTime);
    this.voiceGain.gain.setValueAtTime(value, this.playCtx.currentTime);
  }

  private rampVolume(value: number, ms: number) {
    if (!this.voiceGain || !this.playCtx) return;
    const now = this.playCtx.currentTime;
    this.voiceGain.gain.cancelScheduledValues(now);
    this.voiceGain.gain.setValueAtTime(this.voiceGain.gain.value, now);
    this.voiceGain.gain.linearRampToValueAtTime(value, now + ms / 1000);
  }

  // ── Server events ────────────────────────────────────────────────────────
  private onEvent(ev: ServerEvent) {
    if (ev.type === "history-ok") {
      this.syncing = false;
      clearTimeout(this.syncTimer);
      return;
    }
    if (this.syncing && OLD_CHAT_EVENTS.has(ev.type)) return; // from the chat just left
    switch (ev.type) {
      case "ready":
        this.setState("listening");
        break;

      case "hearing": // live caption of what the student is saying
        if (!this.liveBubble) this.liveBubble = this.addMessage("you", "", true);
        this.liveBubble.text = ev.text;
        this.scrollTick++;
        if (this.barge && (this.state === "speaking" || this.state === "thinking")) {
          const micHeardYou = performance.now() - this.lastVoiceAt < MIC_RECENT_MS;
          if (isBackchannel(ev.text)) {
            if (this.state === "speaking") this.duck(); // "okay…": keep the voice low a moment, then carry on
          } else if (!micHeardYou) {
            // Words with a quiet mic: the late end of the question just asked. Not an interruption.
          } else if (this.repeatsMaki(ev.text)) {
            // Maki's own voice coming back through the mic (no headphones). Not the student.
          } else if (this.state === "thinking" || this.ducked || wordCount(ev.text) >= 3) {
            console.info(`[maki] stopped because it heard you: "${ev.text}"`);
            this.interrupt(ev.text);
          }
        }
        break;

      case "user-tail": // the late end of the question just asked: join it to that question
        if (this.liveBubble) {
          this.removeMessage(this.liveBubble);
          this.liveBubble = null;
        }
        {
          const yours = this.messages.filter((m) => m.who === "you" && !m.aside).pop();
          if (yours) yours.text += ` ${ev.text}`;
        }
        if (ev.restarted) {
          // Maki hadn't started speaking: it answers the whole question instead.
          if (this.makiBubble) this.removeMessage(this.makiBubble);
          this.makiBubble = null;
          this.awaiting = true;
          this.replyFinished = false;
          this.phrases = [];
          this.pendingPhrase = null;
          this.setState("thinking");
        }
        break;

      case "echo": // the server heard Maki's own voice through the mic: not something you said
        if (this.liveBubble) {
          this.removeMessage(this.liveBubble);
          this.liveBubble = null;
        }
        this.unduck();
        break;

      case "backchannel": // "okay" / "haan" while Maki talked: shown, Maki carries on
        if (this.liveBubble) {
          this.liveBubble.live = false;
          this.liveBubble.aside = true;
          this.liveBubble = null;
        }
        this.unduck();
        break;

      case "user": // the student finished a turn
        if (!this.liveBubble) this.liveBubble = this.addMessage("you", "", true);
        this.liveBubble.text = ev.text;
        this.finishLiveBubble();
        if (this.playing.size) this.interrupt(); // still talking: fade out, and say what was heard
        else this.stopPlayback();
        this.beginTurn();
        break;

      case "assistant-start": // empty until the first word: the page shows the thinking loader instead
        this.makiBubble = this.addMessage("maki", "");
        break;

      case "assistant-delta":
        if (this.makiBubble) {
          this.makiBubble.text += ev.text;
          this.awaiting = false;
          this.scrollTick++;
        }
        break;

      case "agent": // the decision maker handed the question to this teacher
        if (this.makiBubble) this.makiBubble.teacher = ev.teacher;
        this.showTeacher(ev.teacher);
        break;

      case "phrase": // the words of the audio that comes next
        this.pendingPhrase = ev.text;
        break;

      case "metrics":
        this.firstWord = ms(ev.aiFirstWordMs);
        this.firstSound = ms(ev.firstAudioMs);
        break;

      case "assistant-end":
        this.replyFinished = true;
        if (ev.aiFirstWordMs !== undefined) this.firstWord = ms(ev.aiFirstWordMs); // typed with no call: no "metrics" (no voice)
        // A short turn: the AI may have written more than Maki said. Show only what was said.
        if (this.makiBubble && ev.text) this.makiBubble.text = ev.text;
        this.dropWaitingBubble();
        this.makiBubble = null;
        if (!this.playing.size && this.state === "speaking") this.setState("listening");
        if (this.state === "thinking") this.setState("listening"); // an answer with nothing to say
        break;

      case "error":
        this.showError(ev.message);
        this.replyFinished = true;
        this.dropWaitingBubble();
        this.makiBubble = null;
        if (this.state === "thinking") this.setState("listening");
        break;
    }
    this.emit();
  }

  /** The student talked over Maki: fade Maki out and tell the server what was actually heard. */
  private interrupt(because = "") {
    if (this.state !== "speaking" && this.state !== "thinking") return;
    const heard = this.heardSoFar();
    this.fadeOutAndStop();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "interrupt", heard, because }));
    if (this.makiBubble || this.state === "speaking") {
      const bubble = this.makiBubble || this.lastMakiBubble();
      if (bubble) {
        bubble.text = heard ? `${heard} —` : "";
        bubble.plain = true;
        bubble.cut = true;
        if (!heard) this.removeMessage(bubble);
      }
    }
    this.makiBubble = null;
    this.awaiting = false;
    this.replyFinished = true;
    this.setState("listening");
  }

  /** The student finished a question (spoken or typed): Maki is thinking until its first word. */
  private beginTurn() {
    if (this.makiBubble) {
      // An answer still being written (typed, with no call): the new question cuts it short.
      if (this.makiBubble.text) this.makiBubble.cut = true;
      else this.removeMessage(this.makiBubble);
      this.makiBubble = null;
    }
    this.turnEndedAt = performance.now();
    this.heardAudio = false;
    this.replyFinished = false;
    this.phrases = [];
    this.pendingPhrase = null;
    this.awaiting = true;
    this.firstWord = this.firstSound = this.roundTrip = "–";
    if (this.state !== "idle") this.setState("thinking");
    else this.emit();
  }

  /** No answer is coming (finished, failed or disconnected): stop the loader and drop an empty bubble. */
  private dropWaitingBubble() {
    this.awaiting = false;
    if (this.makiBubble && !this.makiBubble.text) {
      this.removeMessage(this.makiBubble);
      this.makiBubble = null;
    }
  }

  /** Words of the current answer that have actually played, up to this moment. */
  private heardSoFar(): string {
    if (!this.playCtx || !this.phrases.length) return "";
    const now = this.playCtx.currentTime;
    const parts: string[] = [];
    this.phrases.forEach((p, i) => {
      const end = i + 1 < this.phrases.length ? this.phrases[i + 1].start : this.nextPlayTime;
      if (now >= end) parts.push(p.text);
      else if (now > p.start) {
        const words = p.text.split(/\s+/);
        const count = Math.floor((words.length * (now - p.start)) / Math.max(0.01, end - p.start));
        if (count > 0) parts.push(words.slice(0, count).join(" "));
      }
    });
    return parts.join(" ").trim();
  }

  // ── Maki's voice: 24 kHz 16-bit PCM, scheduled back to back ──────────────
  private onAudio(buffer: ArrayBuffer) {
    if (!this.playCtx || !this.voiceGain || this.replyFinished) return;
    const pcm = new Int16Array(buffer);
    // Kept for Replay, with the same short breath between phrases.
    if (this.makiBubble) {
      const id = this.makiBubble.id;
      const kept = this.streamedVoice.get(id) ?? keepLatest(this.streamedVoice, id, [], KEPT_VOICES);
      if (this.pendingPhrase !== null && kept.length) kept.push(new Int16Array(Math.round(PHRASE_PAUSE_S * VOICE_RATE)));
      kept.push(pcm);
      this.voiceMessageId = id;
    }
    // Muted, or a Replay playing: kept, not played.
    if (this.voiceOff || this.replayId) {
      this.pendingPhrase = null;
      return;
    }
    if (!this.heardAudio) {
      this.heardAudio = true;
      this.roundTrip = ms(performance.now() - this.turnEndedAt);
      this.emit();
    }
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
    const clip = this.playCtx.createBuffer(1, samples.length, VOICE_RATE);
    clip.getChannelData(0).set(samples);
    const node = this.playCtx.createBufferSource();
    node.buffer = clip;
    node.connect(this.voiceGain);
    // A new phrase after another one: leave a short breath between them.
    const pause = this.pendingPhrase !== null && this.phrases.length > 0 ? PHRASE_PAUSE_S : 0;
    const at = Math.max(this.nextPlayTime + pause, this.playCtx.currentTime + 0.03);
    if (this.pendingPhrase !== null) {
      this.phrases.push({ text: this.pendingPhrase, start: at });
      this.pendingPhrase = null;
    }
    node.start(at);
    this.nextPlayTime = at + clip.duration;
    this.playing.add(node);
    node.onended = () => {
      if (!this.playing.delete(node)) return; // already stopped (a fade-out cleared it)
      if (!this.playing.size && this.replyFinished && this.state === "speaking") this.setState("listening");
      else if (!this.playing.size) this.emit(); // a typed answer has finished being read out
    };
    if (this.state === "thinking") this.setState("speaking");
    else if (this.playing.size === 1) this.emit(); // a typed answer starts being read out
  }

  /** A short fade instead of a hard cut, then silence. */
  private fadeOutAndStop() {
    if (!this.playCtx || !this.voiceGain || !this.playing.size) return this.stopPlayback();
    const nodes = [...this.playing];
    this.playing.clear();
    this.nextPlayTime = 0;
    this.fading = true;
    this.rampVolume(0, FADE_MS);
    const ctx = this.playCtx;
    const gain = this.voiceGain;
    setTimeout(() => {
      for (const node of nodes) {
        try { node.stop(); } catch {}
      }
      this.fading = false;
      if (ctx.state !== "closed") {
        gain.gain.cancelScheduledValues(ctx.currentTime);
        gain.gain.setValueAtTime(1, ctx.currentTime);
      }
    }, FADE_MS + 30);
  }

  private stopPlayback() {
    for (const node of this.playing) {
      try { node.stop(); } catch {}
    }
    this.playing.clear();
    this.nextPlayTime = 0;
    if (this.fading) return; // the fade-out restores the volume when it ends
    this.setVolume(1);
  }

  // ── Conversation ─────────────────────────────────────────────────────────
  private addMessage(who: Message["who"], text: string, live = false): Message {
    this.showEmpty = false;
    const message: Message = { id: this.nextId++, who, text, live, aside: false, cut: false, plain: false, teacher: "" };
    this.messages.push(message);
    this.scrollTick++;
    return message;
  }

  private removeMessage(message: Message) {
    this.messages = this.messages.filter((m) => m !== message);
  }

  private lastMakiBubble(): Message | null {
    return this.messages.filter((m) => m.who === "maki").pop() || null;
  }

  private finishLiveBubble() {
    if (!this.liveBubble) return;
    this.liveBubble.live = false;
    if (!this.liveBubble.text.trim()) this.removeMessage(this.liveBubble);
    this.liveBubble = null;
  }

  /**
   * Do these words repeat what Maki is saying? (Maki's voice reaching the mic.) Compared by pairs
   * of words in a row, so a real question sharing a word or two with the answer still counts.
   * Same rule as the server.
   */
  private repeatsMaki(text: string): boolean {
    const words = wordsOf(text);
    if (words.length < 3) return false;
    const said = wordsOf(`${this.phrases.map((p) => p.text).join(" ")} ${this.makiBubble?.text || ""}`);
    const saidPairs = new Set(said.slice(1).map((w, i) => `${said[i]} ${w}`));
    const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`);
    return pairs.filter((p) => saidPairs.has(p)).length / pairs.length >= 0.6;
  }
}

function isBackchannel(text: string): boolean {
  const words = text.toLowerCase().replace(/[^\p{L}\p{M}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.every((w) => BACKCHANNEL_WORDS.has(w));
}

/** 24 kHz 16-bit PCM pieces as one playable clip. */
function pcmBuffer(ctx: AudioContext, chunks: Int16Array[]): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.max(1, chunks.reduce((n, chunk) => n + chunk.length, 0)), VOICE_RATE);
  const samples = buffer.getChannelData(0);
  let at = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) samples[at + i] = chunk[i] / 32768;
    at += chunk.length;
  }
  return buffer;
}

/** Put `value` in `map`, keeping only the newest `max` entries. Returns the value. */
function keepLatest<K, V>(map: Map<K, V>, key: K, value: V, max: number): V {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
  return value;
}

const wordsOf = (text: string): string[] => text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
const ms = (value: number | undefined): string => (Number.isFinite(value) ? `${(value! / 1000).toFixed(2)} s` : "–");
