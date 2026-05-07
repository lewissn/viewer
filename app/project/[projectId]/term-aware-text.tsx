"use client";

import { useState } from "react";
import { tokenize, type GlossaryEntry } from "@/lib/glossary";

interface Props {
  /** The text to render — terms in the glossary become tappable. */
  children: string;
  /** Optional className applied to the wrapping span. */
  className?: string;
}

/**
 * Renders text where any glossary term becomes a tappable inline span.
 * Tapping opens a mobile-first bottom-sheet style popover with the
 * term's plain-English description.
 *
 * Usage: <TermAwareText>{currentStepData.copy}</TermAwareText>
 */
export function TermAwareText({ children, className }: Props) {
  const [activeEntry, setActiveEntry] = useState<GlossaryEntry | null>(null);

  const segments = tokenize(children);

  return (
    <>
      <span className={className}>
        {segments.map((seg, i) => {
          if (seg.type === "text" || !seg.entry) {
            return <span key={i}>{seg.value}</span>;
          }
          const entry = seg.entry;
          return (
            <button
              key={i}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setActiveEntry(entry);
              }}
              className="underline decoration-dotted decoration-[var(--accent)] underline-offset-[3px] text-[var(--foreground)] hover:decoration-solid transition-all cursor-help"
            >
              {seg.value}
            </button>
          );
        })}
      </span>

      {activeEntry && (
        <GlossarySheet
          entry={activeEntry}
          onClose={() => setActiveEntry(null)}
        />
      )}
    </>
  );
}

/**
 * Bottom-sheet popover for a glossary term.
 * Mobile-first: full-width card sliding up from the bottom on small
 * screens, centered modal on larger screens.
 */
function GlossarySheet({
  entry,
  onClose,
}: {
  entry: GlossaryEntry;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Definition of ${entry.label}`}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" />

      {/* Sheet content — stops click propagation so taps on the card don't dismiss. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:w-auto sm:max-w-md sm:mx-4 sm:rounded-2xl rounded-t-2xl bg-[var(--card-bg)] shadow-[0_-8px_40px_rgba(0,0,0,0.18)] sm:shadow-[0_8px_40px_rgba(0,0,0,0.18)] border border-[var(--sidebar-border)]/50 overflow-hidden animate-slide-up"
      >
        {/* Drag handle (mobile visual cue) */}
        <div className="sm:hidden flex justify-center pt-2.5 pb-1">
          <div className="w-10 h-1 rounded-full bg-[var(--muted)]/40" />
        </div>

        <div className="px-5 pb-5 pt-3 sm:pt-5">
          <div className="flex items-start justify-between gap-3 mb-2">
            <h3 className="text-[16px] font-semibold text-[var(--foreground)]">
              {entry.label}
            </h3>
            <button
              onClick={onClose}
              aria-label="Close"
              className="flex-shrink-0 w-8 h-8 -mt-1 -mr-1 rounded-full hover:bg-[var(--muted)]/15 flex items-center justify-center text-[var(--muted)] active:scale-90 transition-all"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          <p className="text-[14px] text-[var(--muted)] leading-relaxed">
            {entry.description}
          </p>
        </div>
      </div>
    </div>
  );
}
