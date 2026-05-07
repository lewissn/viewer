/**
 * Glossary
 *
 * Plain-English definitions for technical terms used in assembly step copy
 * and helper content. Powers the inline glossary popovers in the digital
 * assembly guide — turning the guide into a self-teaching reference and
 * removing the need to flip back to the printed booklet's glossary.
 *
 * Keys are stored lowercase. Matching is case-insensitive and whole-word,
 * with longer terms winning over shorter ones (so "Rafix Cam" matches
 * before "Cam").
 */

export interface GlossaryEntry {
  /** Canonical display label (e.g. "Rafix Cam") */
  label: string;
  /** One-sentence plain-English description */
  description: string;
}

const GLOSSARY: Record<string, GlossaryEntry> = {
  // ── Cams & Connectors ─────────────────────────────────────────
  "rafix cam": {
    label: "Rafix Cam",
    description:
      "A rotating cam lock pressed into a pre-drilled hole. Turning it 90° clockwise grips the threaded Rafix Pin in the adjacent panel and pulls the joint tight.",
  },
  "rafix pin": {
    label: "Rafix Pin",
    description:
      "A short threaded dowel that screws into one panel. Its head is gripped by a Rafix Cam in the adjacent panel to lock the joint.",
  },
  rafix: {
    label: "Rafix",
    description:
      "Hettich's quick-assembly cam-and-pin connector system. A cam in one panel rotates to grip a threaded pin in the other.",
  },
  cam: {
    label: "Cam",
    description:
      "A rotating lock that grips a connecting pin to join two panels. Most cabinets use Rafix cams — turn 90° clockwise to lock.",
  },
  pin: {
    label: "Pin",
    description:
      "A short threaded dowel that screws into one panel. Its head is gripped by a cam in the adjacent panel.",
  },
  clamex: {
    label: "Clamex",
    description:
      "A Lamello connector that creates a strong, invisible panel-to-panel joint. Press the two halves together until they click.",
  },
  dowel: {
    label: "Dowel",
    description:
      "A grooved wooden rod glued into pre-drilled holes to align and reinforce panel-to-panel joints.",
  },

  // ── Hinges ────────────────────────────────────────────────────
  "hinge arm": {
    label: "Hinge Arm",
    description:
      "The half of the hinge that screws into the door. It clips onto the hinge plate inside the cabinet.",
  },
  "hinge plate": {
    label: "Hinge Plate",
    description:
      "A mounting plate screwed to the inside of the cabinet side panel. The hinge arm clips onto it for easy fitting and adjustment.",
  },
  "full overlay": {
    label: "Full Overlay",
    description:
      "Doors fully cover the side panel edges. Most modern cabinets use full overlay for a flush, modern look.",
  },
  "half overlay": {
    label: "Half Overlay",
    description:
      "Two doors share a single side panel — each covers half the edge. Common where two cabinets meet.",
  },
  inset: {
    label: "Inset",
    description:
      "Doors sit flush within the cabinet frame rather than overlaying it. Requires precise gaps for a clean fit.",
  },

  // ── Drawers ───────────────────────────────────────────────────
  undermount: {
    label: "Undermount",
    description:
      "A drawer runner that sits beneath the drawer box rather than at its sides — invisible from the front and supports a soft-close mechanism.",
  },
  "drawer runner": {
    label: "Drawer Runner",
    description:
      "The rail mechanism that lets a drawer slide in and out smoothly. Undermount runners hide beneath the drawer box.",
  },
  "drawer clip": {
    label: "Drawer Clip",
    description:
      "A front-fixing clip that secures the drawer face to the runner. Lets you adjust the drawer's height, side and depth after fitting.",
  },

  // ── Joinery & cabinet concepts ────────────────────────────────
  "edge banding": {
    label: "Edge Banding",
    description:
      "The thin laminate or veneer applied to a panel's exposed edges. Always faces forward on visible edges.",
  },
  "front edge": {
    label: "Front Edge",
    description:
      "The edge of a panel that faces the room when assembled. Cabinets are built front-edge-down so the front faces remain protected.",
  },
  "front-edge-down": {
    label: "Front-Edge-Down",
    description:
      "The recommended build orientation: lay each panel face-down with its front edge resting on the floor. Stand the cabinet upright only after the back is fitted.",
  },
  carcass: {
    label: "Carcass",
    description:
      "The main box of the cabinet — top, bottom, sides, and any vertical dividers — before doors, drawers and shelves are fitted.",
  },
  tenon: {
    label: "Tenon",
    description:
      "The protruding tongue at the end of an MDF divider that slots into a matching groove in the top or bottom panel.",
  },
  groove: {
    label: "Groove",
    description:
      "A narrow channel cut into a panel that receives the back panel or a divider's tenon.",
  },
  square: {
    label: "Square",
    description:
      "A cabinet is square when its diagonals are equal. Measure top-left to bottom-right and top-right to bottom-left — both should match within a couple of millimetres.",
  },
  plinth: {
    label: "Plinth",
    description:
      "The recessed base panel beneath a floor-standing cabinet. Sets the cabinet on its feet and conceals legs.",
  },
  "vertical division": {
    label: "Vertical Division",
    description:
      "An internal upright panel that splits the cabinet into sections. Forms the inner structure that fixed shelves and face-frame ICBs attach to.",
  },
  "fixed shelf": {
    label: "Fixed Shelf",
    description:
      "A shelf permanently fitted into the carcass — must be installed before the side panels close because it can't be added later.",
  },
  "face frame": {
    label: "Face Frame",
    description:
      "A decorative front frame attached to the cabinet face. Splits into uprights (LU/RU) at the sides, an upper crossbar (UCB) at the top, and intermittent crossbars (ICB) on dividers.",
  },

  // ── Tools & fasteners ─────────────────────────────────────────
  "system screw": {
    label: "System Screw",
    description:
      "A euro-system screw designed for the 32mm cabinet system holes. Used with drawer runners, Keku clips and push-to-open pistons.",
  },
  pozidriv: {
    label: "Pozidriv",
    description:
      "A cross-shaped screw head with extra angled ribs (PZ2 is the standard size). Looks similar to Phillips but should not be substituted — Phillips bits will cam out.",
  },
};

/** Cached, length-descending list of glossary keys for matching. */
let _termsCache: string[] | null = null;
function getTerms(): string[] {
  if (_termsCache) return _termsCache;
  _termsCache = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);
  return _termsCache;
}

export function lookupTerm(term: string): GlossaryEntry | undefined {
  return GLOSSARY[term.toLowerCase()];
}

export interface TextSegment {
  type: "text" | "term";
  value: string;
  /** For term segments: the canonical glossary entry. */
  entry?: GlossaryEntry;
}

/**
 * Split text into alternating plain and term segments.
 * Whole-word, case-insensitive, longest-match-wins.
 */
export function tokenize(text: string): TextSegment[] {
  const terms = getTerms();
  if (terms.length === 0 || !text) return [{ type: "text", value: text }];

  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Allow matching across hyphens/spaces inside multi-word terms (already in keys).
  const pattern = new RegExp(`\\b(?:${escaped.join("|")})\\b`, "gi");

  const segments: TextSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    const matchedText = match[0];
    const entry = lookupTerm(matchedText);
    if (entry) {
      segments.push({ type: "term", value: matchedText, entry });
    } else {
      segments.push({ type: "text", value: matchedText });
    }
    lastIndex = match.index + matchedText.length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }
  return segments;
}
