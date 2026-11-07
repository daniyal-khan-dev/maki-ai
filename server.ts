// Maki two-way voice demo (option 1: listening -> AI -> voice, built from three services).
//
// Browser mic (16 kHz PCM) ──ws──▶ this server ──ws──▶ Deepgram live listening (Nova-3)
//                                       │  student's turn ends (silence)
//                                       ▼
//                              AI answer, streamed (any OpenAI-compatible chat API)
//                                       │  each finished sentence
//                                       ▼
// Browser speaker (24 kHz PCM) ◀──ws── Deepgram voice (Aura-2), sentences made in parallel, sent in order
//
// API keys stay on this server; the browser only talks to /ws.

import "dotenv/config";
import express from "express";
import { createServer, type IncomingMessage } from "http";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { SYSTEM_PROMPT, openingsNote } from "./lib/prompt";
import { toSpeech, sentenceEnd } from "./lib/speech";
import { LLM_MODEL, FORMULA_MODEL, modelFor } from "./lib/models";
import { BOOKS, ANY_BOOK, findBook, bookContext, type Book } from "./lib/books";
import { ensureAgents, openAgentReply, EXPERTS, type Agents, type AgentError, type ChatTurn } from "./lib/agents";

const PORT = Number(process.env.PORT || 3010);
// `npm run serve`: the page built by `npm run build`; otherwise Vite serves it with live reload.
const PROD = process.argv.includes("--prod") || process.env.NODE_ENV === "production";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.mistral.ai/v1").replace(/\/+$/, "");
// Tried last when the main model stays rate-limited.
const LLM_FALLBACK_MODEL =
  process.env.LLM_FALLBACK_MODEL ?? (LLM_BASE_URL.includes("mistral.ai") ? (LLM_MODEL === "ministral-3b-latest" ? "open-mistral-nemo" : "ministral-3b-latest") : "");
// Voices the page offers: Deepgram Aura-2 voices that Deepgram describes as natural, casual,
// friendly or expressive (closest to the conversational voices Vapi uses), plus two British ones.
const VOICES = [
  { id: "aura-2-luna-en", label: "Luna · friendly, natural (US, female)" },
  { id: "aura-2-helena-en", label: "Helena · caring, natural (US, female)" },
  { id: "aura-2-minerva-en", label: "Minerva · positive, friendly (US, female)" },
  { id: "aura-2-delia-en", label: "Delia · casual, cheerful (US, female)" },
  { id: "aura-2-andromeda-en", label: "Andromeda · casual, expressive (US, female)" },
  { id: "aura-2-apollo-en", label: "Apollo · casual, comfortable (US, male)" },
  { id: "aura-2-arcas-en", label: "Arcas · natural, smooth (US, male)" },
  { id: "aura-2-pandora-en", label: "Pandora · calm, smooth (British, female)" },
  { id: "aura-2-draco-en", label: "Draco · warm (British, male)" },
];
const isVoice = (id: unknown): id is string => typeof id === "string" && /^aura-2-[a-z]+-en$/.test(id);
const TTS_VOICE = isVoice(process.env.TTS_VOICE) ? process.env.TTS_VOICE : "aura-2-luna-en";
// "en": always writes English. "multi": follows Urdu/Hindi mixed with English, but with some
// accents it switches language on plain English (users saw English turned into Hindi/Urdu script).
// The page lets the student pick per conversation; this is the default.
const STT_LANGUAGES = ["en", "multi"];
const STT_LANGUAGE = STT_LANGUAGES.includes(process.env.STT_LANGUAGE || "") ? process.env.STT_LANGUAGE! : "en";
const KEYTERMS = (process.env.KEYTERMS || "Maki").split(",").map((t) => t.trim()).filter(Boolean);
const END_OF_TURN_MS = Number(process.env.END_OF_TURN_MS || 400);
// Backup end of turn: Deepgram's "finished" signal sometimes comes 7-8 s late (measured with
// "...what is a leaf made of?") even though the words were ready after 0.7 s. If the microphone
// has been quiet this long and we have words, the turn is treated as over.
const STABLE_TURN_MS = Number(process.env.STABLE_TURN_MS || 1200);
// ...and when the caption doesn't end like a sentence yet, the longest we wait in silence.
const MAX_QUIET_MS = Number(process.env.MAX_QUIET_MS || 3000);
// When Deepgram says "finished" but the sentence has no end punctuation, wait this long for more.
const NO_PUNCTUATION_WAIT_MS = Number(process.env.NO_PUNCTUATION_WAIT_MS || 900);
// Loudness (16-bit RMS) above which a mic frame counts as the student speaking.
const VOICE_RMS = Number(process.env.VOICE_RMS || 350);
// Longest typed question accepted from the page.
const MAX_TYPED_CHARS = 1000;
// A saved chat's history given by the page (it is the student's own conversation; only the
// most recent turns are kept, and each is capped).
const MAX_HISTORY_TURNS = 40;
const MAX_TURN_CHARS = 4000;

if (!DEEPGRAM_API_KEY || !LLM_API_KEY) {
  console.error("Missing keys: set DEEPGRAM_API_KEY and LLM_API_KEY in .env (see .env.example).");
  process.exit(1);
}

