/**
 * The deploy log terminal — the one dark object in Shipway (DESIGN.md's Theme decision: a
 * full-bleed `--color-term` panel that "glows out of the light page"). Per DESIGN.md's Signature
 * section: IBM Plex Mono 13px/1.6, `[HH:MM:SS]` timestamps at 45% alpha, `==> stage` lines in
 * accent teal at 500 weight, ERROR/failure lines in port red, auto-scroll pinned to bottom with a
 * "jump to latest" affordance once the reader scrolls up. No fake CRT effects.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';

const TIMESTAMP_RE = /^\[\d{2}:\d{2}:\d{2}\]\s*/;

/** Scrolling up this many px (or more) from the bottom un-pins auto-scroll (task-24 ruling). */
const UNPIN_THRESHOLD_PX = 80;

export interface LogTerminalProps {
  /** The full raw log text so far (newline-separated lines). */
  text: string;
  className?: string;
}

export function LogTerminal({ text, className = '' }: LogTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Auto-scroll to the newest line whenever new text arrives, but only while pinned — this is the
  // one piece of ambient motion DESIGN.md allows outside the berth-light pulse.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [text, pinned]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distanceFromBottom < UNPIN_THRESHOLD_PX);
  }

  function jumpToLatest() {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    setPinned(true);
  }

  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');

  return (
    <div className={`relative ${className}`}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Deploy log"
        // Fills available height per the task-24 ruling, never shorter than 420px.
        className="h-[max(420px,60vh)] overflow-y-auto bg-term px-4 py-3 font-mono text-[13px] leading-[1.6] text-term-text"
      >
        {lines.length === 0 ? (
          <p className="text-term-text/45">Waiting for output...</p>
        ) : (
          lines.map((line, index) => <LogLine key={index} line={line} />)
        )}
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={jumpToLatest}
          // Fixed dark chip (not theme-reactive) — the terminal keeps its own surface in both
          // themes (DESIGN.md), so this affordance is built from white-alpha overlays, not tokens
          // that flip with light/dark.
          className="absolute right-4 bottom-4 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/10 px-3.5 py-2 text-xs font-medium text-term-text shadow-lg backdrop-blur-sm transition-colors duration-150 ease-out hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          <ArrowDown size={13} strokeWidth={1.75} aria-hidden />
          Jump to latest
        </button>
      )}
    </div>
  );
}

function LogLine({ line }: { line: string }) {
  const match = TIMESTAMP_RE.exec(line);
  const timestamp = match?.[0];
  const rest = timestamp ? line.slice(timestamp.length) : line;
  const isStage = rest.startsWith('==> ');
  const isError = rest.includes('ERROR') || rest.includes('error:');

  return (
    <div className="whitespace-pre-wrap break-all">
      {timestamp && <span className="text-term-text/45">{timestamp}</span>}
      <span className={isStage ? 'font-medium text-term-stage' : isError ? 'text-term-err' : undefined}>{rest === '' ? ' ' : rest}</span>
    </div>
  );
}
