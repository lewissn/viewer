"use client";

import { useState, useMemo } from "react";
import type { ResolvedFitting } from "@/lib/fittings";

// ── Content types ──

interface GuideSection {
  heading?: string;
  bullets?: string[];
  note?: { type: "important" | "warning"; text: string };
}

interface GuideItem {
  id: string;
  label: string;
  badge: string;
  sections: GuideSection[];
}

// ── Feature detection ──

const HINGE_PART_IDS = [
  "FULL_HINGE_ARM",
  "HALF_HINGE_ARM",
  "INSET_HINGE_ARM",
  "BLINDER_CORNER_HINGE",
];

function detectDoors(fittings: ResolvedFitting[]): boolean {
  return fittings.some((f) => HINGE_PART_IDS.includes(f.partId));
}

function detectSpiderBrackets(fittings: ResolvedFitting[]): boolean {
  return fittings.some((f) => f.partId === "SPIDER_BRACKET");
}

function detectUnhandedBrackets(fittings: ResolvedFitting[]): boolean {
  return fittings.some((f) => f.partId === "UNHANDED_BRACKET");
}

// ── Static guide content ──

const CONNECTING_CABINETS: GuideItem = {
  id: "connecting-cabinets",
  label: "Connecting Cabinets",
  badge: "Installation",
  sections: [
    {
      bullets: [
        "Position cabinets and level individually",
        "Clamp adjacent units together",
        "Ensure front faces are flush",
        "Check top alignment before fixing",
        "Screw through side panel into adjacent unit",
        "Fix near top and bottom",
      ],
    },
    {
      note: {
        type: "important",
        text: "Join cabinets before fitting worktop. Do not overtighten fixings.",
      },
    },
  ],
};

const FILLERS_SCRIBING: GuideItem = {
  id: "fillers-scribing",
  label: "Fillers & Scribing",
  badge: "Installation",
  sections: [
    {
      heading: "Fillers & End Panels",
      bullets: [
        "Fillers close gaps between cabinet and wall",
        "Measure gap after levelling cabinet",
        "Trim filler, not carcass where possible",
        "Scribe to wall using compass method",
        "Fit filler before final cabinet fixing",
      ],
    },
    {
      heading: "Scribing to Uneven Walls",
      bullets: [
        "Hold filler proud",
        "Mark wall profile",
        "Plane or sand to line",
        "Test fit gradually",
      ],
    },
  ],
};

const LEVELLING_SECURING: GuideItem = {
  id: "levelling-securing",
  label: "Levelling & Securing",
  badge: "Installation",
  sections: [
    {
      bullets: [
        "Use spirit level",
        "Adjust legs or pack under base",
        "Check front-to-back and side-to-side",
      ],
    },
    {
      note: {
        type: "warning",
        text: "Tall cabinets must be secured to wall.",
      },
    },
    {
      bullets: [
        "Fix to wall using supplied brackets",
        "Always secure tall units before loading",
      ],
    },
  ],
};

const PAINTING_GUIDE: GuideItem = {
  id: "painting-guide",
  label: "Painting Guide",
  badge: "Finishing",
  sections: [
    {
      heading: "Before Painting",
      bullets: ["Fill screw holes", "Sand lightly", "Remove dust"],
    },
    {
      heading: "Priming",
      bullets: ["Use suitable MDF primer", "Apply thin, even coats"],
    },
    {
      heading: "Top Coat",
      bullets: [
        "Use water-based paint",
        "Apply 2–3 coats",
        "Lightly sand between coats",
      ],
    },
    {
      heading: "Edges",
      bullets: ["Seal exposed MDF edges properly"],
    },
    {
      heading: "Drying",
      bullets: ["Allow full curing before heavy use"],
    },
  ],
};

const DOOR_ADJUSTMENT: GuideItem = {
  id: "door-adjustment",
  label: "Door Adjustment",
  badge: "Finishing",
  sections: [
    {
      heading: "Height Adjustment",
      bullets: [
        "Loosen mounting plate screws",
        "Slide door up or down",
      ],
    },
    {
      heading: "Side Adjustment",
      bullets: ["Use front cam screw"],
    },
    {
      heading: "Depth Adjustment",
      bullets: ["Use rear screw"],
    },
    {
      note: {
        type: "important",
        text: "Target gap: approximately 3mm between doors.",
      },
    },
  ],
};

// ── Dynamic wall hanging content ──

