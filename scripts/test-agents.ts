// Agentic workflow check: with the "Additional Mathematics" book selected, speaks questions from
// different subjects into the demo (like a microphone) and reports which teacher the decision
// maker handed each one to, what Maki said, and how long it took.
// Run with the server started (npm start), then: npm run test:agents
import "dotenv/config";
import WebSocket from "ws";

const PORT = Number(process.env.PORT || 3010);
const KEY = process.env.DEEPGRAM_API_KEY;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAME = 1280;

const QUESTIONS = [
  { say: "Maki, what's the quadratic formula?", expect: "Maths teacher" },
  { say: "Hi Maki, how are you today?", expect: "Study helper" },
  { say: "Why are leaves green?", expect: "Biology teacher" },
  { say: "What is Ohm's law?", expect: "Physics teacher" },
  { say: "What caused the First World War?", expect: "Humanities teacher" },
  { say: "What is inflation?", expect: "Economics & Business teacher" },
];

async function voiceOf(text: string): Promise<Buffer> {
  const r = await fetch("https://api.deepgram.com/v1/speak?model=aura-2-draco-en&encoding=linear16&sample_rate=16000&container=none", {
    method: "POST",
    headers: { Authorization: `Token ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return Buffer.from(await r.arrayBuffer());
}

interface Turn {
  heard: string;
  teacher: string;
  answer: string;
  ended: boolean;
  asked: number;
  aiFirstWordMs?: number;
  firstAudioMs?: number;
}

const turns: Turn[] = [];
let current: Turn | null = null;
let spokeUntil = 0;
const ws = new WebSocket(`ws://localhost:${PORT}/ws?book=add-maths`);
ws.on("message", (data, isBinary) => {
  if (isBinary) return;
  const ev = JSON.parse(data.toString());
  if (ev.type === "user") turns.push((current = { heard: ev.text, teacher: "", answer: "", ended: false, asked: spokeUntil }));
  else if (ev.type === "agent" && current) current.teacher = ev.teacher;
  else if (ev.type === "assistant-delta" && current) current.answer += ev.text;
  else if (ev.type === "metrics" && current) Object.assign(current, ev);
  else if (ev.type === "assistant-end" && current) Object.assign(current, ev, { ended: true, answer: ev.text ?? current.answer });
  else if (ev.type === "error") console.log("ERROR from demo:", ev.message);
});

ws.on("open", async () => {
  let speaking = false;
  const quiet = Buffer.alloc(FRAME);
  const mic = setInterval(() => !speaking && ws.readyState === 1 && ws.send(quiet), 40);
  try {
    await new Promise((resolve) => ws.once("message", resolve)); // ready
    const clips = await Promise.all(QUESTIONS.map((q) => voiceOf(q.say)));
    for (let i = 0; i < clips.length; i++) {
      speaking = true;
      for (let j = 0; j < clips[i].length; j += FRAME) {
        ws.send(clips[i].subarray(j, j + FRAME));
        await sleep(40);
      }
      speaking = false;
      spokeUntil = Date.now();
      const end = Date.now() + 25000;
      while (!turns[i]?.ended && Date.now() < end) await sleep(100);
      await sleep(1500); // free plan: space the questions out
    }
  } finally {
    clearInterval(mic);
    let right = 0;
    turns.forEach((t, i) => {
      const q = QUESTIONS[i];
      if (t.teacher === q?.expect) right++;
      console.log(`\n${i + 1}. Student: "${t.heard}"`);
      console.log(`   Decision maker -> ${t.teacher || "?"}${q ? (t.teacher === q.expect ? "  (right teacher)" : `  (expected ${q.expect})`) : ""}`);
      console.log(`   Maki: "${t.answer.trim().replace(/\s+/g, " ")}"`);
      console.log(`   first word ${t.aiFirstWordMs ?? "–"} ms | first sound ${t.firstAudioMs ?? "–"} ms after the turn ended`);
    });
    console.log(`\nRight teacher: ${right}/${QUESTIONS.length}`);
    ws.close();
  }
});
