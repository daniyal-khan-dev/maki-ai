// Which AI model answers a question. Measured on the free Mistral plan (28 Oct 2026):
//  - open-mistral-nemo: fastest (0.9-1.3 s) and chattiest, but used the formula format in 6/8 tests
//  - ministral-8b:      slower (1.2-2.5 s) and long-winded, but used the formula format in 8/8
// So formula-type questions (maths, physics, chemistry, computing) go to FORMULA_MODEL and
// everything else to LLM_MODEL. Set FORMULA_MODEL= (empty) in .env to always use LLM_MODEL.

const BASE = (process.env.LLM_BASE_URL || "https://api.mistral.ai/v1").replace(/\/+$/, "");
const ON_MISTRAL = BASE.includes("mistral.ai");

export const LLM_MODEL: string = process.env.LLM_MODEL || "open-mistral-nemo";
export const FORMULA_MODEL: string = process.env.FORMULA_MODEL ?? (ON_MISTRAL ? "ministral-8b-latest" : "");

const FORMULA_WORDS = new RegExp(
  "\\b(" +
    [
      "formula", "formulas", "equation", "equations", "law", "theorem", "calculate", "calculation", "solve",
      "derive", "prove", "chemical", "reaction", "balance", "compound", "molecule", "mole", "moles", "acid",
      "speed", "velocity", "acceleration", "force", "momentum", "energy", "power", "work", "pressure",
      "density", "voltage", "current", "resistance", "circuit", "area", "volume", "perimeter", "angle",
      "triangle", "circle", "algebra", "quadratic", "pythagoras", "fraction", "fractions", "percentage",
      "ratio", "probability", "integral", "derivative", "differentiate", "integrate", "logarithm", "log",
      "algorithm", "complexity", "big o", "binary", "loop", "function",
    ].join("|") +
    ")\\b",
  "i",
);

/** The model for a question: the formula-careful one for formula-type questions. */
export function modelFor(question: string | undefined): string {
  return FORMULA_MODEL && FORMULA_WORDS.test(question || "") ? FORMULA_MODEL : LLM_MODEL;
}