// A turn is at most this many sentences (one more when it gives a formula), like Vapi's short
// turns: the small free AI models ignore "one or two sentences" and ran to five (measured).
const MAX_SENTENCES = Number(process.env.MAX_SENTENCES || 3);

// Voice is made in phrases. The first sentence goes alone, usually a quick reaction like "Oh,
// sure!", so Maki answers at once the way a person does; then a medium phrase, then longer ones,
// because each request is spoken on its own and one-sentence pieces sound read out.
// (Gluing the reaction to the next sentence made the first sound ~0.6 s later in testing.)
const PHRASE_CHARS = [1, 70, 140]; // minimum length of phrase 1, 2, and every one after

// Agreement sounds a student makes while listening. Vapi treats these as "backchannels", not
// interruptions: Maki keeps talking.
const BACKCHANNEL_WORDS = new Set([
  "ok", "okay", "k", "yeah", "yes", "yep", "yup", "right", "sure", "alright", "cool", "nice", "true",
  "mhm", "mm", "mmm", "hmm", "hm", "uh", "huh", "uhhuh", "mmhmm", "i", "see", "got", "it",
  "haan", "han", "ha", "ji", "jee", "acha", "achha", "accha", "acchha", "theek", "thik", "hai",
  "ہاں", "اچھا", "جی", "ٹھیک", "ہے", "हाँ", "हां", "अच्छा", "जी", "ठीक", "है",
]);
function isBackchannel(text: string): boolean {
  const words = text.toLowerCase().replace(/[^\p{L}\p{M}\s]/gu, " ").split(/\s+/).filter(Boolean); // \p{M}: Hindi/Urdu vowel marks
  return words.length > 0 && words.length <= 3 && words.every((w) => BACKCHANNEL_WORDS.has(w));
}

const app = express();
// Behind nginx (Plesk): the visitor's address comes in X-Forwarded-For (used to limit Replay per visitor).
app.set("trust proxy", "loopback");

// Replay asks for an answer's voice again. Limited per visitor, so nobody can run up the voice bill.
const REPLAYS_PER_WINDOW = 40;
const REPLAY_WINDOW_MS = 10 * 60_000;
const MAX_REPLAY_CHARS = 1500;
const replays = new Map<string, number[]>();
function allowReplay(visitor: string): boolean {
  const now = Date.now();
  const recent = (replays.get(visitor) || []).filter((t) => now - t < REPLAY_WINDOW_MS);
  const allowed = recent.length < REPLAYS_PER_WINDOW;
  if (allowed) recent.push(now);
  replays.set(visitor, recent);
  return allowed;
}
setInterval(() => {
  const now = Date.now();
  for (const [visitor, times] of replays) if (!times.some((t) => now - t < REPLAY_WINDOW_MS)) replays.delete(visitor);
}, REPLAY_WINDOW_MS).unref();
// The agentic workflow (decision maker -> expert teacher) on Mistral's Agents API. AGENTIC=false,
// or any failure to set it up, answers directly instead (the earlier mode).
const AGENTIC = process.env.AGENTIC !== "false" && LLM_BASE_URL.includes("mistral.ai");
let agents: Agents | null = null;
if (AGENTIC) {
  ensureAgents()
    .then((a) => {
      agents = a;
      console.log(`Agents ready: decision maker -> ${EXPERTS.map((e) => e.label).join(", ")}`);
    })
    .catch((error: Error) => console.warn(`Agents not available, answering directly: ${error.message}`));
}

app.get("/config", (_req, res) =>
  res.json({
    model: LLM_MODEL, voice: TTS_VOICE, voices: VOICES, language: STT_LANGUAGE, endOfTurnMs: END_OF_TURN_MS,
    books: [
      { id: ANY_BOOK, title: "Any subject (no book)", chapters: [] },
      ...BOOKS.map((b) => ({ id: b.id, title: `${b.title} (${b.level})`, chapters: b.chapters.map((c) => c.title) })),
    ],
    agentic: Boolean(agents),
    teachers: EXPERTS.map((e) => e.label),
  }));
