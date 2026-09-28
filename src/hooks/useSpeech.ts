"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

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
  const keepAlive = useRef<number | null>(null);
  const active = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
    return () => {
      if (keepAlive.current !== null) window.clearInterval(keepAlive.current);
      synth?.cancel();
    };
  }, []);

  const clearKeepAlive = useCallback(() => {
    if (keepAlive.current !== null) {
      window.clearInterval(keepAlive.current);
      keepAlive.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    if (!("speechSynthesis" in window)) return;
    active.current = null;
    clearKeepAlive();
    setSpeaking(false);
    window.speechSynthesis.cancel();
  }, [clearKeepAlive]);

  const speak = useCallback(
    (text: string) => {
      if (!("speechSynthesis" in window)) return;
      const synth = window.speechSynthesis;
      const clean = stripMarkdownForSpeech(text);
      if (!clean) return;

      synth.cancel();
      clearKeepAlive();

      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = navigator.language || "en-US";
      active.current = utterance;

      const finish = () => {
        if (active.current !== utterance) return;
        active.current = null;
        clearKeepAlive();
        setSpeaking(false);
      };
      utterance.onend = finish;
      utterance.onerror = finish;

      // Chrome stalls long utterances (~15s); nudge the engine along.
      keepAlive.current = window.setInterval(() => {
        if (synth.speaking) {
          synth.pause();
          synth.resume();
        }
      }, 12000);

      synth.speak(utterance);
      setSpeaking(true);
    },
    [clearKeepAlive],
  );

  const toggle = useCallback(
    (text: string) => {
      if (speaking) stop();
      else speak(text);
    },
    [speaking, speak, stop],
  );

  return { speak, stop, toggle, speaking, supported };
}
