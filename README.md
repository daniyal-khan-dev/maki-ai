# Maki AI: two-way voice study tutor

A small, separate demo of **option 1**: we build the conversation loop ourselves from three services.

```
Student talks ─▶ Deepgram listening (live) ─▶ AI writes the answer (streamed) ─▶ Deepgram voice ─▶ Student hears
      ▲                                                                                              │
      └─────────────── the mic stays open; talking over Maki stops it ◀───────────────────────────────┘
```

- **Listening:** Deepgram Nova-3, live. English by default; the page can switch to "English + Urdu mix". It decides when the student has finished after 0.4 s of silence. Deepgram's "finished" signal sometimes comes 7–8 s late, so there's a backup: if the mic has been quiet for 1.2 s and the caption ends like a sentence, the turn is over.
- **Answer: an agentic workflow on Mistral's Agents API** (see below). If the agents aren't available, Maki answers directly with one model (`lib/models.ts`), so it never goes silent.
- **Talking and typing, all in the chat:** the mic button beside the typing box starts and ends a call (while it's on, a bar above the box shows Listening / Thinking / Speaking with the mic level, and **Mute mic**). The box sends a typed question (Enter sends, Shift + Enter for a new line; the example questions can be clicked); typing over Maki in a call stops it, like talking over it. The connection stays open between calls, so Maki remembers the whole conversation, spoken and typed.
- **Typed answers are spoken too**, with no call and no microphone. Under each answer, **Replay** says it again (**Stop** while it plays): instantly from memory if it was just spoken, otherwise the server makes the voice again (`POST /speak`, streamed, limited to 40 replays per visitor per 10 minutes). **Mute** under the newest answer keeps Maki quiet (answers are still shown) until unmuted; the choice is remembered in the browser.
- **Phones:** only the conversation shows, full screen with the typing box at the bottom; the settings, teacher flow and timings are in the menu (☰) in the navbar.
- **Saved chats:** every conversation is saved in the browser as it goes (`client/src/chatStore.ts`, localStorage), so a refresh, a closed tab or a lost connection doesn't lose it. "Your chats" lists them beside the conversation (behind a **Chats** button on narrow screens and phones): open one to carry on (the server is given its history, so Maki remembers it), start a **New chat**, or delete one. Chats stay on that device and browser; nothing is stored on the server. The last 50 chats are kept.
- **Any study topic:** "Any subject (no book)" is the default; any school or university subject, homework, exam prep, study skills and careers are fine. Questions with nothing to do with studying are kindly steered back.
- **Thinking loader:** until Maki's first word, the conversation shows an animated bubble ("Picking the right teacher…", then the teacher's name). The page also shows a loading screen while it starts.

## Agentic workflow (decision maker → expert teacher)

```
Student asks a question (any subject, or with a book picked, e.g. Additional Mathematics)
        │
  Maki Decision Maker  (main agent, Mistral open-mistral-nemo; never answers itself)
        │  hands over the full context: the book and its chapters (if any), and the conversation
        ▼
  Expert teacher = Maki's brain for that subject, answering in Maki's voice and style
    Maths · Physics · Chemistry · Computer Science            (ministral-8b, best at formulas)
    Biology · English · Humanities · Economics & Business
    · Study helper                                            (open-mistral-nemo, fastest and chattiest)
```

- Built on Mistral **agent hand-offs**: the decision maker passes the conversation to the teacher on Mistral's side, and the teacher's answer streams back word by word into the voice.
- The **book is background**: the decision maker uses it to pick the teacher; the teacher links to a chapter when the question is about it. A question from another subject goes to that subject's teacher ("What is Ohm's law?" with the maths book open goes to the Physics teacher).
- History, geography, Pakistan Studies, Islamiat and general knowledge go to the **Humanities teacher**; economics, business and accounting to the **Economics & Business teacher**.
- Greetings, study tips, careers, anything that isn't about studying (kindly steered back), and **garbled (misheard) questions** go to the **Study helper**, who asks the student to say it again.
- The page shows which teacher answered: "Maki · Physics teacher".
- **Our own history** is sent each turn (`store: false`), so the agents only see what the student actually heard when they cut Maki off.
- **Safety nets:** if the decision maker answers itself instead of handing over, or the agents fail or are rate-limited, Maki answers directly.
- The agents are created in the Mistral account on the first start and reused (ids in `.agents.json`), and re-created automatically when their instructions change. `npm run agents:delete` removes them.
- **Dummy books** are in `data/books.json` (six O Level books with chapters and key formulas). In the LMS, these would come from the real courses.