// "Preview" on the page: a short line in the chosen voice, so voices can be compared by ear.
app.get("/sample", async (req, res) => {
  const voice = isVoice(req.query.voice) ? req.query.voice : TTS_VOICE;
  try {
    const r = await fetch(`https://api.deepgram.com/v1/speak?model=${voice}&encoding=linear16&sample_rate=24000&container=wav`, {
      method: "POST",
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hey! I'm Maki. So, um, what are we learning today? Maths, science, something else?" }),
    });
    if (!r.ok) throw new Error(`voice service ${r.status}`);
    res.type("audio/wav").send(Buffer.from(await r.arrayBuffer()));
  } catch (error) {
    res.status(502).json({ message: `Could not make the sample: ${(error as Error).message}` });
  }
});
// "Replay" under an answer: the answer's voice again (when the page doesn't still have it, e.g. a
// chat reopened later). The written answer is turned into what the voice says, formulas included.
// Streamed as raw 16-bit PCM at 24 kHz as it is made, so it starts playing at once (waiting for the
// whole file took ~7 s for a four-sentence answer).
app.post("/speak", express.json({ limit: "16kb" }), async (req, res) => {
  const text = typeof req.body?.text === "string" ? toSpeech(req.body.text).slice(0, MAX_REPLAY_CHARS) : "";
  const voice = isVoice(req.body?.voice) ? req.body.voice : TTS_VOICE;
  if (!text) return void res.status(400).json({ message: "There's nothing to say in that answer." });
  if (!allowReplay(req.ip || "")) return void res.status(429).json({ message: "That's a lot of replays. Try again in a few minutes." });
  const stop = new AbortController();
  res.on("close", () => stop.abort()); // the page stopped the replay: stop making the voice
  try {
    const r = await fetch(`https://api.deepgram.com/v1/speak?model=${voice}&encoding=linear16&sample_rate=24000&container=none`, {
      method: "POST",
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: stop.signal,
    });
    if (!r.ok || !r.body) throw new Error(`voice service ${r.status}`);
    res.type("application/octet-stream");
    res.setHeader("X-Accel-Buffering", "no"); // nginx: pass it on as it arrives
    for await (const chunk of r.body) res.write(chunk);
    res.end();
  } catch (error) {
    if (stop.signal.aborted) return;
    console.warn(`[replay] ${(error as Error).message}`);
    if (res.headersSent) res.end();
    else res.status(502).json({ message: "That answer couldn't be played. Try again in a moment." });
  }
});

const server = createServer(app);
// The page (client/, React): Vite serves it with live reload, or the built copy in dist/.
if (PROD) {
  app.use(express.static(fileURLToPath(new URL("./dist", import.meta.url))));
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

// Our socket is /ws. Any other upgrade (Vite's live reload) is left to Vite.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url || "/", "http://localhost").pathname !== "/ws") return;
  wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
});
wss.on("connection", (client: WebSocket, req: IncomingMessage) => {
  const query = new URL(req.url || "/", "http://localhost").searchParams;
  const lang = query.get("lang");
  const voice = query.get("voice");
  // listen=0: the page connects without the microphone (to type); it starts listening when a call starts.
  const listen = query.get("listen") !== "0";
  const conversation = new Conversation(client, lang && STT_LANGUAGES.includes(lang) ? lang : STT_LANGUAGE, isVoice(voice) ? voice : TTS_VOICE, findBook(query.get("book")), listen);
  if (query.get("speak") === "0") conversation.speakReplies = false; // the page has Maki's voice muted
});
server.listen(PORT, () => {
  console.log(`Maki AI running: http://localhost:${PORT}`);
  console.log(`AI: ${AGENTIC ? "agentic workflow (decision maker -> expert teachers)" : `${LLM_MODEL}${FORMULA_MODEL ? ` (formula questions: ${FORMULA_MODEL})` : ""}`} @ ${LLM_BASE_URL} | default voice: ${TTS_VOICE} | listening: nova-3 (${STT_LANGUAGE})`);
});

/** A word Deepgram heard, with when it started in the audio (s). */
interface HeardWord {
  start: number;
  word: string;
  punctuated_word?: string;
}

/** A message from Deepgram's live listening. */
interface ListeningMessage {
  type: string;
  start?: number;
  duration?: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string; words?: HeardWord[] }[] };
}

/** A message from the browser. */
interface ClientMessage {
  type?: string;
  speaking?: boolean;
  heard?: unknown;
  because?: string;
  on?: boolean; // "listen": a voice call starts (true) or ends (false); "speak": Maki's voice on or muted
  text?: unknown; // "text": a typed question
  turns?: unknown; // "history": the opened chat's conversation so far
  book?: unknown;
  voice?: unknown;
  lang?: unknown;
}

/** The answer being written and spoken. */
interface Reply {
  controller: AbortController;
  text: string;
  aloud: boolean; // spoken, or only shown (Maki's voice muted on the page)
  spoke?: boolean;
}

/** One student's conversation: a live listening stream, the chat history and the reply being spoken. */
class Conversation {
  client: WebSocket;
  language: string; // listening language for this conversation: "en" or "multi"
  voice: string; // Maki's voice for this conversation
  book: Book | null; // the book the student picked (dummy data in this demo), or none: any subject
  voiceOn = false; // a voice call is on: listening
  speakReplies = true; // answers are spoken (typed or in a call), unless the page muted Maki's voice
  lastTurnTyped = false; // the last question was typed (late spoken words don't belong to it)
  openings: string[] = []; // how Maki began its last few replies, so it varies them
  history: ChatTurn[] = [];
  finalParts: string[] = []; // finished pieces of what the student is saying now
  pendingText = ""; // the latest unfinished piece
  lastHeard = ""; // what the caption showed last, to notice when it stops changing
  usedUntil = 0; // audio time (s) already used by a turn ended early; Deepgram repeats it later
  lastVoiceAt = 0; // when the mic last carried speech
  clientSpeaking = false; // the browser is playing Maki's voice right now
  cutEntry: ChatTurn | null = null; // the history entry of the last answer that was cut off
  reply: Reply | null = null; // the answer being written and spoken
  lastUserEntry: ChatTurn | null = null; // the student's last question in the history
  turnEndedAt = 0;
  speakingEndedAt = 0; // when the browser last stopped playing Maki
  lastAudioEnd = 0; // audio time (s) of the end of the latest listening result
  stt: WebSocket | null = null; // Deepgram live listening
  holdTimer: NodeJS.Timeout | undefined;
  quietWatch: NodeJS.Timeout;

