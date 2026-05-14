// Strip the markdown / inline-LaTeX flavours the model occasionally emits
// inside [text:] or [title:] content. Two consumers:
//   - the renderer, so the whiteboard does not show stray `$` or `**`
//   - the TTS, so the narrator does not read "dollar p dollar" out loud
//
// We keep the inner text and drop the marker. No attempt is made to *render*
// the math here; the system prompt forbids inline math and pushes the model
// to use [equation: ...] tags instead. This sanitizer is the safety net for
// when the model ignores that rule.

const PATTERNS: Array<[RegExp, string]> = [
  // Block / inline LaTeX: $$...$$ first so $ runs do not eat the wrappers.
  [/\$\$([\s\S]+?)\$\$/g, "$1"],
  [/\$([^$\n]+?)\$/g, "$1"],
  // \( ... \) and \[ ... \] LaTeX delimiters.
  [/\\\(([\s\S]+?)\\\)/g, "$1"],
  [/\\\[([\s\S]+?)\\\]/g, "$1"],
  // Bold / italic.
  [/\*\*([^*\n]+?)\*\*/g, "$1"],
  [/__([^_\n]+?)__/g, "$1"],
  [/(?<![*\w])\*([^*\n]+?)\*(?!\w)/g, "$1"],
  [/(?<![_\w])_([^_\n]+?)_(?!\w)/g, "$1"],
  // Inline code.
  [/`([^`\n]+?)`/g, "$1"],
  // Markdown link: [text](url) -> text.
  [/\[([^\]\n]+?)\]\(([^)\n]+?)\)/g, "$1"],
];

const HEADING_LINE = /^\s*#{1,6}\s+/gm;
const LIST_BULLET = /^\s*[-*+]\s+/gm;
const NUMBERED_BULLET = /^\s*\d+\.\s+/gm;

/**
 * Remove markdown / inline-LaTeX markers from a narration or caption string.
 * Whitespace and the inner text are preserved.
 */
export function stripMarkdown(input: string): string {
  if (!input) return input;
  let out = input;
  for (const [re, sub] of PATTERNS) {
    out = out.replace(re, sub);
  }
  out = out.replace(HEADING_LINE, "");
  out = out.replace(LIST_BULLET, "");
  out = out.replace(NUMBERED_BULLET, "");
  return out;
}
