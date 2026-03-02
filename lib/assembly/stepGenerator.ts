/**
 * Rule-Based Step Generator
 *
 * Generates assembly steps dynamically based on which panel groups exist
 * in the cabinet model. Handles:
 * - Fixed shelves: before sides (access constraint)
 * - Face frames: early (cam access)
 * - Rear brace: after back
 * - Overlay bottom (upper unit): base step after sides when flag set
 * - Drawers: separate step, not in carcass
 */

import type { StepHelper } from "../assemblyGuides";

export type GroupKey = string;

export interface CabinetFlags {
  /** Upper unit / dresser: bottom overlays sides, must be fitted AFTER sides */
  bottomOverlaysSides?: boolean;
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

  const faceFrameKeys: GroupKey[] = [];
  if (has("Face Frame - Top")) faceFrameKeys.push("Face Frame - Top");
  if (has("Face Frame - Left")) faceFrameKeys.push("Face Frame - Left");
  if (has("Face Frame - Right")) faceFrameKeys.push("Face Frame - Right");
  if (has("Face Frame - Divider")) faceFrameKeys.push("Face Frame - Divider");
  if (has("Face Frame") && faceFrameKeys.length === 0) faceFrameKeys.push("Face Frame");

  const drawerKeys: GroupKey[] = [];
  if (has("Drawer Box - Left")) drawerKeys.push("Drawer Box - Left");
  if (has("Drawer Box - Right")) drawerKeys.push("Drawer Box - Right");
  if (has("Drawer Box - Back")) drawerKeys.push("Drawer Box - Back");
  if (has("Drawer Box - Bottom")) drawerKeys.push("Drawer Box - Bottom");
  if (has("Drawer")) drawerKeys.push("Drawer");

  const bottomOverlaysSides = flags.bottomOverlaysSides ?? false;

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
            title: "Common mistakes",
            content:
              "Over-tightening corner clips — hand-tight is sufficient. Check the drawer box is square before fitting the bottom panel.",
          },
          {
            title: "Professional tip",
            content:
              "Pre-fit runners to the side panels before carcass assembly for faster installation later.",
          },
        ],
      }
    );
  }

  // ── Base step (Bottom + Plinth) ──
  if (!bottomOverlaysSides && (hasBottom || hasPlinth)) {
    addStep(["Bottom", "Plinth"], "Connect the bottom and plinth panels.", {
      usesFittings: true,
      helpers: [
        {
          title: "Professional tip",
          content:
            "Lay the plinth face-down, align the bottom panel, and lock the cams before lifting.",
        },
      ],
    });
  }

  // ── Divider + Top + Face Frame Top/Divider (attach face frames with their panels) ──
  const dividerTopKeys: GroupKey[] = ["Vertical Division", "Top"];
  if (has("Face Frame - Top")) dividerTopKeys.push("Face Frame - Top");
  if (has("Face Frame - Divider")) dividerTopKeys.push("Face Frame - Divider");
  if (has("Face Frame") && faceFrameKeys.length === 0)
    dividerTopKeys.push("Face Frame");
  addStep(
    dividerTopKeys,
    dividerTopKeys.some((k) => k.startsWith("Face Frame"))
      ? "Fit the divider and top panel, with their face frame pieces attached."
      : "Fit the divider and top panel.",
    {
      usesFittings: true,
      helpers: [
        {
          title: "Before tightening",
          content:
            "Ensure the divider is perfectly flush with the top edge before locking cams.",
        },
      ],
    }
  );

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

  // ── Sides + Face Frame Left/Right (attach face frames with their panels) ──
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
          title: "Professional tip",
          content:
            "Have a second person hold the sides while you lock the cams for easier alignment.",
        },
      ],
    }
  );

  // ── Overlay bottom (AFTER sides when flag set) ──
  if (bottomOverlaysSides && (hasBottom || hasPlinth)) {
    addStep(["Bottom", "Plinth"], "Connect the bottom and plinth panels.", {
      usesFittings: true,
      helpers: [
        {
          title: "Why this matters",
          content:
            "On this unit, the bottom overlays the sides and must be fitted after them.",
        },
      ],
    });
  }

  // ── Back ──
  addStep(["Back"], "Secure the back panels to square the cabinet.", {
    usesFittings: true,
    helpers: [
      {
        title: "Before tightening",
        content:
          "Check the cabinet is square by measuring corner-to-corner diagonals — they should be equal.",
      },
      {
        title: "Professional tip",
        content:
          "Start with the centre screws, then work outwards to keep the back aligned.",
      },
    ],
  });

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
        title: "Professional tip",
        content:
          "Hang doors with hinges loose, align gaps evenly (~3mm), then tighten.",
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
            title: "Professional tip",
            content:
              "Push each drawer in firmly until the runners click. Test the slide action before moving on.",
          },
        ],
      }
    );
  }

  // ── Counter top ──
  addStep(["Counter Top"], "Place the counter top to finish.");

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