Measured (28 Oct 2026, free Mistral plan): right teacher **9/10** on new typed questions (the 10th was genuinely ambiguous) and **4/4** by voice; the hand-over adds about 0.3–0.5 s, so Maki's first word arrives about 1.1–1.3 s after the student stops.
- **Voice:** Deepgram Aura-2, picked on the page with **Preview voice**: Luna (default), Helena, Minerva, Delia, Andromeda, Apollo, Arcas, and British Pandora and Draco. Each phrase is spoken as soon as it is written; the next is prepared while the current one plays. Deepgram's 0.24–0.37 s of silence at the start of each phrase is trimmed, so Maki starts sooner and pauses evenly (about 0.15–0.35 s) between phrases.
- **Natural interruptions (modelled on Vapi's stop-speaking plan):**
  - as soon as the student's voice is heard for 0.2 s, Maki's voice **dips**;
  - real words make Maki **fade out** and stop; "okay", "yeah", "mm-hmm", "haan", "acha" don't: Maki **keeps going**;
  - if it was only a cough or noise, the voice **comes back** after about 1.2 s;
  - the browser tells the server **exactly what the student heard**, so Maki doesn't repeat itself and reacts to the new question ("Oh, got it!").
- **Natural speaking (following Vapi's prompting guide):** instructions in Vapi's structure (identity, style, guidelines, examples of how Maki sounds). Short turns, contractions, light fillers ("so", "well"), one question at a time, matching the student's energy. Reactions vary ("Oh, totally!", "Ah, I see!", "Ooh, good one.") and the server tells the AI how its last replies began, so it doesn't start the same way twice; a repeated "Great question!" is dropped. A turn is capped at 3 sentences (4 with a formula), because the small free models ignore "keep it short". Dashes and bracketed asides are spoken as natural pauses. The quick reaction plays on its own straight away, then the rest follows in phrases of a couple of sentences.
- **Formulas (maths, physics, chemistry, computing):** Maki teaches a formula the way a teacher does: says the formula, says what each letter means (with units), then gives a quick example. It writes each formula as `{{written form|spoken form}}`: the page shows the formula (`F = m × a`, `H₂O`, `O(n log n)`) and the voice says it ("F equals m times a", "H two O", "big O of n log n"). Symbols that slip through (², ₂, ×, √, Δ, →, °C, `^`) are turned into words, and chemical formulas are spelled out ("C O 2").
- **Unfinished sentences:** if the listening says "finished" but the sentence has no end punctuation ("…what photosynthesis"), Maki waits up to 0.9 s for the rest ("…is?") before answering.
- **Late words aren't a new question:** if the last words of a question arrive after Maki has started (and the mic has been quiet since), they're added to that question; if Maki hasn't spoken yet, it answers the whole question.
- **Maki ignores its own voice:** without headphones its voice can reach the mic. Words that repeat what Maki is saying are ignored, and while Maki talks the student must be clearly louder than that echo to stop it.
- **Short failures are retried:** a "rate limited" AI is asked again (then with a lighter model), and a failed voice request is retried once.
- **Why Maki stopped** is printed in the server terminal: `[maki] stopped: new question "…"`, `[maki] stopped: the student talked over it ("…")`, `[maki] ignored its own voice …`, `[maki] late end of the last question added …`.
- API keys stay on the server. The browser only talks to `/ws` on this server.

## Run it

1. Install Node 20 or newer.
2. `npm install`
3. Copy `.env.example` to `.env` and add two keys (both have free plans):
   - `DEEPGRAM_API_KEY`: [console.deepgram.com](https://console.deepgram.com) (new accounts get $200 of free credit)
   - `LLM_API_KEY`: [console.mistral.ai](https://console.mistral.ai) (free "Experiment" plan). Groq and Gemini also work; see `.env.example`.
4. `npm start`, then open **http://localhost:3010** in Chrome or Edge. (The server runs with `tsx`, and Vite serves the page with live reload.)
5. Type a question in the box under the conversation, or press the **mic** beside it, allow the microphone and talk (use headphones so Maki doesn't hear its own voice).

To check a full conversation without a browser (server running): `npm run test:turn`.
To check how Maki explains and says formulas (no server needed): `npm run test:formulas`.
To check that Maki ignores its own voice coming back through the mic (server running): `npm run test:echo`.
To check which teacher the decision maker picks (server running): `npm run test:agents`.
To type-check everything: `npm run check`.
To run a production copy of the page: `npm run build`, then `npm run serve`.

## Files

Everything is TypeScript, like the LMS: the server and its modules run with `tsx`; the page is React (`.tsx`), served by Vite.

| File | What it does |
|---|---|
| `server.ts` | The loop: live listening, end of turn, streamed answer, sentence-by-sentence voice, interruptions |
| `lib/prompt.ts` | Maki's instructions: how to talk, how to teach formulas, how to handle interruptions |
| `lib/speech.ts` | Turns the written answer into what the voice says (formulas, symbols, chemical formulas, dashes) |
| `lib/agents.ts` | The agentic workflow: the decision maker and the expert teachers on Mistral's Agents API |
| `lib/books.ts`, `data/books.json` | The dummy books and the background given to the agents |
| `lib/models.ts` | The direct (non-agentic) fallback: picks the AI model per question |
| `client/src/App.tsx`, `style.css` | The page (React): talk button, book and voice setup, which teacher is answering, conversation, timings (two columns on desktop, one on phones) |
| `client/src/FormulaText.tsx`, `icons.tsx` | Formulas in Maki's text; the icons |
| `client/src/voiceSession.ts` | Microphone streaming, gapless playback, interruptions, typed questions; keeps the conversation the page shows |
| `client/index.html`, `client/public/favicon.svg` | The page shell with its loading screen; the favicon |
| `client/src/mic-worklet.ts` | Converts the microphone to 16 kHz audio for Deepgram |
| `scripts/test-turn.ts` | End-to-end test that "speaks" questions into the demo |
| `scripts/test-formulas.ts` | Asks formula questions across subjects; shows what's on screen and what's spoken |
| `scripts/test-echo.ts` | Feeds Maki's voice back into the mic, like speakers without headphones |
| `scripts/test-agents.ts` | Asks questions from different subjects by voice and checks which teacher answered |
| `scripts/delete-agents.ts` |
| `vite.config.ts`, `tsconfig.json`, `client/tsconfig.json` | Page build and type-check settings | Removes the agents from the Mistral account |

## Measured (from Pakistan, `npm run test:turn`, 28 Oct 2026)

| Step | Time |
|---|---|
| Student stops → Maki knows the turn is over | 0.9–1.2 s (up to 2.3 s when the backup is needed) |
| Turn over → AI's first word | 0.4–1.1 s |
| Turn over → Maki's first sound | 1.2–2.4 s |
| Gaps inside an answer | none (next sentence is ready before the current one ends) |
| Student asks something new while Maki is talking | Maki stops and answers the new question |

## Settings (`.env`)

| Setting | Default | What it changes |
|---|---|---|
| `STT_LANGUAGE` | `en` | Default listening language; the page can switch per conversation. `en` always writes English. `multi` follows Urdu/English mixing, but with some accents it switches language on plain English |
| `KEYTERMS` | `Maki` | Names the listening should catch |
| `END_OF_TURN_MS` | `400` | Silence that ends a turn. Lower is faster, higher cuts students off less |
| `STABLE_TURN_MS` / `MAX_QUIET_MS` | `1200` / `3000` | Backup end of turn, for finished / unfinished-looking captions |
| `NO_PUNCTUATION_WAIT_MS` | `900` | Extra wait when a "finished" sentence has no end punctuation |
| `VOICE_RMS` | `350` | How loud the mic must be to count as speaking (raise it in noisy rooms) |
| `TTS_VOICE` | `aura-2-luna-en` | Default voice (the page can switch it) |
| `AGENTIC` | on | `false` turns the agentic workflow off (Maki answers directly) |
| `ROUTER_MODEL` | `open-mistral-nemo` | The decision maker's model (`ministral-3b-latest` is faster, slightly less accurate) |
| `LLM_MODEL` | `open-mistral-nemo` | The AI for normal chat (and the chatty teachers) |
| `FORMULA_MODEL` | `ministral-8b-latest` | The AI for maths/science/computing (and those teachers; empty = always `LLM_MODEL`) |
| `MAX_SENTENCES` | `3` | Longest turn in sentences (one more when it gives a formula) |

## Cost (pay-as-you-go prices, October 2026)

About **$0.02 per minute** of conversation: listening ~$0.0058/min, AI ~$0.0015/min, voice $30 per million characters (~$0.014/min).

## Known limits

- About 2–3 seconds between the student finishing and Maki's first sound: about 1 s to be sure the turn is over, then the first sentence and its voice.
- "English + Urdu mix" can switch language on plain English with some accents (English came out in Hindi/Urdu script). Keep "English" unless students mix in Urdu.
- Free AI plans are rate-limited. If Maki says "rate-limited", wait a few seconds.
- Without headphones, Maki's voice can reach the mic. Browser echo cancellation usually handles it. If Maki keeps stopping itself, untick **Let me interrupt Maki**: the mic then closes while Maki speaks.
- Maki replies in English. The voice cannot speak Urdu.
- This is a demo: there's no login, no course content and nothing is saved.
