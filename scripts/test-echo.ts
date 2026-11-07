// Echo check: what happens without headphones, when Maki's own voice leaks back into the mic.
// Asks a question, then feeds Maki's answer audio back into the "microphone" at half volume
// while Maki talks. Maki should NOT treat its own words as a new question, and should finish.
// Run with the server started (npm start), then: npm run test:echo
import "dotenv/config";
import WebSocket from "ws";

const PORT = Number(process.env.PORT || 3010);
const KEY = process.env.DEEPGRAM_API_KEY;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAME = 1280; // 40 ms of 16 kHz 16-bit audio

async function voiceOf(text: string): Promise<Buffer> {
  const r = await fetch("https://api.deepgram.com/v1/speak?model=aura-2-draco-en&encoding=linear16&sample_rate=16000&container=none", {
    method: "POST",
    headers: { Authorization: `Token ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return Buffer.from(await r.arrayBuffer());
}

/** Maki's 24 kHz voice -> 16 kHz "mic" audio at half volume (2 of every 3 samples). */
function asMicEcho(pcm24: Buffer): Buffer {
  const inSamples = pcm24.length >> 1;
  const out = Buffer.alloc(Math.floor((inSamples * 2) / 3) * 2);
  for (let o = 0, i = 0; o + 1 < out.length; o += 2, i += 1.5) {
    out.writeInt16LE(Math.round(pcm24.readInt16LE(Math.floor(i) * 2) * 0.5), o);
  }
  return out;
}

let echoing = false;
let makiAudio = Buffer.alloc(0);
const events = { user: [] as string[], echo: [] as string[], tail: [] as string[], ended: 0, errors: [] as string[] };
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    makiAudio = Buffer.concat([makiAudio, data as Buffer]);
    return;
  }
  const ev = JSON.parse(data.toString());
  if (ev.type === "user") events.user.push(ev.text);
  if (ev.type === "echo") events.echo.push(ev.text);
  if (ev.type === "user-tail") events.tail.push(ev.text);
  if (ev.type === "assistant-end") events.ended++;
  if (ev.type === "error") events.errors.push(ev.message);
});

ws.on("open", async () => {
  const quiet = Buffer.alloc(FRAME);
  let speaking = false;
  const mic = setInterval(() => !speaking && !echoing && ws.readyState === 1 && ws.send(quiet), 40);
  try {
    await new Promise((resolve) => ws.once("message", resolve)); // ready
    const q = await voiceOf("Maki, can you explain how a rainbow is formed?");
    speaking = true;
    for (let i = 0; i < q.length; i += FRAME) {
      ws.send(q.subarray(i, i + FRAME));
      await sleep(40);
    }
    speaking = false;

    // Wait for Maki's voice, then play it back into the mic for ~6 s, in real time, like speakers.
    const t0 = Date.now();
    while (makiAudio.length < 48000 && Date.now() - t0 < 15000) await sleep(50);
    ws.send(JSON.stringify({ type: "playback", speaking: true }));
    echoing = true;
    let sentEcho = 0;
    while (sentEcho < 150 && ws.readyState === 1) { // 150 frames = 6 s
      const echo = asMicEcho(makiAudio);
      const frame = echo.subarray(sentEcho * FRAME, (sentEcho + 1) * FRAME);
      ws.send(frame.length === FRAME ? frame : quiet);
      sentEcho++;
      await sleep(40);
    }
    echoing = false;
    await sleep(4000);
    ws.send(JSON.stringify({ type: "playback", speaking: false }));
    await sleep(1500);
  } finally {
    clearInterval(mic);
    console.log(`Questions Maki took from the student: ${events.user.length} -> ${JSON.stringify(events.user)}`);
    console.log(`Maki's own voice recognised and ignored: ${events.echo.length} -> ${JSON.stringify(events.echo)}`);
    console.log(`Late words joined to the question: ${JSON.stringify(events.tail)}`);
    console.log(`Answers finished: ${events.ended}${events.errors.length ? ` | errors: ${events.errors.join("; ")}` : ""}`);
    console.log(events.user.length === 1 && events.ended >= 1 ? "PASS: Maki ignored its own voice and finished its answer" : "CHECK: Maki treated its own voice as a question");
    ws.close();
  }
});
