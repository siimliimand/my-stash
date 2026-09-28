"use client";

import { Volume2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSpeech } from "@/hooks/useSpeech";
import { cn } from "@/lib/utils";

interface SpeakButtonProps {
  text: string;
  className?: string;
}

export function SpeakButton({ text, className }: SpeakButtonProps) {
  const { toggle, speaking, supported } = useSpeech();

  if (!supported) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8", className)}
      onClick={() => toggle(text)}
      aria-label={speaking ? "Stop reading" : "Read card aloud"}
      aria-pressed={speaking}
    >
      {speaking ? (
        <Square className="h-4 w-4 fill-current text-primary" />
      ) : (
        <Volume2 className="h-4 w-4" />
      )}
    </Button>
  );
}
