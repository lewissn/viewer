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

export type GroupKey = string;

export interface CabinetFlags {
  /** Upper unit / dresser: bottom overlays sides, must be fitted AFTER sides */
  bottomOverlaysSides?: boolean;
}

export interface AssemblyStepBlock {
  groupKeys: GroupKey[];
  copy: string;
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
  function addStep(keys: GroupKey[], copy: string) {
    const present = keys.filter((k) => has(k));
    if (present.length > 0) {
      steps.push({ groupKeys: present, copy });
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

  // ── Base step (Bottom + Plinth) ──
  // If bottomOverlaysSides: defer to after sides
  if (!bottomOverlaysSides && (hasBottom || hasPlinth)) {
    addStep(["Bottom", "Plinth"], "Connect the bottom and plinth panels.");
  }

  // ── Divider + Top (Vertical Divider is synonym for Vertical Division) ──
  addStep(
    ["Vertical Division", "Top"],
    "Fit the divider and top panel."
  );

  // ── Fixed shelves (MUST be before sides) ──
  if (hasFixedShelf) {
    addStep(
      ["Fixed Shelf"],
      "Fit the fixed shelves before closing the cabinet with the sides."
    );
  }

  // ── Face frames (early, before back/doors for cam access) ──
  if (faceFrameKeys.length > 0) {
    addStep(
      faceFrameKeys,
      "Attach the face frame panels while fixings remain accessible."
    );
  }

  // ── Sides ──
  addStep(["Left Side", "Right Side"], "Attach the left and right sides.");

  // ── Overlay bottom (AFTER sides when flag set) ──
  if (bottomOverlaysSides && (hasBottom || hasPlinth)) {
    addStep(["Bottom", "Plinth"], "Connect the bottom and plinth panels.");
  }

  // ── Back ──
  addStep(["Back"], "Secure the back panels to square the cabinet.");

  // ── Rear brace (MUST be after Back) ──
  if (has("Rear Brace")) {
    addStep(
      ["Rear Brace"],
      "Fit the rear brace after the back panels are installed."
    );
  }

  // ── Doors ──
  addStep(["Door"], "Fit the doors to the carcass.");

  // ── Drawers (separate step, after carcass) ──
  if (drawerKeys.length > 0) {
    addStep(
      drawerKeys,
      "Assemble the drawers, then slide them into the cabinet."
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
