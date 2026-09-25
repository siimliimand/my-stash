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

export function MarkdownLite({ content, className }: MarkdownLiteProps) {
  const blocks = parseBlocks(content);

  return (
    <div className={className}>
      {blocks.map((block, bi) => {
        if (block.type === "list") {
          return (
            <ul key={bi} className="list-disc pl-5 space-y-1 my-2 text-sm">
              {block.items.map((item, ii) => (
                <li key={ii}>{renderInline(item, `${bi}-${ii}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi} className="my-2 leading-relaxed">
            {renderInline(block.content, `${bi}`)}
          </p>
        );
      })}
    </div>
  );
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function estimateReadTime(text: string): number {
  return Math.max(1, Math.ceil(countWords(text) / 200));
}
