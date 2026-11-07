// Maki as an agentic workflow on Mistral's Agents API:
//
//   Student's question + selected book
//            │
//   Maki Decision Maker (main agent, never answers itself)
//            │  hand-off with the full context (book, chapters, conversation)
//            ▼
//   Expert teacher agent (maths, physics, chemistry, biology, computer science, English, or the
//   general study helper): Maki's brain for that subject, answering in Maki's voice and style.
//
// The agents are created once in the Mistral account and reused; their ids are cached in
// .agents.json and they are only re-created when their instructions or models change.
// `npm run agents:delete` removes them.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { SYSTEM_PROMPT } from "./prompt";
import { LLM_MODEL, FORMULA_MODEL } from "./models";

const API = (process.env.LLM_BASE_URL || "https://api.mistral.ai/v1").replace(/\/+$/, "");
const KEY = process.env.LLM_API_KEY || "";
const CACHE = new URL("../.agents.json", import.meta.url);
const ANSWER_STALL_MS = 15_000; // an answer that stops arriving for this long is given up

// The decision maker only picks a teacher. Measured on 10 new questions (28 Oct 2026):
// open-mistral-nemo picked the right teacher 9/10 (the 10th, "formula for power?" with the maths
// book open, is genuinely ambiguous) with a 0.9 s hand-over; ministral-3b got 8/10 in 0.6 s.
// Picking the right teacher is the point, so nemo it is (ROUTER_MODEL=ministral-3b-latest for speed).
const ROUTER_MODEL = process.env.ROUTER_MODEL || "open-mistral-nemo";
const FORMULA = FORMULA_MODEL || LLM_MODEL; // careful with formulas
const CHAT = LLM_MODEL; // fastest, chattiest

export interface Expert {
  key: string;
  label: string;
  model: string;
  about: string;
}

/** The agents in the Mistral account (also what .agents.json holds). */
export interface Agents {
  hash: string;
  routerId: string;
  experts: Record<string, string>;
  labels: Record<string, string>;
  createdAt: string;
}

/** One turn of the conversation, as the agents get it. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** An error from Mistral: `status` is the HTTP status; `noHandoff` means the decision maker didn't hand over. */
export type AgentError = Error & { status?: number; noHandoff?: boolean };

interface AgentEvent {
  type: string;
  next_agent_name?: string;
  content?: string | { text?: string }[];
}

export const EXPERTS: Expert[] = [
  { key: "maths", label: "Maths teacher", model: FORMULA,
    about: "Mathematics, Additional Mathematics and Statistics, such as arithmetic, fractions, percentages, algebra, functions, quadratics, indices and surds, logarithms, geometry, mensuration, coordinate geometry, trigonometry, vectors, matrices, probability, statistics, differentiation and integration." },
  { key: "physics", label: "Physics teacher", model: FORMULA,
    about: "Physics, such as motion, forces, energy, work and power, pressure, thermal physics, electricity and magnetism, waves, light and sound, atomic and nuclear physics, space, and the formulas that go with them." },
  { key: "chemistry", label: "Chemistry teacher", model: FORMULA,
    about: "Chemistry, such as atoms, the periodic table, bonding, chemical formulas and equations, moles, acids, bases and salts, rates of reaction, electrolysis, metals, and organic chemistry." },
  { key: "biology", label: "Biology teacher", model: CHAT,
    about: "Biology, such as cells, plants and photosynthesis, human nutrition, respiration, the heart and blood, the nervous system, reproduction, genetics and evolution, ecology, and disease." },
  { key: "computer-science", label: "Computer Science teacher", model: FORMULA,
    about: "Computer Science and ICT, such as binary, denary and hexadecimal, data representation, algorithms, searching and sorting, Big O, programming in Python and other languages, databases and SQL, logic gates, networks and the internet, and cyber security." },
  { key: "english", label: "English teacher", model: CHAT,
    about: "English Language and Literature, such as reading comprehension, summary writing, essays, letters and reports, grammar, vocabulary, poetry, novels and plays." },
  { key: "humanities", label: "Humanities teacher", model: CHAT,
    about: "History, Geography, Pakistan Studies, Islamiat and religious studies, Sociology, Psychology, Art, Urdu and other languages, and general knowledge." },
  { key: "commerce", label: "Economics & Business teacher", model: CHAT,
    about: "Economics, Business Studies, Accounting and Commerce, such as demand and supply, markets, money and banking, trade, business organisation, marketing, double entry, and financial statements." },
  { key: "general", label: "Study helper", model: CHAT,
    about: "Greetings and small talk, how to study, motivation, exam preparation, revision plans, choosing subjects, universities and careers, and any other study question that doesn't fit another teacher. Also unclear or misheard questions: kindly ask the student to say it again. Also anything that isn't about studying: kindly bring the student back to their studies." },
];

