// End-to-end check without a browser. It "speaks" into the demo in real time like a microphone
// (silence streams between questions, as a real mic does) and plays the browser's part:
//   1. asks a question, and says "Okay." while Maki answers  -> Maki should keep going
//   2. asks a second question, and cuts in while Maki answers -> Maki should stop, and the server
//      is told only the words that were "heard"
//   3. the cut-in question                                   -> Maki should react, not repeat itself
// Run with the server started (npm start), then: npm run test:turn
import "dotenv/config";
import WebSocket from "ws";

const PORT = Number(process.env.PORT || 3010);
const KEY = process.env.DEEPGRAM_API_KEY;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A spoken question as 16 kHz 16-bit PCM, made with Deepgram's own voice. */
async function voiceOf(text: string): Promise<Buffer> {
  const r = await fetch("https://api.deepgram.com/v1/speak?model=aura-2-draco-en&encoding=linear16&sample_rate=16000&container=none", {
    method: "POST",
    headers: { Authorization: `Token ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`could not make test audio: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Like a real microphone, the stream never stops: silence is sent whenever nothing is being said.
const FRAME = 1280; // 40 ms at 16 kHz, 16-bit
let speaking = false;
let spokeUntil = 0;
function startMic(ws: WebSocket) {
  const quiet = Buffer.alloc(FRAME);
  return setInterval(() => {
    if (!speaking && ws.readyState === WebSocket.OPEN) ws.send(quiet);
  }, 40);
}
async function say(ws: WebSocket, pcm: Buffer) {
  speaking = true;
  for (let i = 0; i < pcm.length; i += FRAME) {
    ws.send(pcm.subarray(i, i + FRAME));
    await sleep(40);
  }
  speaking = false;
  spokeUntil = Date.now();
}

interface Turn {
  heard: string;
  answer: string;
  phrases: string[];
  audioBytes: number;
  ended: boolean;
  turnSeenMs: number;
  aiFirstWordMs?: number;
  firstAudioMs?: number;
  reportedHeard?: string;
}

const turns: Turn[] = [];
const backchannels: string[] = [];
let current: Turn | null = null;
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    if (current) current.audioBytes += (data as Buffer).length;
    return;
  }
  const ev = JSON.parse(data.toString());
  if (ev.type === "user") {
    current = { heard: ev.text, answer: "", phrases: [], audioBytes: 0, ended: false, turnSeenMs: Date.now() - spokeUntil };
    turns.push(current);
  } else if (ev.type === "assistant-delta" && current) current.answer += ev.text;
  else if (ev.type === "phrase" && current) current.phrases.push(ev.text);
  else if (ev.type === "metrics" && current) Object.assign(current, ev);
  else if (ev.type === "assistant-end" && current) Object.assign(current, ev, { ended: true, answer: ev.text ?? current.answer }); // what was actually said
  else if (ev.type === "backchannel") backchannels.push(ev.text);
  else if (ev.type === "error") console.log("ERROR from demo:", ev.message);
  else if (ev.type === "hearing" && process.env.SHOW_HEARING) console.log("  hearing:", ev.text);
});

ws.on("open", async () => {
  let mic: NodeJS.Timeout | undefined;
  try {
    await new Promise((resolve) => ws.once("message", resolve)); // "ready"
    mic = startMic(ws);
    const [q1, okay, q2, q3] = await Promise.all([
      voiceOf("Maki, can you explain what photosynthesis is?"),
      voiceOf("Okay."),
      voiceOf("And how do plants use the sunlight exactly?"),
      voiceOf("Wait, what is chlorophyll?"),
    ]);

    // 1. Question, then "Okay." while Maki is talking.
    await say(ws, q1);
    await waitFor(() => turns[0]?.audioBytes > 0, 20000, "Maki to start answer 1");
    ws.send(JSON.stringify({ type: "playback", speaking: true })); // the browser is playing Maki
    await sleep(800);
    await say(ws, okay);
    await waitFor(() => turns[0]?.ended, 20000, "Maki to finish answer 1");
    await sleep(2500); // let the "okay" be processed
    ws.send(JSON.stringify({ type: "playback", speaking: false }));

    // 2. Second question; cut in about 1.5 s into Maki's answer.
    await say(ws, q2);
    await waitFor(() => turns[1]?.audioBytes > 0, 20000, "Maki to start answer 2");
    ws.send(JSON.stringify({ type: "playback", speaking: true }));
    await sleep(1500);
    const heard = turns[1].phrases[0]?.split(/\s+/).slice(0, 6).join(" ") || "";
    ws.send(JSON.stringify({ type: "interrupt", heard })); // what the browser would report
    turns[1].reportedHeard = heard;
    await say(ws, q3);

    // 3. The cut-in question gets its own answer.
    await waitFor(() => turns[2]?.ended, 20000, "Maki to answer the cut-in question");
    await sleep(500);
  } catch (e) {
    console.error("TEST FAILED:", (e as Error).message);
  } finally {
    clearInterval(mic);
    report();
    ws.close();
  }
});

function report() {
  console.log(`\n"Okay." said while Maki talked: ${backchannels.length ? `treated as listening (${JSON.stringify(backchannels)}), Maki kept going` : "NOT recognised as listening"}`);
  console.log(`Turns: ${turns.length} (expected 3)`);
  turns.forEach((t, i) => {
    console.log(`\nTurn ${i + 1}`);
    console.log(`  Maki heard:   "${t.heard}"`);
    console.log(`  Maki said:    "${t.answer.trim().replace(/\s+/g, " ")}"`);
    console.log(`  Phrases:      ${t.phrases.length} -> ${t.phrases.map((p) => `[${p.length} chars]`).join(" ")}`);
    if (t.reportedHeard !== undefined) console.log(`  Cut off; heard: "${t.reportedHeard} —"`);
    console.log(`  Turn noticed: ${t.turnSeenMs} ms after the audio ended | first word ${t.aiFirstWordMs ?? "–"} ms | first sound ${t.firstAudioMs ?? "–"} ms | finished: ${t.ended ? "yes" : "no (cut off)"}`);
  });
}

async function waitFor(check: () => unknown, timeoutMs: number, what: string) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
