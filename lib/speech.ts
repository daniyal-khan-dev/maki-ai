// How Maki's written answer becomes speech.
//
// Formulas: the AI writes each one as {{written form|how to say it}}, for example
//   {{F = m × a|F equals m times a}}   {{H₂O|H two O}}   {{O(n log n)|big O of n log n}}
// The page shows the written form; the voice says the spoken form. Symbols that slip through
// without that markup (², ₂, ×, √, Δ, → ...) are turned into words too.

/** {{written|spoken}} */
export const FORMULA = /\{\{([^{}|]*)\|([^{}]*)\}\}/g;

const SUB_DIGITS = "₀₁₂₃₄₅₆₇₈₉";
const SUP_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

const power = (p: string): string => (p === "2" ? " squared" : p === "3" ? " cubed" : ` to the power of ${p}`);

/** A chemical formula with subscripts, spelled the way a teacher says it: "CO₂" -> "C O 2". */
const spellChemical = (formula: string): string =>
  formula.replace(/([A-Z][a-z]?)([₀₁₂₃₄₅₆₇₈₉]*)/g, (_: string, element: string, sub: string) =>
    ` ${element.toUpperCase().split("").join(" ")}${sub ? ` ${[...sub].map((c) => SUB_DIGITS.indexOf(c)).join("")}` : ""}`);

/** Maths symbols that are safe to put into words anywhere in a sentence. */
function symbolsToWords(text: string): string {
  return text
    .replace(/\b\d*(?:[A-Z][a-z]?[₀₁₂₃₄₅₆₇₈₉]*)+/g, (m) => (/[₀-₉]/.test(m) ? ` ${m.match(/^\d*/)![0]}${spellChemical(m.replace(/^\d*/, ""))} ` : m))
    .replace(/([A-Za-z0-9)\]])\^\(?(-?\d+)\)?/g, (_: string, base: string, p: string) => `${base}${power(p)}`)
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (s) => power([...s].map((c) => SUP_DIGITS.indexOf(c)).join("")))
    .replace(/[₀₁₂₃₄₅₆₇₈₉]+/g, (s) => ` ${[...s].map((c) => SUB_DIGITS.indexOf(c)).join("")} `)
    .replace(/×|·/g, " times ")
    .replace(/÷/g, " divided by ")
    .replace(/±/g, " plus or minus ")
    .replace(/≈/g, " is about ")
    .replace(/≠/g, " is not equal to ")
    .replace(/≤/g, " is less than or equal to ")
    .replace(/≥/g, " is greater than or equal to ")
    .replace(/√\s*\(?/g, " the square root of ")
    .replace(/π/g, " pi ")
    .replace(/Δ\s*/g, " change in ")
    .replace(/[→⟶]/g, " gives ")
    .replace(/⇌/g, " is in balance with ")
    .replace(/∞/g, " infinity ")
    .replace(/°C/g, " degrees Celsius")
    .replace(/°/g, " degrees")
    .replace(/\s=\s/g, " equals ")
    .replace(/\s\+\s/g, " plus ");
}

/** A formula with no spoken form: read it out as maths. */
function formulaToWords(expr: string): string {
  return symbolsToWords(expr)
    .replace(/\s*=\s*/g, " equals ")
    .replace(/\s*\+\s*/g, " plus ")
    .replace(/\s+-\s+/g, " minus ")
    .replace(/\s*\/\s*/g, " over ")
    .replace(/\s*\*\s*/g, " times ")
    .replace(/[()]/g, " ");
}

/** The words Maki should say for a piece of its answer. */
export function toSpeech(text: string): string {
  return symbolsToWords(
    text
      .replace(FORMULA, (_: string, _written: string, spoken: string) => ` ${spoken.trim()} `)
      .replace(/\{\{([^{}|]*)\}\}/g, (_: string, written: string) => ` ${formulaToWords(written)} `) // formula without a spoken form
      .replace(/[{}|]/g, " ") // a broken marker: never read braces out
      .replace(/[*_#`>~]/g, "") // markdown
      // Said the way a person says them: dashes and bracketed asides become short pauses
      // (voices handle em-dashes inconsistently, Vapi's guide warns). "3-4-5" and "log(100)" stay.
      .replace(/\s*[—–]\s*/g, ", ")
      .replace(/\s*\(([^()]*\s[^()]*)\)\s*/g, ", $1, "),
  )
    .replace(/,\s*([,.!?])/g, "$1") // ", ." left by the above
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Where the first finished sentence ends (after ". ", "! ", "? "), or -1. Never inside a
 * formula, so "{{g = 9.8 m/s²|...}}" or a full stop in the spoken part doesn't split it.
 */
export function sentenceEnd(text: string): number {
  const re = /[.!?]["')\]]?\s/g;
  let match;
  while ((match = re.exec(text))) {
    const end = match.index + match[0].length;
    const before = text.slice(0, end);
    const opened = (before.match(/\{\{/g) || []).length;
    const closed = (before.match(/\}\}/g) || []).length;
    if (opened <= closed) return end;
  }
  return -1;
}
