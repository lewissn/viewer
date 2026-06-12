/**
 * Rule-Based Step Generator
 *
 * Generates assembly steps dynamically based on which panel groups exist
 * in the cabinet model. Handles:
 * - No-divider flow: sequential side-by-side assembly (Left Side anchors the build)
 * - Divider flow: inner structure first, then sides
 * - Fixed shelves: before sides/right side (access constraint)
 * - Face frames: early (cam access)
 * - Rear brace: after back
 * - Overlay bottom (upper unit): base step after sides when flag set
 * - Overlay top: top step after back but before rear brace / wall bar when flag set
 * - Drawers: separate step, not in carcass
 */

import type { StepHelper } from "../assemblyGuides";

export type GroupKey = string;

export interface CabinetFlags {
  /** Upper unit / dresser: bottom overlays sides, must be fitted AFTER sides */
  bottomOverlaysSides?: boolean;
  /** Top overlays sides: top must be fitted LAST, after the back but before the wall bar */
  topOverlaysSides?: boolean;
}

export interface AssemblyStepBlock {
  groupKeys: GroupKey[];
  copy: string;
  /** assembleFirst = show one drawer only; insertAll = show all drawers sliding in */
  drawerMode?: "assembleFirst" | "insertAll";
  /** Optional expandable helper blocks */
  helpers?: StepHelper[];
  /** Step uses fittings from the sidebar */
  usesFittings?: boolean;
}

/**
 * Generate ordered assembly steps from detected groups and cabinet flags.
 * Skips steps for groups that don't exist.
 */
