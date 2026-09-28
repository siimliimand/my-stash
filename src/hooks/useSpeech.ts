"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { splitSentences } from "@/lib/markdown";

/** Strip markdown-lite syntax (**bold**, *italic*, list markers) so the
 * speech engine reads clean prose. Mirrors the syntax parsed by
 * MarkdownLite in src/lib/markdown.tsx. */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MAX_CHUNK_LENGTH = 180;

function hardWrap(text: string, max: number): string[] {
  const words = text.split(" ");
  const parts: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + 1 + word.length > max) {
      parts.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Chrome stalls single utterances longer than ~15 seconds, so text is
 * queued as sentence-sized chunks instead. Chunk boundaries fall on
 * sentence ends, which keeps the inter-utterance pause inaudible. */
function chunkForSpeech(text: string): string[] {
  const sentences = splitSentences(text);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > MAX_CHUNK_LENGTH) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...hardWrap(sentence, MAX_CHUNK_LENGTH));
      continue;
    }
    if (current && current.length + 1 + sentence.length > MAX_CHUNK_LENGTH) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

interface UseSpeechResult {
  speak: (text: string) => void;
  stop: () => void;
  toggle: (text: string) => void;
  speaking: boolean;
  supported: boolean;
}

const noopSubscribe = () => () => {};

function getSpeechSupported(): boolean {
  return "speechSynthesis" in window;
}

function getSpeechSupportedServer(): boolean {
  return false;
}

export function useSpeech(): UseSpeechResult {
  const [speaking, setSpeaking] = useState(false);
  const supported = useSyncExternalStore(
    noopSubscribe,
    getSpeechSupported,
    getSpeechSupportedServer,
  );
  const session = useRef(0);
  const queue = useRef<SpeechSynthesisUtterance[]>([]);

  useEffect(() => {
    const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
    return () => {
      queue.current = [];
      synth?.cancel();
    };
  }, []);

  const stop = useCallback(() => {
    if (!("speechSynthesis" in window)) return;
    session.current++;
    queue.current = [];
    setSpeaking(false);
    window.speechSynthesis.cancel();
  }, []);

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const clean = stripMarkdownForSpeech(text);
    if (!clean) return;

    session.current++;
    const mySession = session.current;
    queue.current = [];
    synth.cancel();

    const finish = () => {
      if (session.current !== mySession) return;
      session.current++;
      queue.current = [];
      setSpeaking(false);
    };

    const chunks = chunkForSpeech(clean);
    chunks.forEach((chunk, i) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = navigator.language || "en-US";
      if (i === chunks.length - 1) {
        utterance.onend = finish;
        utterance.onerror = finish;
      }
      queue.current.push(utterance);
      synth.speak(utterance);
    });

    setSpeaking(true);
  }, []);

  const toggle = useCallback(
    (text: string) => {
      if (speaking) stop();
      else speak(text);
    },
    [speaking, speak, stop],
  );

  return { speak, stop, toggle, speaking, supported };
}
