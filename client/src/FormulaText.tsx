import type { ReactNode } from "react";

/**
 * Maki's text on screen. Formulas arrive as {{written form|spoken form}}: the written form is
 * shown, highlighted; one still being written is held back so "{{F = m" never flashes up.
 * Rendered as text, never HTML, so nothing the AI writes can run as markup.
 */
export function FormulaText({ raw }: { raw: string }) {
  let text = raw.replace(/[*_#`]/g, ""); // stray markdown
  const open = text.lastIndexOf("{{");
  if (open > text.lastIndexOf("}}")) text = text.slice(0, open);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{\{([^{}|]*)(?:\|[^{}]*)?\}\}/g)) {
    parts.push(text.slice(last, m.index));
    parts.push(
      <span key={m.index} className="formula">
        {m[1].trim()}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
