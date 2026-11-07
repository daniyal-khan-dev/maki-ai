// Maki AI, the page: controls on the left (talk button, set-up, how Maki answers, timings), the
// conversation on the right with the saved chats beside it and a box to type in. The voice and the
// saved chats are VoiceSession (voiceSession.ts).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { VoiceSession, type SessionState } from "./voiceSession";
import { FormulaText } from "./FormulaText";
import { Icon } from "./icons";

/** What the server tells the page (GET /config). */
interface Config {
  model: string;
  voice: string;
  voices: { id: string; label: string }[];
  language: string;
  endOfTurnMs: number;
  books: { id: string; title: string; chapters: string[] }[];
  agentic: boolean;
  teachers: string[];
}

const STATE_LABEL: Record<SessionState, string> = { idle: "Ready", connecting: "Connecting…", listening: "Listening", thinking: "Thinking", speaking: "Speaking" };
const oneColumn = window.matchMedia("(max-width: 860px)");
// Shown before the first question; clicking one asks it.
const EXAMPLES = [
  "What's the quadratic formula?",
  "Why are leaves green?",
  "What caused the First World War?",
  "What is inflation?",
  "How do I write a good essay?",
  "How should I revise for exams?",
];

/** When a chat was last used, for the list: "Just now", "5 min ago", "3:40 PM", "Yesterday", "4 Nov". */
function whenUsed(time: number): string {
  const seconds = (Date.now() - time) / 1000;
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const day = new Date(time);
  const today = new Date();
  if (day.toDateString() === today.toDateString()) return day.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString([], { day: "numeric", month: "short" });
}