const agentName = (key: string): string => `maki-${key}`;

function expertInstructions(expert: Expert): string {
  return `${SYSTEM_PROMPT}

YOUR SUBJECT
You are Maki's ${expert.label.toLowerCase()}, an expert in ${expert.about}
If the student picked a book, it and its chapters are given in [Background] at the start of the conversation. It is only background, so you know what they're studying. When the question is about one of its chapters, you can link to it ("That's in your quadratic functions chapter."). When it isn't, just answer the question. Never tell the student they're in the wrong book, mixing up subjects, or that a question doesn't belong to the book.
If the student asks about something outside your subject, still help briefly and kindly.
Never mention the decision maker, other agents or hand-offs. To the student, you are simply Maki.`;
}

function routerInstructions(): string {
  const list = EXPERTS.map((e) => `- ${agentName(e.key)}: ${e.about}`).join("\n");
  return `You are Maki's decision maker. You NEVER answer the student yourself and you never write any text.
For every message, immediately hand off the conversation to exactly one expert teacher:
${list}

How to choose:
1. Look at the student's latest question.
2. If there is a book in [Background] and the question fits it, hand off to that book's teacher.
3. If it is about a particular subject, hand off to that subject's teacher, whatever book is open.
4. Greetings, small talk, study tips, careers, anything else, or anything that isn't about studying: hand off to ${agentName("general")}.
5. Only if the latest message is garbled or makes no sense at all (the listening sometimes mishears), hand off to ${agentName("general")}, who will ask the student to say it again. A short but clear question is not garbled.

Examples:
"Why are leaves green?" -> ${agentName("biology")}
"What is photosynthesis?" -> ${agentName("biology")}
"What is Ohm's law?" -> ${agentName("physics")}
"What's the quadratic formula?" -> ${agentName("maths")}
"Differentiate x squared" -> ${agentName("maths")}
"How do I balance an equation?" -> ${agentName("chemistry")}
"What's 10 in binary?" -> ${agentName("computer-science")}
"How do I write a good summary?" -> ${agentName("english")}
"What caused the First World War?" -> ${agentName("humanities")}
"What's the capital of Australia?" -> ${agentName("humanities")}
"What is inflation?" -> ${agentName("commerce")}
"How do I make a balance sheet?" -> ${agentName("commerce")}
"Hi Maki!" -> ${agentName("general")}
"How should I revise for exams?" -> ${agentName("general")}
"Which university should I pick for medicine?" -> ${agentName("general")}
"Who won the match last night?" -> ${agentName("general")}
"Why I'll leave scree the" -> ${agentName("general")}`;
}

function specs() {
  return {
    version: 1,
    router: { name: "maki-decision-maker", model: ROUTER_MODEL, description: "Maki's decision maker: picks the expert teacher for each question.", instructions: routerInstructions() },
    experts: EXPERTS.map((e) => ({
      key: e.key,
      name: agentName(e.key),
      label: e.label,
      model: e.model,
      description: `Maki's ${e.label.toLowerCase()}. Answers questions about ${e.about}`,
      instructions: expertInstructions(e),
    })),
  };
}

async function api(method: string, path: string, body?: unknown): Promise<{ id: string }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`Mistral agents ${method} ${path}: ${res.status} ${text.slice(0, 200)}`), { status: res.status });
  return text ? JSON.parse(text) : {};
}

const readCache = (): Agents | null => {
  try {
    return existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : null;
  } catch {
    return null;
  }
};

