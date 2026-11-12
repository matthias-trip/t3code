/**
 * Rendering for the fork's turn context block: escaping, the byte budget and merging into the
 * composer's `<t3_context>` envelope. Pure, so the service and its tests share one renderer.
 */

/** One rendered entry before escaping. `kind` is a fixed word chosen in code. */
export interface ContextEntry {
  readonly kind: string;
  /** Attribute values are user text (a space title), so they are escaped. */
  readonly attributes?: ReadonlyArray<readonly [name: string, value: string]>;
  readonly text: string;
}

export const ENVELOPE_OPEN = '<t3_context version="1">\n';
export const ENVELOPE_CLOSE = "\n</t3_context>";
const FENCE_CLOSE = "\n```";

const encoder = new TextEncoder();
export const byteLength = (text: string) => encoder.encode(text).length;

// Contributed text may be edited by agents (briefs via MCP), so no `<` reaches the provider raw.
export const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const escapeAttribute = (value: string) =>
  escapeText(value).replace(/"/g, "&quot;").replace(/>/g, "&gt;");

export const entryOpen = (entry: Pick<ContextEntry, "kind" | "attributes">) =>
  `<context kind="${entry.kind}"${(entry.attributes ?? [])
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("")}>\n`;

export const ENTRY_CLOSE = "\n</context>";

/** Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, split on a code point. */
function prefixWithinBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

const shortenedMarker = (label: string, dropped: number, total: number) =>
  `[${label} shortened to fit: ${dropped} of ${total} bytes left out]`;

const openFences = (text: string) => (text.match(/^[ \t]*```/gm) ?? []).length % 2 === 1;

/**
 * Fits escaped text into `maxBytes`, or none when not even the marker fits. Over budget, it is
 * cut at the last line break (else word break) in the second half of the allowance, never
 * inside an escape; an open code fence is closed, then a marker says how much was left out.
 */
export function fitWithinBytes(text: string, maxBytes: number, label: string): string | null {
  const total = byteLength(text);
  if (total <= maxBytes) return text;
  // The marker never grows past the one for "all of it left out".
  const reserve = byteLength(`\n${shortenedMarker(label, total, total)}${FENCE_CLOSE}`);
  if (maxBytes - reserve <= 0) return null;
  const prefix = prefixWithinBytes(text, maxBytes - reserve);
  const half = prefix.length / 2;
  const lineBreak = prefix.lastIndexOf("\n");
  const wordBreak = prefix.search(/\s\S*$/);
  let cut =
    lineBreak >= half
      ? prefix.slice(0, lineBreak)
      : wordBreak >= half
        ? prefix.slice(0, wordBreak)
        : prefix;
  const ampersand = cut.lastIndexOf("&");
  if (ampersand !== -1 && !cut.includes(";", ampersand)) cut = cut.slice(0, ampersand);
  cut = cut.trimEnd();
  const dropped = total - byteLength(cut);
  return `${cut}${openFences(cut) ? FENCE_CLOSE : ""}\n${shortenedMarker(label, dropped, total)}`;
}

/**
 * Adds rendered entries to the provider text. When upstream's composer projection already
 * ended the text with its envelope, the entries join it, so the turn carries one envelope.
 */
export function withEntries(input: {
  readonly rawText: string;
  readonly text: string;
  readonly entries: string;
}): string {
  // Projection only changes the text when it adds an envelope; a user-typed tag is not one.
  if (input.text !== input.rawText && input.text.endsWith(ENVELOPE_CLOSE)) {
    return `${input.text.slice(0, -ENVELOPE_CLOSE.length)}\n${input.entries}${ENVELOPE_CLOSE}`;
  }
  return `${input.text}\n\n${ENVELOPE_OPEN}${input.entries}${ENVELOPE_CLOSE}`;
}