export default function App() {
  const [session] = useState(() => new VoiceSession());
  const view = useSyncExternalStore(session.subscribe, session.getView);
  const [config, setConfig] = useState<Config | null>(null);
  const [book, setBook] = useState("");
  const [voice, setVoice] = useState("");
  const [lang, setLang] = useState("en");
  const [barge, setBarge] = useState(true);
  const [preview, setPreview] = useState<"ready" | "loading" | "playing">("ready");
  const [draft, setDraft] = useState("");
  const [chatsOpen, setChatsOpen] = useState(false); // the chat list on narrow screens (always shown on wide ones)
  const [menuOpen, setMenuOpen] = useState(false); // phones: everything but the chat is in the navbar's menu
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const appRoot = useRef<HTMLDivElement>(null);
  const logWrap = useRef<HTMLDivElement>(null);
  const typeBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // The mic level, for both talk buttons (the big one and the one in the chat).
    session.onLevel = (level) => appRoot.current?.style.setProperty("--level", level);
    fetch("config").then((r) => r.json()).then((c: Config) => {
      setConfig(c);
      setBook(c.books?.[0]?.id ?? "");
      if (!c.books?.length) {
        // An older server is still running (the page loads fresh, the server doesn't).
        session.showError("The server is running older code. Stop it (Ctrl + C) and run npm start again, then refresh this page.");
      }
      if (c.language) setLang(c.language); // the server's default
      setVoice(c.voice);
    }).catch(() => {});
  }, [session]);

  useEffect(() => {
    session.barge = barge;
  }, [session, barge]);

  /** Escape closes the menu and the chat list. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      setChatsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Keep the newest message in view: inside the conversation panel on wide screens (the page stays put, so the talk button stays in view), the page on phones. */
  useEffect(() => {
    const panel = logWrap.current;
    if (!view.scrollTick || !panel) return;
    if (panel.scrollHeight > panel.clientHeight + 4) panel.scrollTo({ top: panel.scrollHeight, behavior: "smooth" });
    else if (oneColumn.matches) window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }, [view.scrollTick]);

  /** A chat opened (or reopened when the page loads): start at its newest message. */
  useEffect(() => {
    const panel = logWrap.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [view.chatId]);

  // Hear a voice before choosing it.
  function playPreview() {
    previewAudio.current?.pause();
    setPreview("loading");
    const audio = new Audio(`sample?voice=${encodeURIComponent(voice)}`);
    previewAudio.current = audio;
    const done = () => setPreview("ready");
    audio.onplaying = () => setPreview("playing");
    audio.onended = done;
    audio.onerror = () => {
      done();
      session.showError("The voice sample could not be played. Is the server running?");
    };
    audio.play().catch(done);
  }

  /** Ask a typed (or clicked example) question. */
  function ask(text: string) {
    if (!text.trim() || view.awaiting) return;
    session.sendText(text, { lang, voice, book });
    setDraft("");
    typeBox.current?.focus();
  }

  function newChat() {
    session.newChat();
    setChatsOpen(false);
    typeBox.current?.focus();
  }

  function openChat(id: string) {
    session.openChat(id);
    setChatsOpen(false);
  }

  function deleteChat(id: string, title: string) {
    if (window.confirm(`Delete the chat "${title}"? This can't be undone.`)) session.deleteChat(id);
  }

  /** Start or end a voice call (the big talk button and the mic in the chat). */
  function toggleCall() {
    if (view.state === "idle") session.start({ lang, voice, book });
    else session.stop();
  }

  const live = view.state !== "idle"; // the listening language, voice and book are set when a conversation starts
  const chapters = config?.books.find((b) => b.id === book)?.chapters ?? [];
  const voices = config ? (config.voices.some((v) => v.id === config.voice) ? config.voices : [...config.voices, { id: config.voice, label: config.voice }]) : [];
  // The status pill: the call's state; with no call, "Thinking" / "Speaking" while a typed question is answered.
  const tone = view.state !== "idle" ? view.state : view.awaiting ? "thinking" : view.speakingAloud ? "speaking" : "idle";
  // Mute sits under Maki's newest answer.
  const latestAnswer = view.messages.filter((m) => m.who === "maki" && m.text).pop()?.id;
  const thinkingLabel = view.awaitingTeacher ? "Thinking" : config?.agentic ? "Picking the right teacher" : "Thinking";
  // The bar above the typing box during a call.
  const callLabel =
    view.state === "connecting" ? "Connecting…"
    : view.state === "thinking" ? "Maki is thinking…"
    : view.state === "speaking" ? (barge ? "Maki is speaking · talk to interrupt" : "Maki is speaking")
    : view.muted ? "Mic muted · type, or unmute to talk"
    : "Listening · talk or type";

  return (
    <div ref={appRoot} className={`app${menuOpen ? " menu-open" : ""}`} data-state={view.state}>
      <header className="topbar">
        <div className="topbar-inner">
          <button className="icon-btn menu-btn" type="button" aria-label="Open the menu" aria-controls="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            <Icon name="menu" />
          </button>
          <div className="brand">
            <span className="logo" aria-hidden="true"><Icon name="sparkles" /></span>
            <div>
              <h1>Maki AI</h1>
              <p className="sub">Your AI study tutor · talk or type</p>
            </div>
          </div>
          <div className="top-right">
            <span className={`pill${config?.agentic ? " agentic" : ""}`} id="mode">{config ? (config.agentic ? "Agentic mode" : "Direct mode") : "Loading…"}</span>
            <span className="pill status" data-tone={tone} role="status">{STATE_LABEL[tone]}</span>
          </div>
        </div>
      </header>

      <main className="layout">
        {/* Controls: the left column on wide screens; on phones, a menu opened from the navbar. */}
        <section className="side" id="menu" aria-label="Maki AI settings">
          <div className="side-head">
            <span className="side-title">Menu</span>
            <button className="icon-btn" type="button" aria-label="Close the menu" onClick={() => setMenuOpen(false)}>
              <Icon name="close" />
            </button>
          </div>
          <div className="panel setup">
            <div className="panel-title">
              <span className="icon-tile"><Icon name="book" /></span>
              <div>
                <h2>Before you start</h2>
                <p className="panel-hint">Pick a book and how Maki sounds</p>
              </div>
              <span className="lock-note"><Icon name="lock" />Locked while talking</span>
            </div>
            <label className="field" htmlFor="book">
              <span className="field-label">Book</span>
              <select id="book" value={book} disabled={live} onChange={(e) => setBook(e.target.value)}>
                {!config ? <option value="">Loading…</option> : null}
                {config?.books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
                {config && !config.books?.length ? <option value="">No books: restart the server</option> : null}
              </select>
            </label>
            <ul className="chapters" aria-label="Chapters in this book">
              {chapters.map((title) => <li key={title}>{title}</li>)}
            </ul>
            <div className="field">
              <label className="field-label" htmlFor="voice">Maki's voice</label>
              <div className="row">
                <select id="voice" value={voice} disabled={live} onChange={(e) => setVoice(e.target.value)}>
                  {!config ? <option value="">Loading…</option> : null}
                  {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
                <button id="preview" className="btn ghost" type="button" disabled={preview !== "ready"} onClick={playPreview}>
                  <Icon name="play" /><span>{preview === "loading" ? "Loading…" : preview === "playing" ? "Playing…" : "Preview"}</span>
                </button>
              </div>
            </div>
            <label className="field" htmlFor="lang">
              <span className="field-label">Listening language</span>
              <select id="lang" value={lang} disabled={live} onChange={(e) => setLang(e.target.value)}>
                <option value="en">English</option>
                <option value="multi">English + Urdu mix</option>
              </select>
            </label>
            <label className="switch">
              <span>
                <span className="switch-title">Let me interrupt Maki</span>
                <span className="switch-sub">Talk over Maki to stop it</span>
              </span>
              <input type="checkbox" role="switch" checked={barge} onChange={(e) => setBarge(e.target.checked)} />
            </label>
            <ul className="notes">
              <li><Icon name="headphones" />Use headphones so Maki doesn't hear its own voice.</li>
              <li><Icon name="languages" />Choose "English + Urdu mix" only if you mix in Urdu.</li>
            </ul>
          </div>

          <div className="panel flow">
            <div className="panel-title">
              <span className="icon-tile"><Icon name="workflow" /></span>
              <div>
                <h2>How Maki answers</h2>
                <p className="panel-hint">Each question goes to the right expert</p>
              </div>
            </div>
            <div className="router">
              <span className="node"><Icon name="branch" />Decision maker</span>
              <span className="router-note">picks the teacher</span>
            </div>
            <span className="flow-line" aria-hidden="true" />
            {/* One chip per expert teacher; the chosen one lights up (its key changes, so the animation replays). */}
            <ul className="teachers" aria-label="Expert teachers">
              {config?.teachers.map((name) => {
                const active = name === view.teacher;
                return <li key={active ? `${name}-${view.teacherPicks}` : name} className={active ? "chip active" : "chip"}>{name}</li>;
              })}
            </ul>
          </div>

          <div className="panel stats">
            <div className="panel-title">
              <span className="icon-tile"><Icon name="timer" /></span>
              <div>
                <h2>Last reply</h2>
                <p className="panel-hint">From the end of your turn (about {config ? (config.endOfTurnMs / 1000).toFixed(1) : "0.4"} s of silence)</p>
              </div>
            </div>
            <dl className="tiles">
              <div className="tile"><dt>First word</dt><dd>{view.firstWord}</dd><span className="tile-icon"><Icon name="zap" /></span></div>
              <div className="tile"><dt>First sound</dt><dd>{view.firstSound}</dd><span className="tile-icon"><Icon name="volume" /></span></div>
              <div className="tile" title="From when you stopped to when Maki spoke"><dt>Total wait</dt><dd>{view.roundTrip}</dd><span className="tile-icon"><Icon name="timer" /></span></div>
            </dl>
          </div>
        </section>

        <section className={`panel chat${chatsOpen ? " chats-open" : ""}`} aria-label="Conversation">
          {/* Saved chats: beside the conversation on wide screens, a slide-over list on narrow ones. */}
          <aside className="chats" id="chats" aria-label="Your chats">
            <div className="chats-inner">
              <div className="chats-head">
                <span className="chats-title">Your chats</span>
                <button className="btn ghost new-chat" type="button" disabled={view.showEmpty} onClick={newChat}>
                  <Icon name="plus" /><span>New chat</span>
                </button>
              </div>
              {view.chats.length ? (
                <ul className="chat-list">
                  {view.chats.map((c) => (
                    <li key={c.id} className={c.id === view.chatId ? "active" : undefined}>
                      <button className="chat-open" type="button" aria-current={c.id === view.chatId ? "true" : undefined} onClick={() => openChat(c.id)}>
                        <span className="chat-name">{c.title}</span>
                        <span className="chat-meta">{whenUsed(c.updatedAt)} · {c.count} {c.count === 1 ? "message" : "messages"}</span>
                      </button>
                      <button className="chat-delete" type="button" aria-label={`Delete the chat "${c.title}"`} title="Delete chat" onClick={() => deleteChat(c.id, c.title)}>
                        <Icon name="trash" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="chats-empty">Your conversations will be listed here, so you can come back to them.</p>
              )}
              <p className="chats-note"><Icon name="lock" />Saved in this browser only</p>
            </div>
          </aside>
          <button className="chats-scrim" type="button" aria-label="Close the chat list" tabIndex={-1} onClick={() => setChatsOpen(false)} />
          <div className="chat-main">
            <div className="chat-head">
              <div className="panel-title">
                <span className="icon-tile"><Icon name="message" /></span>
                <div>
                  <h2 className="chat-heading">{view.chatTitle}</h2>
                  <p className="panel-hint">
                    {config ? (config.agentic ? `Agentic: decision maker → ${config.teachers.length} expert teachers` : `AI: ${config.model} (direct)`) : "–"}
                  </p>
                </div>
                <button className="btn ghost chats-toggle" type="button" aria-controls="chats" aria-expanded={chatsOpen} onClick={() => setChatsOpen((open) => !open)}>
                  <Icon name="history" /><span>Chats</span>
                  {view.chats.length ? <span className="count">{view.chats.length}</span> : null}
                </button>
              </div>
            </div>
            <div ref={logWrap} className="log-wrap">
              <ol className="log" aria-live="polite">
                {/* Maki's empty bubble (no words yet) is shown as the thinking loader below. */}
                {view.messages.filter((m) => m.who === "you" || m.text).map((m) => {
                  const playing = view.playingId === m.id;
                  const writing = view.streamingId === m.id;
                  return (
                    <li key={m.id} className={`msg ${m.who}${m.live ? " live" : ""}${m.aside ? " aside" : ""}${m.cut ? " cut" : ""}${playing ? " playing" : ""}`}>
                      <span className="who">
                        {m.who === "you" ? "You" : m.teacher ? `Maki · ${m.teacher}` : "Maki"}
                        {playing && view.speakingAloud ? <span className="eq msg-eq" aria-hidden="true"><i /><i /><i /><i /></span> : null}
                      </span>
                      <span className="text">{m.who === "maki" && !m.plain ? <FormulaText raw={m.text} /> : m.text}</span>
                      {/* Under Maki's answers: Replay (Stop while it plays), and Mute under the newest one. */}
                      {m.who === "maki" && (!writing || m.id === latestAnswer) ? (
                        <span className="msg-actions">
                          {!writing ? (
                            <button
                              className="msg-action"
                              type="button"
                              disabled={live}
                              title={live ? "End the call to replay" : playing ? "Stop" : "Hear this answer again"}
                              aria-label={playing ? "Stop playing this answer" : "Replay this answer"}
                              onClick={() => session.replay(m.id, voice)}
                            >
                              <Icon name={playing && !view.replayLoading ? "square" : "replay"} />
                              <span>{playing ? (view.replayLoading ? "Loading…" : "Stop") : "Replay"}</span>
                            </button>
                          ) : null}
                          {m.id === latestAnswer ? (
                            <button
                              className="msg-action"
                              type="button"
                              aria-pressed={view.voiceOff}
                              title={view.voiceOff ? "Maki's answers are shown but not spoken" : "Stop Maki's voice (answers are still shown)"}
                              onClick={() => session.toggleVoice()}
                            >
                              <Icon name={view.voiceOff ? "volumeOff" : "volume"} />
                              <span>{view.voiceOff ? "Unmute" : "Mute"}</span>
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
                {view.awaiting ? (
                  <li className="msg maki thinking">
                    <span className="who">{view.awaitingTeacher ? `Maki · ${view.awaitingTeacher}` : "Maki"}</span>
                    <span className="thinking-row">
                      <span className="dots" aria-hidden="true"><i /><i /><i /></span>
                      <span className="thinking-text">{thinkingLabel}…</span>
                    </span>
                  </li>
                ) : null}
              </ol>
              <div className="empty" hidden={!view.showEmpty}>
                <span className="empty-avatar" aria-hidden="true"><Icon name="sparkles" /></span>
                <p className="empty-title">Ask Maki anything you're studying</p>
                <p>Tap the mic to talk, or type below: any subject, homework or exam prep. Try one:</p>
                <ul className="examples">
                  {EXAMPLES.map((q) => (
                    <li key={q}><button type="button" onClick={() => ask(q)}>{q}</button></li>
                  ))}
                </ul>
              </div>
            </div>
            {view.error ? <p className="error chat-error" role="alert">{view.error}</p> : null}
            {/* During a call: what Maki is doing, the mic level, and mute. */}
            {live ? (
              <div className="callbar">
                <span className="call-state" aria-live="polite">
                  <span className="eq" aria-hidden="true"><i /><i /><i /><i /><i /></span>
                  {callLabel}
                </span>
                <button className="btn ghost call-mute" type="button" disabled={view.state === "connecting"} aria-pressed={view.muted} onClick={() => session.toggleMute()}>
                  <Icon name={view.muted ? "micOff" : "mic"} /><span>{view.muted ? "Unmute mic" : "Mute mic"}</span>
                </button>
              </div>
            ) : null}
            <form className="composer" onSubmit={(e) => { e.preventDefault(); ask(draft); }}>
              <button
                className="mic"
                type="button"
                aria-label={live ? "End the voice call" : "Start talking to Maki"}
                title={live ? "End the voice call" : "Start talking"}
                onClick={toggleCall}
              >
                <Icon name="mic" className="start" />
                <Icon name="square" className="stop" />
              </button>
              <textarea
                ref={typeBox}
                rows={1}
                value={draft}
                maxLength={1000}
                placeholder={live ? "Type, or keep talking…" : "Type a question for Maki…"}
                aria-label="Type a question for Maki"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift + Enter starts a new line.
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    ask(draft);
                  }
                }}
              />
              <button className="send" type="submit" disabled={!draft.trim() || view.awaiting} aria-label="Send">
                <Icon name="send" />
              </button>
            </form>
          </div>
        </section>
      </main>
      <button className="menu-scrim" type="button" aria-label="Close the menu" tabIndex={-1} onClick={() => setMenuOpen(false)} />
    </div>
  );
}
