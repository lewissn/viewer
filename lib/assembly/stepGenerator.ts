/**
 * Rule-Based Step Generator
 *
 * Generates assembly steps dynamically based on which panel groups exist
 * in the cabinet model. Handles:
 * - No-divider flow: sequential side-by-side assembly (Left Side anchors the build)
 * - Divider flow: bottom, then dividers, then top, then sides
 * - Fixed shelves: before sides/right side (access constraint)
 * - Assembly-first flow: when the model has shelves trapped between two
 *   dividers ("Fixed Shelf - Centre", split out geometrically by the
 *   controller), the inner assembly is built first and the surrounding panels
 *   are brought to it — dividers, centre shelves, outer shelves, base, top,
 *   sides. Those shelves cannot be inserted once the dividers meet the base.
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
  /**
   * Number of vertical divider panels, used for the copy that explains how many
   * columns the cabinet has. The build order itself keys off whether the model
   * actually has shelves trapped between dividers ("Fixed Shelf - Centre"),
   * not off this count. Defaults to 1 when dividers are present but no count
   * was supplied.
   */
  dividerCount?: number;
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
  const hasTop = has("Top");
  const hasPlinth = has("Plinth");
  // On multi-divider units the controller splits "Fixed Shelf" into centre and
  // outer subgroups by geometry. A centre shelf sits between two dividers and
  // is trapped once they meet the base panel, which changes the whole build
  // order; the bare group means no split applied.
  const hasCentreShelf = has("Fixed Shelf - Centre");
  const hasOuterShelf = has("Fixed Shelf - Outer");
  const hasFixedShelf = has("Fixed Shelf") || hasCentreShelf || hasOuterShelf;
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
  const dividerCount = hasDivider ? Math.max(1, flags.dividerCount ?? 1) : 0;

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
  // - Divider flow: base, then dividers, then top, then both sides
  const noDividerFlow = !hasDivider && !bottomOverlaysSides;

  // Face-frame parts the carcass flow could not anchor to an early step; the
  // late overlay-top step picks these up so they never fall to the end.
  const orphanFFKeys: GroupKey[] = [];

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

    // Fixed shelves (before right side — access constraint).
    // A cabinet reaching this flow has no dividers, so the centre/outer split
    // never applies; the subgroup keys are listed only for completeness.
    if (hasFixedShelf) {
      addStep(
        ["Fixed Shelf", "Fixed Shelf - Centre", "Fixed Shelf - Outer"],
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
    // Ordinary units: base, then dividers, then top, then both sides.
    // Units with shelves trapped between dividers: the divider assembly is
    // built first and the base panel is brought to it (see below).

    // Base step (Bottom + Plinth) — only for non-overlay units
    const addBaseStep = () => {
      if (bottomOverlaysSides || !(hasBottom || hasPlinth)) return;

      const baseCopy = hasCentreShelf
        ? hasBottom && hasPlinth
          ? "Connect the bottom and plinth panels to the divider assembly."
          : hasBottom
            ? "Connect the bottom panel to the divider assembly."
            : "Connect the plinth panel to the divider assembly."
        : hasBottom && hasPlinth
          ? "Connect the bottom and plinth panels."
          : hasBottom
            ? "Position the bottom panel."
            : "Position the plinth panel.";

      const baseHelpers: StepHelper[] = [
        {
          title: "Before tightening",
          content: hasCentreShelf
            ? "Lower the bottom panel onto the standing divider assembly and locate every tenon before locking any cams. Work across the cabinet rather than tightening one divider fully at a time."
            : "Insert all Rafix cam screws and tap Rafix cams into place before connecting. Do not over-tighten — snug is sufficient.",
        },
      ];

      if (hasPlinth) {
        baseHelpers.push({
          title: "Professional tip",
          content: hasCentreShelf
            ? "Fit the plinth to the bottom panel once the bottom is locked to the dividers. The cabinet is built front-edges-down and lifted upright once complete."
            : "Lay the plinth face-down with the front edge on the floor, align the bottom panel, and lock the cams. The cabinet is built front-edges-down and lifted upright once complete.",
        });
      } else {
        baseHelpers.push({
          title: "Professional tip",
          content: hasCentreShelf
            ? "The cabinet is built front-edges-down and lifted upright once complete."
            : "Lay the bottom panel face-down with the front edge on the floor. The cabinet is built front-edges-down and lifted upright once complete.",
        });
      }

      addStep(["Bottom", "Plinth"], baseCopy, {
        usesFittings: true,
        helpers: baseHelpers,
      });
    };

    // ── Dividers, top panel and fixed shelves ──
    // The dividers and the top get a step each rather than arriving as one
    // pre-assembled inner structure: on a standard unit the dividers are stood
    // on the bottom first, then the top closes them. On an overlay-bottom
    // (upper) unit the build starts from the top panel instead, so the top is
    // positioned first and the dividers hang off it.
    //
    // ICB (Face Frame - Divider) anchors to the Vertical Division panels and
    // UCB (Face Frame - Top) to the Top panel, so each rides with its own step.
    // The bare "Face Frame" group catches any un-split parent face-frame panel
    // so it is never orphaned to the end of the guide.
    // When the top overlays the sides, it (and its face frame) is excluded
    // here — it gets its own step after the back, before the wall bar.
    const earlyTop = !topOverlaysSides && hasTop;

    const dividerKeys: GroupKey[] = ["Vertical Division"];
    const topKeys: GroupKey[] = ["Top"];

    // UCB face frames belong to the top panel, so they follow it: onto the
    // early top step here, or onto the late overlay-top step when the top moves
    // there. Only a unit with no top panel at all falls back to the dividers.
    if (has("Face Frame - Top")) {
      if (earlyTop) topKeys.push("Face Frame - Top");
      else if (!topOverlaysSides) dividerKeys.push("Face Frame - Top");
    }

    // ICB face frames anchor to the divider panels; without dividers they ride
    // with the top. Un-split parent FF panels ride with the early top step when
    // there is one, otherwise they anchor to the dividers. Anything with nowhere
    // to go is picked up by the late overlay-top step so it never falls to the
    // end of the guide.
    for (const ffKey of ["Face Frame - Divider", "Face Frame"] as GroupKey[]) {
      if (!has(ffKey)) continue;
      if (hasDivider && ffKey === "Face Frame - Divider")
        dividerKeys.push(ffKey);
      else if (earlyTop) topKeys.push(ffKey);
      else if (hasDivider) dividerKeys.push(ffKey);
      else orphanFFKeys.push(ffKey);
    }

    // A centre shelf is one the controller found sitting between two dividers.
    // Those are trapped: once the dividers meet the base panel the inner
    // column(s) are closed on both sides and the shelf can no longer be slid in
    // from either direction. So the build inverts — the dividers are laid out
    // first, the shelves are connected to them, and the base panel is brought
    // to the finished assembly rather than the other way round. This also keeps
    // every step anchored to something already on screen, instead of shelves
    // hanging in mid-air waiting for dividers that have not appeared yet.
    //
    // Without centre shelves nothing is trapped, so the ordinary order stands.
    const assemblyFirst = hasCentreShelf;

    // Panel the divider assembly meets: the bottom on a normal unit, the top on
    // an upper unit (which is built top-down).
    const dividerAnchor = bottomOverlaysSides
      ? "the top panel"
      : hasBottom
        ? "the bottom panel"
        : "the base";

    const addDividerStep = () => {
      const hasFF = dividerKeys.some((k) => k.startsWith("Face Frame"));

      // Without divider panels this step carries only the face-frame pieces
      // that had no other panel to anchor to — addStep drops it entirely if
      // neither is present.
      let copy: string;
      if (!hasDivider) {
        copy = "Attach the face frame pieces to their panels.";
      } else if (assemblyFirst) {
        // Nothing else is on the bench yet — the dividers start the build and
        // the shelves are connected to them over the next steps.
        copy = hasFF
          ? "Lay the dividers out flat to begin the inner assembly, with their face frame pieces attached."
          : "Lay the dividers out flat to begin the inner assembly.";
      } else {
        copy = hasFF
          ? `Connect the divider(s) to ${dividerAnchor}, with their face frame pieces attached.`
          : `Connect the divider(s) to ${dividerAnchor}.`;
      }

      const helpers: StepHelper[] = [];
      if (hasDivider) {
        helpers.push({
          title: "Before tightening",
          content: assemblyFirst
            ? `Lay the dividers front-edge-down on the floor, spaced as they will sit in the cabinet. Nothing is fixed to ${dividerAnchor} yet — the shelves go in first and the whole assembly is fitted together later.`
            : bottomOverlaysSides
              ? "With the front edges facing the floor, seat each divider against the top panel and lock the cams. Check it is square before tightening."
              : `With the front edges facing the floor, stand each divider on ${dividerAnchor} and lock the cams. Check it is square before tightening.`,
        });
        helpers.push({
          title: "Divider orientation",
          content:
            "MDF dividers have a tenon (tongue) at the top and bottom — the flat side faces left unless your plans show otherwise. Pre-finished panels use Rafix cams only; check the label for orientation.",
        });
        if (assemblyFirst) {
          helpers.push({
            title: "Why this matters",
            content: `${dividerCount} dividers make ${dividerCount + 1} columns. The shelves in the inner column(s) are closed in once the dividers meet ${dividerAnchor}, so the inner structure is built as one piece first and fitted complete.`,
          });
        }
      }

      addStep(dividerKeys, copy, {
        usesFittings: true,
        helpers: helpers.length > 0 ? helpers : undefined,
      });
    };

    const addTopStep = () => {
      // Overlay tops are fitted after the back, in their own step further down.
      if (!earlyTop) return;
      const hasFF = topKeys.some((k) => k.startsWith("Face Frame"));

      let copy: string;
      let beforeTightening: string;
      if (bottomOverlaysSides) {
        // On an upper unit the top is the panel the assembly is fixed to, so
        // when the assembly is built first the top comes to it, not vice versa.
        copy = assemblyFirst
          ? hasFF
            ? "Connect the top panel to the divider assembly, with its face frame piece attached."
            : "Connect the top panel to the divider assembly."
          : hasFF
            ? "Position the top panel, with its face frame piece attached."
            : "Position the top panel to start the build.";
        beforeTightening = assemblyFirst
          ? "Lower the top panel onto the standing divider assembly and locate every tenon before locking any cams. This unit is built top-down and stood upright once complete."
          : "Lay the top panel face-down with the front edge on the floor. This unit is built top-down and stood upright once complete.";
      } else if (hasDivider) {
        copy = hasFF
          ? "Attach the top panel over the divider(s), with its face frame piece attached."
          : "Attach the top panel over the divider(s) to complete the inner structure.";
        beforeTightening =
          "With the front edges still facing the floor, lower the top panel onto the divider(s) and lock the cams. Ensure each divider is flush with the top edge before tightening.";
      } else {
        copy = hasFF
          ? "Fit the top panel, with the face frame piece attached."
          : "Fit the top panel.";
        beforeTightening =
          "With the front edges facing the floor, position the top panel and lock the cams.";
      }

      addStep(topKeys, copy, {
        usesFittings: true,
        helpers: [{ title: "Before tightening", content: beforeTightening }],
      });
    };

    const edgeBandingNote: StepHelper = {
      title: "Common mistakes",
      content: "Fitting shelves upside down — check edge banding faces forward.",
    };

    // Shelves between two dividers — the trapped ones. They go in while the
    // dividers are still loose and can be spread apart to take them.
    const addCentreShelfStep = () => {
      if (!hasCentreShelf) return;
      addStep(
        ["Fixed Shelf - Centre"],
        "Connect the centre fixed shelves between the dividers.",
        {
          usesFittings: true,
          helpers: [
            {
              title: "Why this matters",
              content: `These shelves sit in the inner column(s), enclosed by a divider on both sides. Once the dividers are fixed to ${dividerAnchor} there is no way to slide one in, so they have to go in now while the dividers are still free to move.`,
            },
            {
              title: "Before tightening",
              content:
                "Work with the dividers lying front-edge-down. Connect each shelf to one divider, then bring the second divider onto the shelf ends and lock the cams. Keep the assembly square as you go.",
            },
            edgeBandingNote,
          ],
        }
      );
    };

    // Shelves between a divider and a side panel — reachable from the open
    // side, but fitted now so the inner assembly goes in complete.
    const addOuterShelfStep = () => {
      if (!hasOuterShelf) return;
      addStep(
        ["Fixed Shelf - Outer"],
        "Connect the outer fixed shelves to the dividers.",
        {
          usesFittings: true,
          helpers: [
            {
              title: "Why this matters",
              content:
                "These shelves are open on one edge until the side panels go on, so they are not trapped like the centre shelves. Fitting them now keeps the whole inner assembly together as one piece.",
            },
            {
              title: "Before tightening",
              content:
                "Connect each shelf to the outer face of its divider. The unsupported edge is picked up by the side panel later — leave it free for now.",
            },
            edgeBandingNote,
          ],
        }
      );
    };

    // Ordinary shelf step, used when nothing is trapped. Covers the subgroup
    // keys too: the controller reverts to the bare group when it finds no
    // centre shelf, but listing them keeps this total so no shelf can be
    // dropped if a model ever splits into outer shelves alone.
    const addFixedShelfStep = () => {
      if (!hasFixedShelf) return;
      addStep(
        ["Fixed Shelf", "Fixed Shelf - Centre", "Fixed Shelf - Outer"],
        "Fit the fixed shelves before closing the cabinet with the sides.",
        {
          usesFittings: true,
          helpers: [
            {
              title: "Why this matters",
              content:
                "Fixed shelves cannot be inserted after the sides are fitted — they must go in now.",
            },
            edgeBandingNote,
          ],
        }
      );
    };

    if (assemblyFirst) {
      // Shelves are trapped between dividers, so the inner assembly is built
      // first and the surrounding panels are brought to it:
      //   dividers -> centre shelves -> outer shelves -> base -> top -> sides
      // Each step attaches to something already on screen, and nothing has to
      // hang unsupported waiting for a later part.
      addDividerStep();
      addCentreShelfStep();
      addOuterShelfStep();
      addBaseStep();
      addTopStep();
    } else if (bottomOverlaysSides) {
      // Upper unit: top panel is the base of the build, dividers hang from it.
      addTopStep();
      addDividerStep();
      addFixedShelfStep();
    } else {
      addBaseStep();
      addDividerStep();
      addTopStep();
      addFixedShelfStep();
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
    // These face-frame parts would normally anchor to the early top step —
    // keep them with the top when it moves late.
    if (noDividerFlow) {
      if (has("Face Frame - Divider")) lateTopKeys.push("Face Frame - Divider");
      if (has("Face Frame")) lateTopKeys.push("Face Frame");
    } else {
      lateTopKeys.push(...orphanFFKeys);
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