/** The decision maker and the teachers, created in the Mistral account if they don't exist yet. */
export async function ensureAgents(): Promise<Agents> {
  const wanted = specs();
  const hash = createHash("sha256").update(JSON.stringify(wanted)).digest("hex").slice(0, 16);
  const cached = readCache();
  if (cached?.hash === hash) {
    try {
      await api("GET", `/agents/${cached.routerId}`);
      return cached;
    } catch {
      // gone from the account: create them again
    }
  }
  if (cached) await deleteAgents(cached).catch(() => {}); // an older set: tidy it up

  const experts: Record<string, string> = {};
  const labels: Record<string, string> = { [wanted.router.name]: "Decision maker" };
  for (const e of wanted.experts) {
    const { key, label, ...body } = e;
    experts[key] = (await api("POST", "/agents", body)).id;
    labels[e.name] = label;
  }
  const routerId = (await api("POST", "/agents", { ...wanted.router, handoffs: Object.values(experts) })).id;
  const result: Agents = { hash, routerId, experts, labels, createdAt: new Date().toISOString() };
  writeFileSync(CACHE, JSON.stringify(result, null, 2));
  return result;
}

/** Remove the agents from the Mistral account. */
export async function deleteAgents(agents: Agents | null = readCache()): Promise<number> {
  if (!agents) return 0;
  const ids = [agents.routerId, ...Object.values(agents.experts || {})].filter(Boolean);
  for (const id of ids) await api("DELETE", `/agents/${id}`).catch(() => {});
  return ids.length;
}

/**
 * Ask the decision maker. It hands off to a teacher, whose answer streams back word by word.
 * `inputs` is the conversation (our own history, so it holds only what the student heard).
 * Resolves once the decision maker has handed over (so a refusal, or a decision maker that
 * answers itself instead of handing over, can fall back to Maki answering directly), then yields
 * the teacher's answer text. `onAgent` is told which teacher took over.
 */
export async function openAgentReply(
  agents: Agents,
  inputs: ChatTurn[],
  signal: AbortSignal,
  onAgent?: (teacher: string) => void,
): Promise<AsyncGenerator<string>> {
  // A stalled answer must not leave Maki silent for ever: give up if nothing arrives for a while.
  const stall = new AbortController();
  let stallTimer = setTimeout(() => stall.abort(), ANSWER_STALL_MS);
  const stillComing = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stall.abort(), ANSWER_STALL_MS);
  };
  const stop = () => {
    clearTimeout(stallTimer);
    stall.abort();
  };

  let res: Response;
  try {
    res = await fetch(`${API}/conversations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ agent_id: agents.routerId, inputs, stream: true, store: false, handoff_execution: "server" }),
      signal: AbortSignal.any([signal, stall.signal]),
    });
  } catch (error) {
    clearTimeout(stallTimer);
    throw error;
  }
  if (!res.ok) {
    clearTimeout(stallTimer);
    throw Object.assign(new Error(`Mistral agents ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
  }

  const events = readEvents(res.body!, stillComing);
  // The decision maker must hand over before anyone speaks. If it starts answering itself (seen
  // with garbled questions, in a list-like, un-Maki style), Maki answers directly instead.
  try {
    for (;;) {
      const { value: event, done } = await events.next();
      if (done) throw Object.assign(new Error("the decision maker ended without handing over"), { noHandoff: true });
      if (event.type === "agent.handoff.done") {
        onAgent?.(agents.labels[event.next_agent_name ?? ""] || event.next_agent_name || "Maki");
        break;
      }
      if (event.type === "message.output.delta" && textOf(event)) {
        throw Object.assign(new Error("the decision maker answered itself instead of handing over"), { noHandoff: true });
      }
    }
  } catch (error) {
    stop();
    await events.return(undefined).catch(() => {});
    throw error;
  }

  return (async function* () {
    try {
      for await (const event of events) {
        if (event.type === "agent.handoff.done") onAgent?.(agents.labels[event.next_agent_name ?? ""] || event.next_agent_name || "");
        if (event.type === "message.output.delta") {
          const text = textOf(event);
          if (text) yield text;
        }
      }
    } finally {
      clearTimeout(stallTimer);
    }
  })();
}

const textOf = (event: AgentEvent): string =>
  typeof event.content === "string" ? event.content : Array.isArray(event.content) ? event.content.map((c) => c.text || "").join("") : "";

/** The events of a streamed conversation (server-sent events), parsed. */
async function* readEvents(body: ReadableStream<Uint8Array>, stillComing: () => void): AsyncGenerator<AgentEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    stillComing();
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      try {
        yield JSON.parse(line.slice(5));
      } catch {
        // not an event
      }
    }
  }
}
