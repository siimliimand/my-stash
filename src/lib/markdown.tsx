/**
 * Minimal markdown-lite renderer.
 * Supports: **bold**, *italic*, and unordered lists only.
 * No external dependency needed.
 */

type Block =
  | { type: "paragraph"; content: Inline[] }
  | { type: "list"; items: Inline[][] };

type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string };

/** Abbreviations whose periods must not end a sentence, plus decimal
 * points. Dots are swapped for a placeholder before splitting and restored
 * after, so "e.g." or "$1.5" never break a sentence in two. */
const ABBREVIATIONS = [
  "e.g.", "i.e.", "etc.", "vs.", "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "Fig.",
  "approx.", "ed.", "al.", "Ph.D", "St.", "cf.",
];

const DOT = "\u0001";

export function splitSentences(text: string): string[] {
  let prepared = text;
  for (const abbr of ABBREVIATIONS) {
    prepared = prepared.replaceAll(abbr, abbr.replaceAll(".", DOT));
  }
  prepared = prepared.replace(/(\d)\.(\d)/g, `$1${DOT}$2`);

  // Sentence end = [.!?] + optional closing quote/bracket, followed by
  // whitespace and a new sentence starter (capital, bold marker, quote, dash).
  const parts = prepared.split(/([.!?]+["')\]]*)\s+(?=[A-Z*"'\u2014(\u2013-])/);

  const sentences: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] ?? "";
    const punct = parts[i + 1] ?? "";
    const restored = `${body}${punct}`.replaceAll(DOT, ".").trim();
    if (restored) sentences.push(restored);
  }
  return sentences;
}

/** Break a "wall of text" body (no newlines, several sentences) into
 * paragraphs so the renderer can space it out. Bodies that already contain
 * newlines are returned untouched; short bodies are not worth splitting.
 * A leading **bold thesis** sentence becomes its own opening paragraph. */
export function structureBody(raw: string): string {
  if (raw.includes("\n")) return raw;
  const trimmed = raw.trim();
  const sentences = splitSentences(trimmed);
  if (sentences.length < 4) return raw;

  const leadBold = trimmed.startsWith("**");
  const lead = leadBold ? sentences.slice(0, 1) : [];
  const rest = leadBold ? sentences.slice(1) : sentences;

  const groups: string[][] = [];
  for (let i = 0; i < rest.length; i += 2) {
    groups.push(rest.slice(i, i + 2));
  }

  const paragraphs = [lead, ...groups]
    .map((group) => group.join(" ").trim())
    .filter((p) => p.length > 0);
  return paragraphs.join("\n\n");
}

/** Sentence openers that mark the actionable-takeaway section of a card.
 * Matched after stripping markdown emphasis, so "**So what?**" matches. */
const TAKEAWAY_RE =
  /^(so what|the so what|takeaway|the takeaway|the lesson|try this|how to use|how to apply|in practice|putting it (into )?practice|bottom line|the fix|the antidote|the upshot|action step|practical takeaway|what to do)\b/i;

function startsWithTakeawayMarker(text: string): boolean {
  return TAKEAWAY_RE.test(text.replace(/\*/g, "").trimStart());
}

/** Split a body into (main, takeaway) so the renderer can draw the takeaway
 * as its own separated section. The takeaway starts at the first paragraph —
 * or, for a prose paragraph without line breaks, at the first sentence —
 * whose text opens with a takeaway marker. Everything from there on belongs
 * to the takeaway section. */
export function splitTakeawaySection(raw: string): { main: string; takeaway: string | null } {
  const paragraphs = raw.split(/\n{2,}/);

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];

    if (startsWithTakeawayMarker(para)) {
      return {
        main: paragraphs.slice(0, i).join("\n\n"),
        takeaway: paragraphs.slice(i).join("\n\n"),
      };
    }

    // Multi-line paragraphs are lists or pre-structured text — only plain
    // prose paragraphs are safe to resplit at sentence boundaries.
    if (para.includes("\n")) continue;

    const sentences = splitSentences(para);
    for (let j = 1; j < sentences.length; j++) {
      if (startsWithTakeawayMarker(sentences[j])) {
        return {
          main: [...paragraphs.slice(0, i), sentences.slice(0, j).join(" ")].join("\n\n"),
          takeaway: [sentences.slice(j).join(" "), ...paragraphs.slice(i + 1)].join("\n\n"),
        };
      }
    }
  }

  return { main: raw, takeaway: null };
}

function parseInline(text: string): Inline[] {
  const result: Inline[] = [];
  // Match **bold** or *italic*
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      result.push({ type: "text", text: text.slice(last, match.index) });
    }
    if (match[0].startsWith("**")) {
      result.push({ type: "bold", text: match[2] });
    } else {
      result.push({ type: "italic", text: match[3] });
    }
    last = regex.lastIndex;
  }

  if (last < text.length) {
    result.push({ type: "text", text: text.slice(last) });
  }

  return result;
}

function parseBlocks(raw: string): Block[] {
  const lines = raw.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();

    if (!line) {
      i++;
      continue;
    }

    // List item
    if (line.match(/^[-*]\s+/)) {
      const items: Inline[][] = [];
      while (i < lines.length && lines[i].trimEnd().match(/^[-*]\s+/)) {
        items.push(parseInline(lines[i].trimEnd().replace(/^[-*]\s+/, "")));
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    // Paragraph — collect consecutive non-list, non-empty lines
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trimEnd() && !lines[i].trimEnd().match(/^[-*]\s+/)) {
      paraLines.push(lines[i].trimEnd());
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: "paragraph", content: parseInline(paraLines.join(" ")) });
    }
  }

  return blocks;
}

import React from "react";

interface MarkdownLiteProps {
  content: string;
  className?: string;
}

function renderInline(inlines: Inline[], key: string): React.ReactNode[] {
  return inlines.map((n, i) => {
    if (n.type === "bold") return <strong key={`${key}-${i}`}>{n.text}</strong>;
    if (n.type === "italic") return <em key={`${key}-${i}`}>{n.text}</em>;
    return <span key={`${key}-${i}`}>{n.text}</span>;
  });
}

function renderBlocks(blocks: Block[]): React.ReactNode[] {
  return blocks.map((block, bi) => {
    if (block.type === "list") {
      return (
        <ul key={bi} className="list-disc pl-5 space-y-1.5 my-3 text-sm">
          {block.items.map((item, ii) => (
            <li key={ii}>{renderInline(item, `${bi}-${ii}`)}</li>
          ))}
        </ul>
      );
    }
    return (
      <p key={bi} className="my-3 leading-relaxed">
        {renderInline(block.content, `${bi}`)}
      </p>
    );
  });
}

export function MarkdownLite({ content, className }: MarkdownLiteProps) {
  const { main, takeaway } = splitTakeawaySection(structureBody(content));
  const mainBlocks = parseBlocks(main);
  const takeawayBlocks = takeaway !== null ? parseBlocks(takeaway) : [];

  // A takeaway that is the entire body reads as normal content — it only
  // gets the separated-section treatment when there is main content above.
  const separated = mainBlocks.length > 0 && takeawayBlocks.length > 0;

  return (
    <div className={className}>
      {renderBlocks(mainBlocks)}
      {separated && (
        <div className="mt-4 pt-3 border-t border-border/60">
          {renderBlocks(takeawayBlocks)}
        </div>
      )}
    </div>
  );
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function estimateReadTime(text: string): number {
  return Math.max(1, Math.ceil(countWords(text) / 200));
}