export function generateSteps(
  groupsPresent: Set<GroupKey>,
  flags: CabinetFlags = {}
): AssemblyStepBlock[] {
  const has = (key: GroupKey) => groupsPresent.has(key);
  const steps: AssemblyStepBlock[] = [];

  // Helper: add step only if any of its groups exist
  function addStep(
    keys: GroupKey[],
    copy: string,
    meta?: { helpers?: StepHelper[]; usesFittings?: boolean }
  ) {
    const present = keys.filter((k) => has(k));
    if (present.length > 0) {
      steps.push({
        groupKeys: present,
        copy,
        helpers: meta?.helpers,
        usesFittings: meta?.usesFittings,
      });
    }
  }

  const hasBottom = has("Bottom");
  const hasPlinth = has("Plinth");
  const hasFixedShelf = has("Fixed Shelf");
  const hasFaceFrames =
    has("Face Frame - Top") ||
    has("Face Frame - Left") ||
    has("Face Frame - Right") ||
    has("Face Frame - Divider") ||
    has("Face Frame");
  const hasDrawers =
    has("Drawer Box - Left") ||
    has("Drawer Box - Right") ||
    has("Drawer Box - Back") ||
    has("Drawer Box - Bottom") ||
    has("Drawer");

  const drawerKeys: GroupKey[] = [];
  if (has("Drawer Box - Left")) drawerKeys.push("Drawer Box - Left");
  if (has("Drawer Box - Right")) drawerKeys.push("Drawer Box - Right");
  if (has("Drawer Box - Back")) drawerKeys.push("Drawer Box - Back");
  if (has("Drawer Box - Bottom")) drawerKeys.push("Drawer Box - Bottom");
  if (has("Drawer")) drawerKeys.push("Drawer");

  const bottomOverlaysSides = flags.bottomOverlaysSides ?? false;
  const topOverlaysSides = flags.topOverlaysSides ?? false;
  const hasDivider = has("Vertical Division");

  // Helper: add step with optional meta
  function addStepWithMeta(
    keys: GroupKey[],
    copy: string,
    meta?: {
      drawerMode?: "assembleFirst" | "insertAll";
      helpers?: StepHelper[];
      usesFittings?: boolean;
    }
  ) {
    const present = keys.filter((k) => has(k));
    if (present.length > 0) {
      steps.push({
        groupKeys: present,
        copy,
        drawerMode: meta?.drawerMode,
        helpers: meta?.helpers,
        usesFittings: meta?.usesFittings,
      });
    }
  }

  // ── DRAWER ASSEMBLY (first — get it out of the way) ──
  if (drawerKeys.length > 0) {
    addStepWithMeta(
      drawerKeys,
      "Assemble this drawer first. Repeat for any other drawers in the same way.",
      {
        drawerMode: "assembleFirst",
        usesFittings: true,
        helpers: [
          {
            title: "Drawer identification",
            content:
              "Each drawer part label ends with an ID number (e.g. [1]_1, [2]_1). Match parts with the same number to build the correct drawer.",
          },
          {
            title: "Common mistakes",
            content:
              "Over-tightening Rafix cams — this can damage the screw and make disassembly difficult. Tighten until snug, then stop.",
          },
          {
            title: "Professional tip",
            content:
              "Pre-fit the undermount runners to the cabinet side panels before carcass assembly — it saves time later.",
          },
        ],
      }
    );
  }

  // ── CARCASS ASSEMBLY ──
  // Two flows based on whether the cabinet has vertical dividers:
  // - No-divider flow: sequential side-by-side assembly (Left Side anchors the build)
  // - Divider flow: inner structure (bottom + dividers + top) first, then both sides
  const noDividerFlow = !hasDivider && !bottomOverlaysSides;

  if (noDividerFlow) {
    // ── No-divider flow ──
    // Simple box cabinets: anchor on the left side, then close with the right side.

    if (hasBottom) {
      // Step: Bottom (+ Plinth) + Left Side
      const baseLeftKeys: GroupKey[] = ["Bottom"];
      if (hasPlinth) baseLeftKeys.push("Plinth");
      baseLeftKeys.push("Left Side");
      if (has("Face Frame - Left")) baseLeftKeys.push("Face Frame - Left");

      const baseCopy = hasPlinth
        ? "Secure the bottom and plinth panels to the left side."
        : "Secure the bottom panel to the left side.";

      addStep(baseLeftKeys, baseCopy, {
        usesFittings: true,
        helpers: [
          {
            title: "Getting started",
            content: hasPlinth
              ? "Lay the plinth and bottom panels flat with the front edges facing the floor. Connect the plinth to the bottom first, then align the left side panel and lock the cams."
              : "Lay the bottom panel flat with the front edge facing the floor. Align the left side panel and lock the cams.",
          },
          {
            title: "Before tightening",
            content:
              "Insert all Rafix cam screws and tap cams into place before connecting. Do not over-tighten — snug is sufficient.",
          },
        ],
      });

      // Step: Top to Left Side
      // Top is the natural anchor for any orphaned face-frame parts in the
      // no-divider flow: bare "Face Frame" parent panels (un-split bookcase FF)
      // and FF Divider (ICB) pieces if they ever appear without a vertical
      // division (e.g. when ICBs anchor to fixed shelves instead).
      // Skipped when the top overlays the sides — it gets its own step after
      // the back, before the wall bar.
      if (!topOverlaysSides) {
        const topKeys: GroupKey[] = ["Top"];
        if (has("Face Frame - Top")) topKeys.push("Face Frame - Top");
        if (has("Face Frame - Divider")) topKeys.push("Face Frame - Divider");
        if (has("Face Frame")) topKeys.push("Face Frame");
        addStep(topKeys, "Attach the top panel to the left side.", {
          usesFittings: true,
          helpers: [
            {
              title: "Before tightening",
              content:
                "With the structure still front-edge-down, position the top panel onto the left side and lock the cams. Ensure edges are flush before tightening.",
            },
          ],
        });
      }
    } else if (topOverlaysSides) {
      // No bottom panel + overlay top: anchor on the left side alone.
      const leftKeys: GroupKey[] = ["Left Side"];
      if (has("Face Frame - Left")) leftKeys.push("Face Frame - Left");

      addStep(leftKeys, "Lay the left side panel down to start the build.", {
        usesFittings: true,
        helpers: [
          {
            title: "Getting started",
            content:
              "Lay the left side panel flat with the front edge facing the floor. The top panel overlays the sides on this unit, so it is fitted at the end — not now.",
          },
          {
            title: "Before tightening",
            content:
              "Insert all Rafix cam screws and tap cams into place before connecting. Do not over-tighten — snug is sufficient.",
          },
        ],
      });
    } else {
      // No bottom panel: Start with Top + Left Side
      const topLeftKeys: GroupKey[] = ["Top", "Left Side"];
      if (has("Face Frame - Top")) topLeftKeys.push("Face Frame - Top");
      if (has("Face Frame - Left")) topLeftKeys.push("Face Frame - Left");
      if (has("Face Frame - Divider")) topLeftKeys.push("Face Frame - Divider");
      if (has("Face Frame")) topLeftKeys.push("Face Frame");

      addStep(topLeftKeys, "Attach the top panel to the left side.", {
        usesFittings: true,
        helpers: [
          {
            title: "Getting started",
            content:
              "Lay the top panel flat with the front edge facing the floor. Align the left side panel and lock the cams.",
          },
          {
            title: "Before tightening",
            content:
              "Insert all Rafix cam screws and tap cams into place before connecting. Do not over-tighten — snug is sufficient.",
          },
        ],
      });
    }

    // Fixed shelves (before right side — access constraint)
    if (hasFixedShelf) {
      addStep(
        ["Fixed Shelf"],
        "Fit the fixed shelves before closing the cabinet with the right side.",
        {
          usesFittings: true,
          helpers: [
            {
              title: "Why this matters",
              content:
                "Fixed shelves cannot be inserted after the right side is fitted — they must go in now.",
            },
            {
              title: "Common mistakes",
              content:
                "Fitting shelves upside down — check edge banding faces forward.",
            },
          ],
        }
      );
    }

    // Right Side (completes the carcass frame)
    const rightKeys: GroupKey[] = ["Right Side"];
    if (has("Face Frame - Right")) rightKeys.push("Face Frame - Right");
    addStep(
      rightKeys,
      rightKeys.some((k) => k.startsWith("Face Frame"))
        ? "Attach the right side to complete the carcass frame, with the face frame piece attached."
        : "Attach the right side to complete the carcass frame.",
      {
        usesFittings: true,
        helpers: [
          {
            title: "Before tightening",
            content:
              "Position the right side panel with cam screws aligned and fasten. Do not over-tighten Rafix cams.",
          },
          {
            title: "Professional tip",
            content:
              "This stage can be heavy — have a second person hold the side while you lock the cams for easier alignment.",
          },
        ],
      }
    );
  } else {
    // ── Divider / upper-unit flow ──
    // Inner structure first (bottom + dividers + top), then both sides together.

    // Base step (Bottom + Plinth) — only for non-overlay units
    if (!bottomOverlaysSides && (hasBottom || hasPlinth)) {
      const baseCopy =
        hasBottom && hasPlinth
          ? "Connect the bottom and plinth panels."
          : hasBottom
            ? "Position the bottom panel."
            : "Position the plinth panel.";

      const baseHelpers: StepHelper[] = [
        {
          title: "Before tightening",
          content:
            "Insert all Rafix cam screws and tap Rafix cams into place before connecting. Do not over-tighten — snug is sufficient.",
        },
      ];

      if (hasPlinth) {
        baseHelpers.push({
          title: "Professional tip",
          content:
            "Lay the plinth face-down with the front edge on the floor, align the bottom panel, and lock the cams. The cabinet is built front-edges-down and lifted upright once complete.",
        });
      } else {
        baseHelpers.push({
          title: "Professional tip",
          content:
            "Lay the bottom panel face-down with the front edge on the floor. The cabinet is built front-edges-down and lifted upright once complete.",
        });
      }

      addStep(["Bottom", "Plinth"], baseCopy, {
        usesFittings: true,
        helpers: baseHelpers,
      });
    }

    // ── Divider + Top + Face Frame Top/Divider ──
    // ICB (Face Frame - Divider) anchors to the Vertical Division panels,
    // UCB (Face Frame - Top) anchors to the Top panel — both attach in this
    // step before the inner structure is connected. The bare "Face Frame"
    // group catches any un-split parent face-frame panel so it is never
    // orphaned to the end of the guide.
    // When the top overlays the sides, it (and its face frame) is excluded
    // here — it gets its own step after the back, before the wall bar.
    const dividerTopKeys: GroupKey[] = ["Vertical Division"];
    if (!topOverlaysSides) dividerTopKeys.push("Top");
    if (!topOverlaysSides && has("Face Frame - Top"))
      dividerTopKeys.push("Face Frame - Top");
    if (has("Face Frame - Divider")) dividerTopKeys.push("Face Frame - Divider");
    if (has("Face Frame")) dividerTopKeys.push("Face Frame");
    {
      // Build contextual helper text based on which parts actually exist
      let beforeTighteningContent: string;
      if (hasDivider) {
        const structureParts: string[] = [];
        if (!topOverlaysSides) structureParts.push("the top");
        if (hasBottom) structureParts.push(topOverlaysSides ? "the bottom" : "bottom");
        structureParts.push("divider(s)");
        beforeTighteningContent = topOverlaysSides
          ? `With the front edges facing the floor, connect ${structureParts.join(", ")} to form the inner structure. The top panel overlays the sides on this unit and is fitted at the end — not now.`
          : `With the front edges facing the floor, connect ${structureParts.join(", ")} to form the inner structure. Ensure the divider is flush with the top edge before locking cams.`;
      } else {
        beforeTighteningContent =
          "With the front edges facing the floor, position the top panel and lock the cams.";
      }

      const dividerHelpers: StepHelper[] = [
        {
          title: "Before tightening",
          content: beforeTighteningContent,
        },
      ];
      if (hasDivider) {
        dividerHelpers.push({
          title: "Divider orientation",
          content:
            "MDF dividers have a tenon (tongue) at the top and bottom — the flat side faces left unless your plans show otherwise. Pre-finished panels use Rafix cams only; check the label for orientation.",
        });
      }
      const hasFFInStep = dividerTopKeys.some((k) => k.startsWith("Face Frame"));
      const dividerTopCopy = topOverlaysSides
        ? hasFFInStep
          ? "Fit the divider(s), with their face frame pieces attached."
          : "Fit the divider(s) to form the inner structure."
        : hasFFInStep
          ? hasDivider
            ? "Fit the divider and top panel, with their face frame pieces attached."
            : "Fit the top panel, with the face frame piece attached."
          : hasDivider
            ? "Fit the divider and top panel to form the inner structure."
            : "Fit the top panel.";
      addStep(
        dividerTopKeys,
        dividerTopCopy,
        {
          usesFittings: true,
          helpers: dividerHelpers,
        }
      );
    }

    // ── Fixed shelves (MUST be before sides) ──
    if (hasFixedShelf) {
      addStep(
        ["Fixed Shelf"],
        "Fit the fixed shelves before closing the cabinet with the sides.",
        {
          usesFittings: true,
          helpers: [
            {
              title: "Why this matters",
              content:
                "Fixed shelves cannot be inserted after the sides are fitted — they must go in now.",
            },
            {
              title: "Common mistakes",
              content:
                "Fitting shelves upside down — check edge banding faces forward.",
            },
          ],
        }
      );
    }

    // ── Sides + Face Frame Left/Right ──
    const sidesKeys: GroupKey[] = ["Left Side", "Right Side"];
    if (has("Face Frame - Left")) sidesKeys.push("Face Frame - Left");
    if (has("Face Frame - Right")) sidesKeys.push("Face Frame - Right");
    addStep(
      sidesKeys,
      sidesKeys.some((k) => k.startsWith("Face Frame"))
        ? "Attach the left and right sides, with their face frame pieces attached."
        : "Attach the left and right sides.",
      {
        usesFittings: true,
        helpers: [
          {
            title: "Before tightening",
            content:
              "With the cabinet still front-edges-down, position each side panel with cam screws aligned and fasten. Do not over-tighten Rafix cams.",
          },
          {
            title: "Professional tip",
            content:
              "This stage can be heavy — have a second person hold the sides while you lock the cams for easier alignment.",
          },
        ],
      }
    );

    // ── Overlay bottom (AFTER sides when flag set) ──
    if (bottomOverlaysSides && (hasBottom || hasPlinth)) {
      addStep(
        ["Bottom", "Plinth"],
        "Align and fix the bottom panel to the structure.",
        {
          usesFittings: true,
          helpers: [
            {
              title: "Why this matters",
              content:
                "On upper units, the bottom overlays the sides and is fixed last using 40mm screws. Do not attempt to fit it before the sides and back are in place.",
            },
            {
              title: "Professional tip",
              content:
                "Build the upper unit lying flat — start with the top panel front-edge-down, connect dividers and sides, fit the back, then fix the bottom last. Stand the unit upright only when fully assembled.",
            },
          ],
        }
      );
    }
  }

  // ── Back ──
  addStep(["Back"], "Secure the back panels to square the cabinet.", {
    usesFittings: true,
    helpers: [
      {
        title: "Before tightening",
        content:
          "With the cabinet still face-down, slide the back panel into the grooves until flush with the top. Measure diagonally — top-left to bottom-right, then top-right to bottom-left — both should match. Adjust gently until square, then fix.",
      },
      {
        title: "Why this matters",
        content:
          "The back panel locks the cabinet's shape. Fixing it while out of square will cause door alignment issues later.",
      },
      {
        title: "Professional tip",
        content:
          "Start with the centre screws, then work outwards to keep the back aligned. Once the back is fixed, stand the cabinet upright onto its feet.",
      },
    ],
  });

  // ── Overlay top (AFTER back, BEFORE rear brace / wall bar) ──
  if (topOverlaysSides) {
    const lateTopKeys: GroupKey[] = ["Top"];
    if (has("Face Frame - Top")) lateTopKeys.push("Face Frame - Top");
    // In the no-divider flow these orphaned face-frame parts would normally
    // anchor to the early top step — keep them with the top when it moves late.
    if (noDividerFlow) {
      if (has("Face Frame - Divider")) lateTopKeys.push("Face Frame - Divider");
      if (has("Face Frame")) lateTopKeys.push("Face Frame");
    }
    addStep(
      lateTopKeys,
      "Align and fix the top panel over the sides to close the structure.",
      {
        usesFittings: true,
        helpers: [
          {
            title: "Why this matters",
            content:
              "On this unit, the top overlays the side panels and is fixed last — after the sides and back are in place, but before the wall bar. Do not attempt to fit it earlier.",
          },
          {
            title: "Before tightening",
            content:
              "Position the top panel so it sits flush over both side panels, check the front edges line up, then fix through the pre-drilled holes.",
          },
        ],
      }
    );
  }

  // ── Rear brace (MUST be after Back) ──
  if (has("Rear Brace")) {
    addStep(
      ["Rear Brace"],
      "Fit the rear brace after the back panels are installed.",
      { usesFittings: true }
    );
  }

  // ── Doors ──
  addStep(["Door"], "Fit the doors to the carcass.", {
    usesFittings: true,
    helpers: [
      {
        title: "Before tightening",
        content:
          "Attach hinges to the door using 16mm screws, then clip onto the hinge plates. Leave the adjustment screws loose until all doors are hung.",
      },
      {
        title: "Adjusting your hinges",
        content:
          "Each hinge has three adjustments: height (via mounting plate), side (screw on hinge arm), and depth (cam adjuster on hinge arm). Aim for even 3mm gaps on all sides.",
      },
    ],
  });

  // ── DRAWER INSERT (drawers slide in at end; they were hidden during carcass) ──
  if (drawerKeys.length > 0) {
    addStepWithMeta(
      drawerKeys,
      "Slide each assembled drawer into its opening in the cabinet.",
      {
        drawerMode: "insertAll",
        helpers: [
          {
            title: "Common mistakes",
            content:
              "If one side clicks and the other doesn't, remove the drawer and try again — don't force it.",
          },
          {
            title: "Adjusting your drawers",
            content:
              "Under each drawer are three adjustments in the clips: up/down (height), left/right (gap between drawers), and in/out (how far the front sits against the cabinet).",
          },
        ],
      }
    );
  }

  // ── Counter top ──
  addStep(["Counter Top"], "Place the counter top to finish.", {
    usesFittings: true,
    helpers: [
      {
        title: "Before tightening",
        content:
          "Insert wooden dowels into the holes on top for alignment, then fix using 30mm screws through the pre-drilled holes inside the unit.",
      },
      {
        title: "Common mistakes",
        content:
          "Gaps between the countertop and carcass — loosen the screw, press the joint closed, then re-tighten.",
      },
    ],
  });

  // ── Shelves (removable, not fixed) ──
  if (has("Shelf")) {
    addStep(["Shelf"], "Insert the shelves.");
  }

  // ── Fillers ──
  const fillerKeys: GroupKey[] = [];
  if (has("Filler - Side")) fillerKeys.push("Filler - Side");
  if (has("Filler - Front")) fillerKeys.push("Filler - Front");
  if (has("Filler") && fillerKeys.length === 0) fillerKeys.push("Filler");
  if (fillerKeys.length > 0) {
    addStep(fillerKeys, "Fit any filler panels as required.");
  }

  // ── Hinges (if any) ──
  if (has("Hinge")) {
    addStep(["Hinge"], "Fit the hinges.");
  }

  return steps;
}