  constructor(client: WebSocket, language: string, voice: string, book: Book | null, listen: boolean) {
    this.client = client;
    this.language = language;
    this.voice = voice;
    this.book = book;
    if (listen) this.openListening();
    this.quietWatch = setInterval(() => this.checkQuiet(), 100);

    client.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        // Microphone audio: straight on to Deepgram.
        if (this.stt?.readyState === WebSocket.OPEN) this.stt.send(data);
        if (loudness(data as Buffer) > VOICE_RMS) this.lastVoiceAt = Date.now();
        return;
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "playback") {
        this.clientSpeaking = Boolean(msg.speaking);
        if (!msg.speaking) this.speakingEndedAt = Date.now();
      }
      if (msg.type === "interrupt") {
        // The student talked over Maki. `heard` is what actually played before Maki stopped.
        this.clientSpeaking = false;
        this.speakingEndedAt = Date.now();
        const heard = typeof msg.heard === "string" ? msg.heard.trim() : "";
        if (this.reply) console.log(`[maki] stopped: the student talked over it ("${msg.because || ""}")`);
        if (this.reply) this.cancelReply(heard);
        else if (this.cutEntry && heard) this.cutEntry.content = `${heard} —`; // the answer was already finished sending
      }
      if (msg.type === "reset") {
        this.cancelReply();
        this.history = [];
      }
      if (msg.type === "listen") {
        // A voice call starts or ends. The conversation (and what Maki remembers) carries on either way.
        this.applySettings(msg);
        if (msg.on) this.openListening();
        else this.closeListening();
      }
      if (msg.type === "text") {
        this.applySettings(msg);
        this.typed(typeof msg.text === "string" ? msg.text : "");
      }
      if (msg.type === "speak") {
        // Mute / Unmute on the page. Muting also stops the rest of the answer being voiced.
        this.speakReplies = Boolean(msg.on);
        if (!this.speakReplies && this.reply) this.reply.aloud = false;
      }
      if (msg.type === "history") {
        // The page opened a saved chat (or a new one, or reconnected): Maki carries on with that conversation.
        this.cancelReply();
        this.history = parseTurns(msg.turns);
        this.lastUserEntry = null;
        this.cutEntry = null;
        this.lastTurnTyped = false;
        this.openings = [];
        this.send({ type: "history-ok" }); // events before this one belong to the chat that was left
      }
    });

    client.on("close", () => {
      this.cancelReply();
      clearInterval(this.quietWatch);
      this.closeListening();
    });
  }

  /** The book, voice and listening language picked on the page (sent when a call starts and with typed questions). */
  applySettings(msg: ClientMessage) {
    if (typeof msg.book === "string") this.book = findBook(msg.book);
    if (isVoice(msg.voice)) this.voice = msg.voice;
    if (typeof msg.lang === "string" && STT_LANGUAGES.includes(msg.lang) && !this.stt) this.language = msg.lang;
  }

  send(event: Record<string, unknown>) {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(event));
  }

  sendAudio(chunk: Buffer) {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(chunk);
  }

  // ── Listening ────────────────────────────────────────────────────────────
  openListening() {
    if (this.stt) return;
    this.voiceOn = true;
    // A new listening stream counts audio time from zero again.
    this.usedUntil = 0;
    this.lastAudioEnd = 0;
    this.finalParts = [];
    this.pendingText = "";
    this.lastHeard = "";
    const params = new URLSearchParams({
      model: "nova-3",
      language: this.language,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: String(END_OF_TURN_MS), // silence that marks the end of the student's sentence
      utterance_end_ms: "1000", // backup end-of-turn signal for noisy rooms
      vad_events: "true",
    });
    // Words Deepgram should listen out for (without it, "Maki" came out as "Mackie" or "Markie").
    for (const term of KEYTERMS) params.append("keyterm", term);
    const stt = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });
    this.stt = stt;
    // Events from a stream that has since been closed (the call ended) are ignored.
    const current = () => this.stt === stt;
    let keepAlive: NodeJS.Timeout | undefined;
    stt.on("open", () => {
      if (!current()) return;
      this.send({ type: "ready", model: LLM_MODEL, voice: TTS_VOICE, language: this.language });
      // Deepgram closes a silent stream after ~10 s; this keeps it open while the mic is muted.
      keepAlive = setInterval(() => {
        if (stt.readyState === WebSocket.OPEN) stt.send(JSON.stringify({ type: "KeepAlive" }));
      }, 5000);
    });
    stt.on("message", (raw) => {
      if (!current()) return;
      try {
        this.onListening(JSON.parse(raw.toString()));
      } catch {}
    });
    stt.on("unexpected-response", (_req, res) => {
      if (current()) this.send({ type: "error", message: `Listening service refused the connection (HTTP ${res.statusCode}). Check DEEPGRAM_API_KEY.` });
    });
    stt.on("error", (e) => current() && this.send({ type: "error", message: `Listening: ${e.message}` }));
    stt.on("close", () => clearInterval(keepAlive));
  }

  /** The call ended: stop listening. Typed questions still work (the page stops an answer it was saying). */
  closeListening() {
    clearTimeout(this.holdTimer);
    this.finalParts = [];
    this.pendingText = "";
    this.lastHeard = "";
    this.clientSpeaking = false;
    this.voiceOn = false;
    const stt = this.stt;
    this.stt = null;
    if (!stt) return;
    try {
      stt.send(JSON.stringify({ type: "CloseStream" }));
    } catch {}
    try {
      stt.close();
    } catch {}
  }

  onListening(m: ListeningMessage) {
    if (m.type === "Results") {
      const alt: { transcript?: string; words?: HeardWord[] } = m.channel?.alternatives?.[0] || {};
      let text = (alt.transcript || "").trim();
      if (this.usedUntil && (m.start || 0) < this.usedUntil) {
        // Part of this audio was already used by a turn ended early: keep only the newer words.
        text = (alt.words || [])
          .filter((w) => w.start >= this.usedUntil - 0.01)
          .map((w) => w.punctuated_word || w.word)
          .join(" ")
          .trim();
      }
      this.lastAudioEnd = (m.start || 0) + (m.duration || 0);
      if (m.is_final) {
        if (text) this.finalParts.push(text);
        this.pendingText = "";
      } else {
        this.pendingText = text;
      }
      const live = [...this.finalParts, this.pendingText].join(" ").trim();
      if (live && live !== this.lastHeard) {
        this.lastHeard = live;
        this.send({ type: "hearing", text: live });
        clearTimeout(this.holdTimer); // more words came: the student is still going
      }
      if (m.speech_final) {
        // Like Vapi's "no punctuation" wait: a sentence that doesn't end in . ? ! may not be
        // finished (measured: "...what photosynthesis" | pause | "is?"), so give it a moment.
        if (/[.?!]["')\]]?$/.test(live)) this.endOfTurn();
        else {
          clearTimeout(this.holdTimer);
          this.holdTimer = setTimeout(() => this.endOfTurn(), NO_PUNCTUATION_WAIT_MS);
        }
      }
    } else if (m.type === "UtteranceEnd") {
      this.endOfTurn();
    }
  }

  /**
   * Backup for a late "finished" signal: the mic has been quiet for a while and the caption reads
   * as a finished sentence. Without end punctuation the last words may still be on their way
   * (measured: "...what is a leaf made" arrived without "of?"), so it waits longer.
   */
  checkQuiet() {
    const text = [...this.finalParts, this.pendingText].join(" ").trim();
    if (!text || !this.lastVoiceAt) return;
    const quietFor = Date.now() - this.lastVoiceAt;
    const looksFinished = /[.?!]["')\]]?$/.test(text);
    if (quietFor > (looksFinished ? STABLE_TURN_MS : MAX_QUIET_MS)) this.endOfTurn(true);
  }

  endOfTurn(early = false) {
    clearTimeout(this.holdTimer);
    const text = [...this.finalParts, this.pendingText].join(" ").trim();
    this.finalParts = [];
    this.pendingText = "";
    this.lastHeard = "";
    if (early && text) this.usedUntil = this.lastAudioEnd;
    if (!text) return;
    // "okay", "haan", "mm-hmm" while Maki is talking: the student is listening, not interrupting.
    if (this.clientSpeaking && isBackchannel(text)) {
      this.send({ type: "backchannel", text });
      return;
    }
    // Maki's own voice coming back through the mic (no headphones): not the student.
    if (this.isEcho(text)) {
      console.log(`[maki] ignored its own voice from the mic: "${text}"`);
      this.send({ type: "echo", text });
      return;
    }
    // The last words of the previous question arriving late ("...photosynthesis" | "is?"), with
    // the mic quiet since: they belong to that question, not a new one that would cut Maki off.
    if (this.lastUserEntry && !this.lastTurnTyped && this.lastVoiceAt <= this.turnEndedAt && Date.now() - this.turnEndedAt < 5000) {
      this.lastUserEntry.content = `${this.lastUserEntry.content} ${text}`;
      const restart = Boolean(this.reply && !this.reply.spoke); // not speaking yet: answer the whole question
      console.log(`[maki] late end of the last question added: "${text}"${restart ? " (answering the whole question)" : ""}`);
      this.send({ type: "user-tail", text, restarted: restart });
      if (restart) {
        this.cancelReply("");
        this.turnEndedAt = Date.now();
        this.respond();
      }
      return;
    }
    if (this.reply) console.log(`[maki] stopped: new question "${text}"`);
    this.cancelReply(); // first, so a cut-off answer is saved before this new question
    this.turnEndedAt = Date.now();
    this.send({ type: "user", text });
    this.lastTurnTyped = false;
    this.lastUserEntry = { role: "user", content: text };
    this.history.push(this.lastUserEntry);
    this.respond();
  }

  /**
   * A question typed on the page: a whole turn at once, so none of the listening checks (echo,
   * "okay", late words) apply. The page shows it straight away, so it isn't sent back.
   */
  typed(raw: string) {
    const text = raw.trim().slice(0, MAX_TYPED_CHARS);
    if (!text) return;
    if (this.reply) console.log(`[maki] stopped: new typed question "${text}"`);
    this.cancelReply();
    this.turnEndedAt = Date.now();
    this.lastTurnTyped = true;
    this.lastUserEntry = { role: "user", content: text };
    this.history.push(this.lastUserEntry);
    this.respond();
  }

  /** Words that repeat what Maki is saying (or just said), heard while it was talking. */
  isEcho(text: string): boolean {
    if (!this.clientSpeaking && Date.now() - this.speakingEndedAt > 1500) return false;
    const lastAnswer = [...this.history].reverse().find((m) => m.role === "assistant")?.content || "";
    return repeats(text, `${this.reply?.text || ""} ${lastAnswer}`);
  }

  // ── Answer and voice ─────────────────────────────────────────────────────
  /**
   * Stop the answer being written and spoken. `heard` is what the student actually heard (the
   * browser knows; the answer is written faster than it is spoken). The history keeps only that,
   * ending in "—", so Maki knows where it was cut off and doesn't repeat itself.
   */
  /** The first few words of a reply ("Ooh, good one."), kept so the next reply starts differently. */
  rememberOpening(text: string) {
    const opening = text.trim().split(/(?<=[,.!?])\s/)[0].split(/\s+/).slice(0, 4).join(" ");
    if (!opening) return;
    this.openings = [...this.openings, opening].slice(-3);
  }

  cancelReply(heard?: string) {
    const reply = this.reply;
    if (!reply) return;
    this.reply = null;
    reply.controller.abort();
    if (heard) this.rememberOpening(heard);
    const said = (heard ?? reply.text).trim();
    if (said) {
      this.cutEntry = { role: "assistant", content: `${said} —` };
      this.history.push(this.cutEntry);
    }
  }

  /**
   * Where the answer comes from. Normally the agentic workflow: the decision maker hands the
   * question (with the book and the conversation) to the right expert teacher. If the agents
   * aren't available or refuse, Maki answers directly, so it never goes silent.
   */
  async openAnswer(signal: AbortSignal): Promise<AsyncIterable<string>> {
    if (agents) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return await openAgentReply(agents, this.agentInputs(), signal, (teacher) => {
            console.log(`[agents] decision maker -> ${teacher}`);
            this.send({ type: "agent", teacher });
          });
        } catch (error) {
          if (signal.aborted) throw error;
          if ((error as AgentError).status === 429 && attempt === 1) {
            console.warn("[agents] rate-limited, trying again");
            await sleep(800);
            continue;
          }
          console.warn(`[agents] ${(error as Error).message}; answering directly this time`);
          break;
        }
      }
    }
    this.send({ type: "agent", teacher: "Maki (direct)" });
    return this.openDirectAnswer(signal);
  }

  /**
   * Our own history for the agents (so it holds only what the student heard). The book goes at
   * the start as background; on the latest question it made the small models fixate on it.
   * Maki's note about varying its opening goes with the latest question.
   */
  agentInputs(): ChatTurn[] {
    const turns = this.history.slice(-12).map(({ role, content }) => ({ role, content }));
    while (turns.length && turns[0].role !== "user") turns.shift();
    if (!turns.length) return turns;
    const background = bookContext(this.book);
    if (background) turns[0] = { role: "user", content: `${background}\n${turns[0].content}` };
    const note = openingsNote(this.openings);
    const last = turns.map((t) => t.role).lastIndexOf("user");
    if (note && last >= 0) turns[last] = { role: "user", content: `[Note for Maki: ${note}]\n${turns[last].content}` };
    return turns;
  }

  /** The earlier mode: one model answers directly (formula questions to the formula-careful one). */
  async openDirectAnswer(signal: AbortSignal): Promise<AsyncIterable<string>> {
    // Free AI plans refuse requests that come too close together (429): wait a moment and try
    // again, then once with a lighter model, instead of leaving Maki silent.
    const model = modelFor(this.lastUserEntry?.content);
    const system = [SYSTEM_PROMPT, bookContext(this.book), openingsNote(this.openings)].filter(Boolean).join("\n\n");
    let res!: Response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${LLM_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: attempt === 3 && LLM_FALLBACK_MODEL ? LLM_FALLBACK_MODEL : model,
          stream: true,
          max_tokens: 280, // room for a formula and its example
          temperature: 0.6,
          messages: [{ role: "system", content: system }, ...this.history.slice(-12)],
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), // a stalled answer must not leave Maki silent
      });
      if (res.status !== 429 || attempt === 3) break;
      console.warn(`[ai] rate-limited, trying again (${attempt})`);
      await res.text().catch(() => "");
      await sleep(attempt === 1 ? 700 : 1300);
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(res.status === 429 ? `The AI is rate-limited (free plan). Wait a moment and try again. ${detail}` : `AI error ${res.status}: ${detail}`);
    }
    return streamedText(res.body!);
  }

  async respond() {
    this.cancelReply();
    const controller = new AbortController();
    const reply: Reply = { controller, text: "", aloud: this.speakReplies };
    this.reply = reply;
    const startedAt = this.turnEndedAt;
    const metrics: { aiFirstWordMs?: number; firstAudioMs?: number; totalMs?: number } = {};
    const isCurrent = () => this.reply === reply;

    const voice = new SpeechQueue(
      this.voice,
      (chunk) => {
        if (!isCurrent()) return;
        reply.spoke = true;
        if (metrics.firstAudioMs === undefined) {
          metrics.firstAudioMs = Date.now() - startedAt;
          this.send({ type: "metrics", ...metrics });
        }
        this.sendAudio(chunk);
      },
      controller.signal,
      // Before each phrase's audio, tell the browser its words, so it knows what was heard if cut off.
      (text) => isCurrent() && this.send({ type: "phrase", text }),
    );

    // Stops the AI writing: when the reply is cancelled, or when the turn is long enough.
    const writing = new AbortController();
    controller.signal.addEventListener("abort", () => writing.abort(), { once: true });

    this.send({ type: "assistant-start" });
    try {
      const answer = await this.openAnswer(writing.signal);

      let pending = ""; // text not yet a finished sentence
      let phrase = ""; // finished sentences waiting to be spoken together
      let phrases = 0;
      let sentences = 0;
      let said = ""; // the finished sentences: what this turn will actually say
      const speakPhrase = () => {
        if (phrase.trim()) {
          if (reply.aloud) voice.add(phrase); // Maki's voice muted on the page: the answer is only shown
          phrases += 1;
        }
        phrase = "";
      };
      let full = false;
      try {
        for await (const delta of answer) {
          if (!isCurrent()) return;
          if (metrics.aiFirstWordMs === undefined) metrics.aiFirstWordMs = Date.now() - startedAt;
          reply.text += delta;
          pending += delta;
          this.send({ type: "assistant-delta", text: delta });
          // Finished sentences are gathered into a phrase, then spoken while the rest is written.
          let cut: number;
          while (!full && (cut = sentenceEnd(pending)) > 0) {
            const sentence = pending.slice(0, cut);
            pending = pending.slice(cut);
            // "Great question!" again: the clearest sign of a robot. Skip it and go straight in.
            if (sentences === 0 && !said && isPraise(sentence) && this.openings.some(isPraise)) continue;
            phrase += sentence;
            said += sentence;
            sentences += 1;
            if (phrase.trim().length >= PHRASE_CHARS[Math.min(phrases, PHRASE_CHARS.length - 1)]) speakPhrase();
            // A short turn, like a person talking: stop here and let the student respond.
            full = sentences >= MAX_SENTENCES + (said.includes("{{") ? 1 : 0);
          }
          if (full) {
            writing.abort(); // the AI may keep writing; nobody will hear it
            break;
          }
        }
      } catch (error) {
        if (!full) throw error; // stopping the AI on purpose is not an error
      }
      if (full) {
        pending = "";
        reply.text = said; // the screen and the history keep only what is spoken
      } else said += pending;
      phrase += pending;
      speakPhrase();
      await voice.finished();
      if (!isCurrent()) return;
      this.reply = null;
      this.history.push({ role: "assistant", content: reply.text.trim() });
      this.rememberOpening(reply.text);
      metrics.totalMs = Date.now() - startedAt;
      this.send({ type: "assistant-end", ...metrics, text: reply.text.trim() });
    } catch (error) {
      if (controller.signal.aborted) return; // interrupted: cancelReply already tidied up
      if (isCurrent()) this.reply = null;
      console.error("Reply failed:", (error as Error).message);
      this.send({ type: "error", message: (error as Error).message });
    }
  }
}

