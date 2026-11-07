// Asks Maki's AI formula questions (maths, physics, chemistry, computing) with Maki's real
// instructions, then shows what the page displays and what the voice says, and flags any
// symbol the voice would still have to read out. No server or microphone needed.
// Run: npm run test:formulas
import "dotenv/config";
import { SYSTEM_PROMPT } from "../lib/prompt";
import { toSpeech, FORMULA } from "../lib/speech";
import { modelFor } from "../lib/models";

const BASE = (process.env.LLM_BASE_URL || "https://api.mistral.ai/v1").replace(/\/+$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const QUESTIONS = [
  "What is Newton's second law?",
  "How do I find the speed of a car?",
  "Explain the Pythagoras theorem.",
  "What's the quadratic formula?",
  "What is the chemical formula of water and how is water made?",
  "What is the equation for photosynthesis?",
  "What does big O of n log n mean in computing?",
  "What is Ohm's law?",
];

async function ask(question: string): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelFor(question), max_tokens: 280, temperature: 0.6, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: question }] }),
  });
  if (!res.ok) throw new Error(`AI ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0].message.content;
}

const onScreen = (raw: string) => raw.replace(/[*_#`]/g, "").replace(/\{\{([^{}|]*)(?:\|[^{}]*)?\}\}/g, "[$1]");
let withFormula = 0;
let cleanSpeech = 0;
for (const q of QUESTIONS) {
  let raw: string;
  try {
    raw = await ask(q);
  } catch (e) {
    console.log(`\nQ: ${q}\n   ERROR ${(e as Error).message}`);
    await sleep(3000);
    continue;
  }
  const speech = toSpeech(raw);
  const formulas = [...raw.matchAll(FORMULA)].length;
  const leftovers = speech.match(/[=+×÷^²³₀-₉√Δ→{}|\\]/g);
  if (formulas) withFormula++;
  if (!leftovers) cleanSpeech++;
  console.log(`\nQ: ${q}`);
  console.log(`   screen: ${onScreen(raw).replace(/\s+/g, " ")}`);
  console.log(`   voice:  ${speech}`);
  console.log(`   formulas marked: ${formulas}${leftovers ? ` | symbols left for the voice: ${[...new Set(leftovers)].join(" ")}` : " | voice text clean"}`);
  await sleep(1500); // free plan rate limit
}
console.log(`\nSummary: ${withFormula}/${QUESTIONS.length} answers used the formula format, ${cleanSpeech}/${QUESTIONS.length} had nothing the voice can't say.`);
