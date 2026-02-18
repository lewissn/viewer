"use client";

import { useState } from "react";
import {
  groupByCategory,
  type ResolvedFitting,
} from "@/lib/fittings";

interface FittingsPanelProps {
  fittings: ResolvedFitting[];
}

/**
 * Sidebar-embeddable panel showing included fittings grouped by category.
 * Each fitting is clickable and opens a description modal overlay.
 */
export function FittingsPanel({ fittings }: FittingsPanelProps) {
  const [selectedFitting, setSelectedFitting] = useState<ResolvedFitting | null>(null);
  const groups = groupByCategory(fittings);

  if (fittings.length === 0) return null;

  return (
    <>
      <div className="flex flex-col gap-0.5">
        {groups.map((group) => (
          <FittingCategory
            key={group.category}
            label={group.label}
            items={group.items}
            onSelect={setSelectedFitting}
          />
        ))}
      </div>

      {/* Modal overlay */}
      {selectedFitting && (
        <FittingModal
          fitting={selectedFitting}
          onClose={() => setSelectedFitting(null)}
        />
      )}
    </>
  );
}

function FittingCategory({
  label,
  items,
  onSelect,
}: {
  label: string;
  items: ResolvedFitting[];
  onSelect: (f: ResolvedFitting) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center w-full gap-2 rounded-lg px-3 py-2 text-[14px] text-[var(--foreground)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors active:scale-[0.98]"
        style={{ paddingLeft: 12 }}
      >
        <svg
          className={`w-3.5 h-3.5 text-[var(--muted)] transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.25 4.5l7.5 7.5-7.5 7.5"
          />
        </svg>
        <span className="font-medium">{label}</span>
        <span className="ml-auto text-[12px] text-[var(--muted)]">
          {items.length}
        </span>
      </button>

      {expanded && (
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.partId}>
              <button
                onClick={() => onSelect(item)}
                className="flex items-center w-full gap-2 rounded-lg px-3 py-1.5 text-[13px] text-[var(--muted)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors active:scale-[0.98]"
                style={{ paddingLeft: 28 }}
              >
                <span className="flex-1 text-left truncate">
                  {item.label}
                </span>
                <span className="shrink-0 text-[12px] text-[var(--muted)] tabular-nums">
                  x{Math.ceil(item.qty)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FittingModal({
  fitting,
  onClose,
}: {
  fitting: ResolvedFitting;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative bg-[var(--card-bg)] rounded-2xl shadow-2xl max-w-md w-full p-6 animate-scale-in border border-[var(--sidebar-border)]/50">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 flex items-center justify-center w-8 h-8 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors active:scale-95"
        >
          <svg
            className="w-4 h-4 text-[var(--muted)]"
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

        {/* Category badge */}
        <span className="inline-block rounded-md bg-black/5 dark:bg-white/10 px-2 py-0.5 text-[11px] text-[var(--muted)] font-medium uppercase tracking-wider mb-3">
          {fitting.category}
        </span>

        {/* Title */}
        <h3 className="text-[18px] font-semibold text-[var(--foreground)] mb-1">
          {fitting.label}
        </h3>

        {/* Quantity */}
        <p className="text-[14px] text-[var(--accent)] font-medium mb-4">
          Quantity included: {Math.ceil(fitting.qty)}
        </p>

        {/* Description */}
        <p className="text-[14px] text-[var(--muted)] leading-relaxed">
          {fitting.description}
        </p>

        {/* Done button */}
        <button
          onClick={onClose}
          className="mt-6 w-full rounded-xl bg-black/5 dark:bg-white/10 px-4 py-2.5 text-[14px] font-medium text-[var(--foreground)] hover:opacity-90 transition-all active:scale-[0.98]"
        >
          Done
        </button>
      </div>
    </div>
  );
}