/** One phrase's voice: its audio as it arrives, and whether it has all arrived. */
interface SpeechJob {
  text: string;
  chunks: Buffer[];
  done: boolean;
  wake: (() => void) | null;
  result: Promise<void>;
}

/**
 * Speaks phrases in order. Each phrase's audio is requested as soon as the phrase is written
 * (so the next one is ready while this one plays) and passed on as it arrives. `onPhrase` is
 * told each phrase's words just before its audio.
 */
class SpeechQueue {
  chain: Promise<void> = Promise.resolve();

  constructor(
    private voice: string,
    private onAudio: (chunk: Buffer) => void,
    private signal: AbortSignal,
    private onPhrase?: (text: string) => unknown,
  ) {}

  add(sentence: string) {
    const text = toSpeech(sentence); // formulas in their spoken form
    if (!text || this.signal.aborted) return;
    const job: SpeechJob = { text, chunks: [], done: false, wake: null, result: Promise.resolve() };
    job.result = speakWithRetry(text, this.voice, (chunk) => {
      job.chunks.push(chunk);
      job.wake?.();
    }, this.signal).finally(() => {
      job.done = true;
      job.wake?.();
    });
    job.result.catch(() => {}); // handled in drain
    this.chain = this.chain.then(() => this.drain(job));
  }