function buildWallHangingGuide(fittings: ResolvedFitting[]): GuideItem {
  const hasSpider = detectSpiderBrackets(fittings);
  const hasUnhanded = detectUnhandedBrackets(fittings);

  const sections: GuideSection[] = [];

  if (hasSpider || hasUnhanded) {
    const bracketBullets: string[] = [];
    if (hasSpider)
      bracketBullets.push(
        "Spider bracket \u2014 heavy-duty concealed wall bracket"
      );
    if (hasUnhanded)
      bracketBullets.push(
        "Unhanded bracket \u2014 adjustable kitchen wall bracket"
      );
    sections.push({ heading: "Your Bracket Type", bullets: bracketBullets });
  }

  sections.push({
    note: {
      type: "important",
      text: "Only basic wall plugs are supplied. Ensure appropriate fixings are used for your wall type.",
    },
  });

  sections.push({
    heading: "Brick / Block Wall",
    bullets: [
      "Use appropriate masonry drill bit",
      "Use heavy-duty wall plugs",
      "Ensure solid fixing point",
    ],
  });

  sections.push({
    heading: "Plasterboard",
    bullets: [
      "Fix into studs where possible",
      "Use appropriate plasterboard anchors",
      "Do not rely on standard plugs",
    ],
  });

  sections.push({
    heading: "Timber Stud",
    bullets: ["Fix directly into studs"],
  });

  sections.push({
    heading: "Concrete",
    bullets: ["Use masonry fixings"],
  });

  if (hasSpider) {
    sections.push({
      heading: "Spider Brackets",
      bullets: [
        "Designed for heavy loads",
        "Secure through multiple fixing points",
        "Ensure bracket fully engaged before loading",
      ],
    });
  }

  if (hasUnhanded) {
    sections.push({
      heading: "Unhanded Brackets",
      bullets: [
        "Typically used in kitchen wall units",
        "Allow minor height adjustment",
        "Lock bracket after levelling",
      ],
    });
  }

  return {
    id: "wall-hanging",
    label: "Wall Hanging Guide",
    badge: "Installation",
    sections,
  };
}

// ── Panel component ──

interface InstallationPanelProps {
  fittings?: ResolvedFitting[];
}

export function InstallationPanel({ fittings = [] }: InstallationPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedGuide, setSelectedGuide] = useState<GuideItem | null>(null);

  const guides = useMemo(() => {
    const items: GuideItem[] = [
      CONNECTING_CABINETS,
      FILLERS_SCRIBING,
      LEVELLING_SECURING,
      buildWallHangingGuide(fittings),
      PAINTING_GUIDE,
    ];

    if (detectDoors(fittings)) {
      items.push(DOOR_ADJUSTMENT);
    }

    return items;
  }, [fittings]);

  return (
    <>
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
          <span className="font-medium">Guides</span>
          <span className="ml-auto text-[12px] text-[var(--muted)]">
            {guides.length}
          </span>
        </button>

        {expanded && (
          <ul className="flex flex-col">
            {guides.map((guide) => (
              <li key={guide.id}>
                <button
                  onClick={() => setSelectedGuide(guide)}
                  className="flex items-center w-full gap-2 rounded-lg px-3 py-1.5 text-[13px] text-[var(--muted)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors active:scale-[0.98]"
                  style={{ paddingLeft: 28 }}
                >
                  <span className="flex-1 text-left truncate">
                    {guide.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedGuide && (
        <GuideModal
          guide={selectedGuide}
          onClose={() => setSelectedGuide(null)}
        />
      )}
    </>
  );
}

// ── Guide modal ──

function GuideModal({
  guide,
  onClose,
}: {
  guide: GuideItem;
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

      <div className="relative bg-[var(--card-bg)] rounded-2xl shadow-2xl max-w-md w-full max-h-[80vh] flex flex-col animate-scale-in border border-[var(--sidebar-border)]/50">
        {/* Header */}
        <div className="px-6 pt-6 pb-0 flex-shrink-0">
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

          <span className="inline-block rounded-md bg-black/5 dark:bg-white/10 px-2 py-0.5 text-[11px] text-[var(--muted)] font-medium uppercase tracking-wider mb-3">
            {guide.badge}
          </span>

          <h3 className="text-[18px] font-semibold text-[var(--foreground)] mb-4">
            {guide.label}
          </h3>
        </div>

        {/* Scrollable content */}
        <div className="px-6 pb-2 overflow-y-auto flex-1 min-h-0">
          <div className="space-y-4">
            {guide.sections.map((section, i) => (
              <div key={i}>
                {section.heading && (
                  <p className="text-[13px] font-semibold text-[var(--foreground)] mb-1.5">
                    {section.heading}
                  </p>
                )}

                {section.bullets && (
                  <ul className="space-y-1">
                    {section.bullets.map((bullet, j) => (
                      <li
                        key={j}
                        className="flex items-start gap-2 text-[13px] text-[var(--muted)] leading-relaxed"
                      >
                        <span className="text-[var(--accent)] flex-shrink-0 mt-0.5">
                          •
                        </span>
                        {bullet}
                      </li>
                    ))}
                  </ul>
                )}

                {section.note && (
                  <div
                    className={`rounded-lg px-3 py-2.5 text-[12px] leading-relaxed ${
                      section.note.type === "warning"
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        : "bg-blue-500/10 text-blue-700 dark:text-blue-400"
                    }`}
                  >
                    {section.note.text}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pt-2 pb-6 flex-shrink-0">
          <button
            onClick={onClose}
            className="w-full rounded-xl bg-black/5 dark:bg-white/10 px-4 py-2.5 text-[14px] font-medium text-[var(--foreground)] hover:opacity-90 transition-all active:scale-[0.98]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