  async drain(job: SpeechJob) {
    if (!this.signal.aborted) this.onPhrase?.(job.text);
    for (;;) {
      while (job.chunks.length) this.onAudio(job.chunks.shift()!);
      if (job.done || this.signal.aborted) break;
      await new Promise<void>((resolve) => {
        job.wake = resolve;
        if (job.chunks.length || job.done) resolve();
      });
      job.wake = null;
    }
    await job.result.catch((error) => {
      if (!this.signal.aborted) throw error;
    });
  }

  finished() {
    return this.chain;
  }
}

/** One quick retry when a phrase's voice fails before any sound (network blip, busy service). */
async function speakWithRetry(text: string, voice: string, onChunk: (chunk: Buffer) => void, signal: AbortSignal): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let sent = false;
    try {
      return await speak(text, voice, (chunk) => {
        sent = true;
        onChunk(chunk);
      }, signal);
    } catch (error) {
      if (sent || signal.aborted || attempt >= 2) throw error;
      console.warn(`[voice] retrying a phrase: ${(error as Error).message}`);
      await sleep(300);
    }
  }
}

// Deepgram starts every phrase with 0.24-0.37 s of silence (measured). Trimmed to a short lead-in,
// so Maki's first word comes sooner and the browser can put one even pause between phrases.
const LEAD_IN_SAMPLES = 1440; // 60 ms at 24 kHz kept before the first sound
const SOUND_LEVEL = 600; // a 16-bit sample louder than this is speech, not silence
const MAX_TRIM_BYTES = 48000; // never hold back more than 1 s looking for the first sound
// A phrase's voice that stops arriving for this long (seen on a flaky connection) is given up and
// retried, instead of leaving Maki silent for ever. Measured on the slow side: 3-6 s for a whole
// sentence, with audio arriving all along, so only a real stall trips it.
const VOICE_STALL_MS = 8_000;

/** Deepgram Aura voice, streamed as raw 16-bit PCM at 24 kHz, with its leading silence trimmed. */
async function speak(text: string, voice: string, onChunk: (chunk: Buffer) => void, signal: AbortSignal): Promise<void> {
  const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}&encoding=linear16&sample_rate=24000&container=none`;
  const stall = new AbortController();
  let stallTimer = setTimeout(() => stall.abort(), VOICE_STALL_MS);
  const stillComing = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stall.abort(), VOICE_STALL_MS);
  };
  try {
    await speakStream(url, text, onChunk, AbortSignal.any([signal, stall.signal]), stillComing);
  } catch (error) {
    if (stall.signal.aborted && !signal.aborted) throw new Error(`the voice stopped arriving for ${VOICE_STALL_MS / 1000} s`);
    throw error;
  } finally {
    clearTimeout(stallTimer);
  }
}

async function speakStream(url: string, text: string, onChunk: (chunk: Buffer) => void, signal: AbortSignal, stillComing: () => void) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw new Error(`Voice error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let carry: Buffer | null = null; // an odd byte held back so every chunk is whole 16-bit samples
  let lead = Buffer.alloc(0); // audio before the first sound, while it is being trimmed
  let trimming = true;
  for await (const piece of res.body!) {
    stillComing();
    let buf = Buffer.from(piece);
    if (carry) {
      buf = Buffer.concat([carry, buf]);
      carry = null;
    }
    if (buf.length % 2) {
      carry = Buffer.from(buf.subarray(buf.length - 1));
      buf = buf.subarray(0, buf.length - 1);
    }
    if (trimming) {
      lead = Buffer.concat([lead, buf]);
      const first = firstSound(lead);
      if (first < 0 && lead.length < MAX_TRIM_BYTES) continue;
      trimming = false;
      buf = first < 0 ? lead : lead.subarray(Math.max(0, first - LEAD_IN_SAMPLES) * 2);
    }
    if (buf.length) onChunk(buf);
  }
  if (trimming && lead.length) onChunk(lead); // a phrase that was all quiet: send it as it is
}

/** Index of the first speech sample in 16-bit PCM, or -1. */
function firstSound(pcm: Buffer): number {
  for (let i = 0; i < pcm.length >> 1; i++) if (Math.abs(pcm.readInt16LE(i * 2)) > SOUND_LEVEL) return i;
  return -1;
}

/** Text deltas from an OpenAI-style streamed chat response (server-sent events). */
async function* streamedText(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {}
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A saved chat's turns from the page, checked: only questions and answers, the most recent ones, each capped. */
function parseTurns(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_HISTORY_TURNS).flatMap((turn: { role?: unknown; content?: unknown } | null) => {
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.content !== "string") return [];
    const content = turn.content.trim().slice(0, MAX_TURN_CHARS);
    return content ? [{ role: turn.role, content }] : [];
  });
}

/** "Great question!", "Ah, good question.", "That's an excellent question!", "Ooh, nice one." */
const isPraise = (text: string): boolean => /^\W*(?:\w+,?\s+){0,2}(?:a\s+)?(?:great|good|excellent|fantastic|awesome|nice)\s+(?:question|one)\b/i.test(text.trim());

const wordsOf = (text: string): string[] => text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);

/**
 * Does `heard` repeat Maki's own words? Compared by pairs of words in a row, so a real question
 * that shares a word or two with Maki's answer ("what is the sun?") isn't mistaken for an echo.
 */
export function repeats(heard: string, makiSaid: string): boolean {
  const words = wordsOf(heard);
  if (words.length < 3) return false;
  const said = wordsOf(makiSaid);
  const saidPairs = new Set(said.slice(1).map((w, i) => `${said[i]} ${w}`));
  const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`);
  return pairs.filter((p) => saidPairs.has(p)).length / pairs.length >= 0.6;
}

/** Loudness of one 16-bit mic frame (root mean square). */
function loudness(buf: Buffer): number {
  const samples = buf.length >> 1;
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}
