/**
 * Fittings resolution library.
 *
 * Maps ERP fitting names → canonical part IDs via aliases,
 * then resolves to human-readable labels, categories, and descriptions.
 */

// ── Alias map ──
// Maps ERP fitting name (uppercase) → canonical partId(s) or "IGNORE"

type AliasEntry =
  | string // single partId (qty 1)
  | "IGNORE"
  | { partId: string; qty: number }[];

const ALIASES: Record<string, AliasEntry> = {
  "EXT RAFIX": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN", qty: 1 }],
  "INT RAFIX": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN", qty: 1 }],
  "RAFIX EXT": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN", qty: 1 }],
  "RAFIX INT": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN", qty: 1 }],
  "RAFIX EXT (*)": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN", qty: 1 }],
  "RAFIX INT (*)": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN", qty: 1 }],
  "RAFIX EXT (**)": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN", qty: 1 }],
  "RAFIX INT (**)": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN", qty: 1 }],
  "RAFIX EXT (DUEL ACCESS)": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN", qty: 1 }],
  "RAFIX EXT (DUEL ACCESS) (*)": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN", qty: 1 }],
  "RAFIX EXT (NO PIN)": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN_SHORT", qty: 1 }],
  "RAFIX INT (NO PIN)": [{ partId: "RAFIX_CAM", qty: 1 }, { partId: "RAFIX_PIN_SHORT", qty: 1 }],
  "RAFIX THROUGH HOLE": "IGNORE",
  "LAMELLA CLAMEX P14": "CLAMEX_P14",
  "SPIDER BRACKET": [
    { partId: "SPIDER_BRACKET", qty: 1 }, { partId: "SPIDER_BRACKET_PLATE", qty: 1 },
    { partId: "SPIDER_BRACKET_HOLE_COVER", qty: 1 }, { partId: "WALL_PLUG", qty: 2 },
    { partId: "SCREW_40MM_THICK", qty: 2 },
  ],
  "UNHANDED BRACKET SCREWS": [
    { partId: "UNHANDED_BRACKET", qty: 1 }, { partId: "UNHANDED_BRACKET_PLATE", qty: 1 },
    { partId: "SCREW_30MM", qty: 2 }, { partId: "WALL_PLUG", qty: 2 },
    { partId: "SCREW_40MM_THICK", qty: 2 },
  ],
  "UNHANDED BRACKET SCREWS (NO BACK)": [
    { partId: "UNHANDED_BRACKET", qty: 1 }, { partId: "UNHANDED_BRACKET_PLATE", qty: 1 },
    { partId: "SCREW_30MM", qty: 2 }, { partId: "WALL_PLUG", qty: 2 },
    { partId: "SCREW_40MM_THICK", qty: 2 },
  ],
  "UNHANDED BRACKET SCREWS (WITH 6MM BACK)": [
    { partId: "UNHANDED_BRACKET", qty: 1 }, { partId: "UNHANDED_BRACKET_PLATE", qty: 1 },
    { partId: "SCREW_30MM", qty: 2 }, { partId: "WALL_PLUG", qty: 2 },
    { partId: "SCREW_40MM_THICK", qty: 2 },
  ],
  "UNHANDED BRACKET SCREWS (WITH 8MM BACK)": [
    { partId: "UNHANDED_BRACKET", qty: 1 }, { partId: "UNHANDED_BRACKET_PLATE", qty: 1 },
    { partId: "SCREW_30MM", qty: 2 }, { partId: "WALL_PLUG", qty: 2 },
    { partId: "SCREW_40MM_THICK", qty: 2 },
  ],
  "HAFELE UM 250-450 - LH": [
    { partId: "DRAWER_RUNNER_250-450", qty: 1 }, { partId: "DRAWER_CLIP", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 4 }, { partId: "SCREW_17MM", qty: 2 },
  ],
  "HAFELE UM 250-450 - RH": [
    { partId: "DRAWER_RUNNER_250-450", qty: 1 }, { partId: "DRAWER_CLIP", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 4 }, { partId: "SCREW_17MM", qty: 2 },
  ],
  "HAFELE UM 500 - LH": [
    { partId: "DRAWER_RUNNER_500", qty: 1 }, { partId: "DRAWER_CLIP", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 4 }, { partId: "SCREW_17MM", qty: 2 },
  ],
  "HAFELE UM 500 - RH": [
    { partId: "DRAWER_RUNNER_500", qty: 1 }, { partId: "DRAWER_CLIP", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 4 }, { partId: "SCREW_17MM", qty: 2 },
  ],
  "HAFELE UM 550 - LH": [
    { partId: "DRAWER_RUNNER_550", qty: 1 }, { partId: "DRAWER_CLIP", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 5 }, { partId: "SCREW_17MM", qty: 2 },
  ],
  "HAFELE UM 550 - RH": [
    { partId: "DRAWER_RUNNER_550", qty: 1 }, { partId: "DRAWER_CLIP", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 5 }, { partId: "SCREW_17MM", qty: 2 },
  ],
  "HAFELE UM 250-450 - INSET": [
    { partId: "DRAWER_RUNNER_250-450", qty: 1 }, { partId: "DRAWER_CLIP", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 4 }, { partId: "SCREW_17MM", qty: 2 },
  ],
  "HAFELE UM 500 - INSET": [
    { partId: "DRAWER_RUNNER_500", qty: 1 }, { partId: "DRAWER_CLIP", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 4 }, { partId: "SCREW_17MM", qty: 2 },
  ],
  "HAFELE UM 550 - INSET": [
    { partId: "DRAWER_RUNNER_550", qty: 1 }, { partId: "DRAWER_CLIP", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 5 }, { partId: "SCREW_17MM", qty: 2 },
  ],
  "HAFELE REAR HOLE": "IGNORE",
  "HINGE / FULL OVERLAY": [
    { partId: "FULL_HINGE_ARM", qty: 1 }, { partId: "HINGE_PLATE", qty: 1 },
    { partId: "SCREW_17MM", qty: 2 },
  ],
  "HINGE / HALF OVERLAY": [
    { partId: "HALF_HINGE_ARM", qty: 1 }, { partId: "HINGE_PLATE", qty: 1 },
    { partId: "SCREW_17MM", qty: 2 },
  ],
  "HINGE / INSET": [
    { partId: "INSET_HINGE_ARM", qty: 1 }, { partId: "HINGE_PLATE", qty: 1 },
    { partId: "SCREW_17MM", qty: 2 },
  ],
  "HINGE / INSET (M2MD)": [
    { partId: "INSET_HINGE_ARM", qty: 1 }, { partId: "HINGE_PLATE", qty: 1 },
    { partId: "SCREW_17MM", qty: 2 },
  ],
  "HINGE / FULL OVERLAY (NO HINGES REQUIRED)": "IGNORE",
  "HINGE / BLIND CORNER -- 17MM (DOOR)": [
    { partId: "BLINDER_CORNER_HINGE", qty: 1 }, { partId: "SCREW_17MM", qty: 2 },
  ],
  "HINGE / BLIND CORNER -- 17MM (DOOR)V2": [
    { partId: "BLINDER_CORNER_HINGE", qty: 1 }, { partId: "SCREW_17MM", qty: 2 },
  ],
  "HINGE / BLIND CORNER -- 17MM (FF SIDE)": "IGNORE",
  "HINGE / INSET (NO HINGES REQUIRED)": "IGNORE",
  "INSET STOP PIN": "SHELF_PIN",
  "HAFELE/KEKU-AS//APP/3D": [{ partId: "KEKU_PAIR", qty: 1 }, { partId: "SYSTEM_SCREW", qty: 4 }],
  "HAFELE/KEKU-AS//BIN/3D": [{ partId: "KEKU_PAIR", qty: 1 }, { partId: "SYSTEM_SCREW", qty: 4 }],
  "HAFELE/KEKU-EH//APP/3D": [{ partId: "KEKU_PAIR", qty: 1 }, { partId: "SYSTEM_SCREW", qty: 4 }],
  "BACK PINS - 3MM MARKING HOLE VD": [{ partId: "PANEL_PIN", qty: 2 }],
  "BACK PINS - 3MM MARKING HOLE UNDERPASS BACK": "PANEL_PIN",
  "BACK PINS - 3MM MARKING HOLE": "PANEL_PIN",
  "3MM MARKING HOLE UNDERPASS BACK": "PANEL_PIN",
  "3MM MARKING HOLE": "PANEL_PIN",
  "16MM SCREW (HANGING RAIL MARKINGS) (NO HOLES)": [{ partId: "HANGING_RAIL_END", qty: 2 }, { partId: "SCREW_17MM", qty: 2 }],
  "16MM SCREW (HANGING RAIL MARKINGS)2": [{ partId: "HANGING_RAIL_END", qty: 2 }, { partId: "SCREW_17MM", qty: 2 }],
  "30MM PANHEAD SCREW (BACK PANEL)": "SCREW_30MM_PANHEAD",
  "BACK CORNER PANEL SCREWS (RIGHT ANGLE)": "BACK_CORNER_SCREW",
  "TITUS PUSH TO OPEN PISTON": [
    { partId: "PTO_PISTON", qty: 1 }, { partId: "PTO_PLATE", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 2 },
  ],
  "TITUS PUSH TO OPEN PISTON (REV)": [
    { partId: "PTO_PISTON", qty: 1 }, { partId: "PTO_PLATE", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 2 },
  ],
  "TITUS PUSH TO OPEN PISTON (T PLATE)": [
    { partId: "PTO_PISTON", qty: 1 }, { partId: "PTO_PLATE", qty: 1 },
    { partId: "SYSTEM_SCREW", qty: 2 },
  ],
  "30MM SCREW (COUNTER-TOP SCREW HOLES (CLOSER))": "SCREW_30MM",
  "30MM SCREW (COUNTER-TOP SCREW HOLES (EVEN CLOSER))": "SCREW_30MM",
  "30MM SCREW (COUNTER-TOP SCREW HOLES (EVEN CLOSER))1": "SCREW_30MM",
  "30MM SCREW (COUNTER-TOP SCREW HOLES (MFC))": "SCREW_30MM",
  "30MM SCREW (COUNTER-TOP SCREW HOLES OVERPASS (CLOSER))": "SCREW_30MM",
  "30MM SCREW (COUNTER-TOP SCREW HOLES OVERPASS (MFC))": "SCREW_30MM",
  "30MM SCREW (COUNTER-TOP SCREW HOLES OVERPASS FF)": "SCREW_30MM",
  "30MM SCREW (COUNTER-TOP SCREW HOLES OVERPASS)": "SCREW_30MM",
  "30MM SCREW (COUNTER-TOP SCREW HOLES OVERPASS) TEMP": "SCREW_30MM",
  "30MM SCREW (COUNTER-TOP SCREW HOLES)": "SCREW_30MM",
  "30MM SCREW (COUNTER TOP)": "SCREW_30MM",
  "40MM SCREW (VERTICAL UPRIGHT BOTTOM)": "SCREW_40MM",
  "40MM SCREW (VERTICAL UPRIGHT TOP SCREWS)": "SCREW_40MM",
  "SHELF PINS 5MM": "SHELF_PIN",
  "SHELF PINS 5MM 4 HOLES (NEW)": "SHELF_PIN",
  "SHELF PINS 5MM 4 HOLES 20MM CENTRES": "SHELF_PIN",
  "SHELF PINS 5MM 5 HOLES": "SHELF_PIN",
  "SHELF PINS 5MM 5 HOLES NEW": "SHELF_PIN",
  "SHELF PINS 5MM1 (RG)": "IGNORE",
  "MINIMALISTIC FEET - BACK": [{ partId: "MINI_FOOT", qty: 1 }, { partId: "MINI_FOOT_SCREW", qty: 1 }],
  "MINIMALISTIC FEET - FRONT": [{ partId: "MINI_FOOT", qty: 1 }, { partId: "MINI_FOOT_SCREW", qty: 1 }],
  "MINIMALISTIC FEET - FRONT1": [{ partId: "MINI_FOOT", qty: 1 }, { partId: "MINI_FOOT_SCREW", qty: 1 }],
  "MINIMALISTIC FEET - FRONT2": [{ partId: "MINI_FOOT", qty: 1 }, { partId: "MINI_FOOT_SCREW", qty: 1 }],
  "MINIMALISTIC FEET - FRONT3": [{ partId: "MINI_FOOT", qty: 1 }, { partId: "MINI_FOOT_SCREW", qty: 1 }],
  "16MM HINGE SCREW": "IGNORE",
  "ANTI-TIP BRACKET (+ PLATE) (290.36.540 + 290.36.560)": [
    { partId: "ANTI_TILT_BRACKET", qty: 1 }, { partId: "ANTI_TILT_PLATE", qty: 1 },
    { partId: "SCREW_25MM_PANHEAD", qty: 3 }, { partId: "WALL_PLUG", qty: 2 },
    { partId: "SCREW_40MM_THICK", qty: 2 },
  ],
  "ANTI-TIP BRACKET (+ PLATE) (290.36.540 + 290.36.560) (*)": [
    { partId: "ANTI_TILT_BRACKET", qty: 1 }, { partId: "ANTI_TILT_PLATE", qty: 1 },
    { partId: "SCREW_25MM_PANHEAD", qty: 3 }, { partId: "WALL_PLUG", qty: 2 },
    { partId: "SCREW_40MM_THICK", qty: 2 },
  ],
  "DRAWER CORNER PIECE MARKINGS": "IGNORE",
  "HAFELE PLASTIC LEG (BACK)": [{ partId: "LEG_100MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "HAFELE PLASTIC LEG (BACK) MFC": [{ partId: "LEG_100MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "HAFELE PLASTIC LEG (BACK) MFC1": [{ partId: "LEG_100MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "HAFELE PLASTIC LEG (BACK)TEMP": [{ partId: "LEG_100MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "HAFELE PLASTIC LEG (FRONT)": [{ partId: "LEG_100MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "HAFELE PLASTIC LEG (FRONT) MFC": [{ partId: "LEG_100MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "HAFELE PLASTIC LEG (VD) 100": [{ partId: "LEG_100MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "HAFELE PLASTIC LEG (VD) 80MM": [{ partId: "LEG_80MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "HAFELE PLASTIC LEG (VD) 120MM": [{ partId: "LEG_120MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "HAFELE PLASTIC LEG (VD) 150MM": [{ partId: "LEG_150MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "HAFELE PLASTIC LEG (VD) 180MM": [{ partId: "LEG_180MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "HAFELE PLASTIC LEG (VD) 200MM": [{ partId: "LEG_200MM", qty: 0.5 }, { partId: "LEG_BASE", qty: 0.5 }, { partId: "SCREW_40MM", qty: 2 }],
  "THIN HAFELE PLASTIC LEG (BACK)": [{ partId: "THIN_LEG_100MM", qty: 1 }, { partId: "THIN_LEG_BASE", qty: 1 }, { partId: "SCREW_17MM", qty: 4 }],
  "THIN HAFELE PLASTIC LEG (BACK)(UP BACK)": [{ partId: "THIN_LEG_100MM", qty: 1 }, { partId: "THIN_LEG_BASE", qty: 1 }, { partId: "SCREW_17MM", qty: 4 }],
  "THIN HAFELE PLASTIC LEG (BACK)1": [{ partId: "THIN_LEG_100MM", qty: 1 }, { partId: "THIN_LEG_BASE", qty: 1 }, { partId: "SCREW_17MM", qty: 4 }],
  "THIN HAFELE PLASTIC LEG (FRONT)": [{ partId: "THIN_LEG_100MM", qty: 1 }, { partId: "THIN_LEG_BASE", qty: 1 }, { partId: "SCREW_17MM", qty: 4 }],
  "THIN HAFELE PLASTIC LEG (FRONT)(CLOSER)": [{ partId: "THIN_LEG_100MM", qty: 1 }, { partId: "THIN_LEG_BASE", qty: 1 }, { partId: "SCREW_17MM", qty: 4 }],
  "THIN HAFELE PLASTIC LEG (VD)": [{ partId: "THIN_LEG_100MM", qty: 1 }, { partId: "THIN_LEG_BASE", qty: 1 }, { partId: "SCREW_17MM", qty: 4 }],
  "CONNECTING SCREW (267.05.702)": [{ partId: "CONNECTING_SCREW_MALE", qty: 0.5 }, { partId: "CONNECTING_SCREW_FEMALE", qty: 0.5 }],
  "DOWEL": [{ partId: "WOODEN_DOWEL", qty: 0.5 }],
  "ANOUK HANDLE - BLACK": "ANOUK_HANDLE_BLACK",
  "ANOUK HANDLE - BRASS": "ANOUK_HANDLE_BRASS",
  "ANOUK KNOB - BLACK": "ANOUK_KNOB_BLACK",
  "ANOUK KNOB - BRASS": "ANOUK_KNOB_BRASS",
  "COLETTE HANDLE - BRASS": "COLETTE_HANDLE_BRASS",
  "COLETTE HANDLE - NICKEL": "COLETTE_HANDLE_NICKEL",
  "GABRIELLE KNOB - BRASS": "GABRIELLE_KNOB_BRASS",
  "GABRIELLE KNOB - CHROME": "GABRIELLE_KNOB_CHROME",
  "GABRIELLE KNOB - GOLD": "GABRIELLE_KNOB_GOLD",
  "GABRIELLE KNOB - STEEL": "GABRIELLE_KNOB_STEEL",
  "RENEE HANDLE": "RENEE_HANDLE",
  "RENEE KNOB": "RENEE_KNOB",
  "KNOB": "IGNORE",
};

// ── Canonical parts ──

export interface CanonicalPart {
  id: string;
  label: string;
  category: string;
  description: string;
}

const CANONICAL_PARTS: Record<string, CanonicalPart> = {
  RAFIX_CAM: { id: "RAFIX_CAM", label: "Rafix Cam", category: "CAMS", description: "A rotating cam lock that secures two panels together. Insert into the pre-drilled hole and turn 90 degrees clockwise to lock onto the connecting pin." },
  RAFIX_PIN: { id: "RAFIX_PIN", label: "Rafix Pin", category: "CAMS", description: "A threaded dowel pin that screws into one panel and is locked in place by the Rafix Cam on the adjacent panel." },
  RAFIX_PIN_SHORT: { id: "RAFIX_PIN_SHORT", label: "Rafix Pin Short", category: "CAMS", description: "A shorter version of the Rafix Pin used where panel thickness is reduced or there is no through-hole." },
  CLAMEX_P14: { id: "CLAMEX_P14", label: "Clamex P14", category: "CAMS", description: "A Lamello connector that provides a strong, invisible panel-to-panel joint. Press the two halves together until they click." },
  SCREW_17MM: { id: "SCREW_17MM", label: "Screw 17mm", category: "SCREWS", description: "A short 17mm chipboard screw used for securing hinge plates, drawer clips, and other lightweight fittings to panels." },
  SCREW_25MM_PANHEAD: { id: "SCREW_25MM_PANHEAD", label: "Screw 25mm Panhead", category: "SCREWS", description: "A 25mm panhead screw with a wide flat head, used for mounting anti-tilt brackets and similar fixings." },
  SCREW_30MM: { id: "SCREW_30MM", label: "Screw 30mm", category: "SCREWS", description: "A 30mm screw used for securing countertop connectors, bracket plates, and general cabinet fixings." },
  SCREW_30MM_PANHEAD: { id: "SCREW_30MM_PANHEAD", label: "Screw 30mm Panhead", category: "SCREWS", description: "A 30mm panhead screw with a wide flat head, used for securing back panels to the cabinet carcass." },
  SCREW_40MM: { id: "SCREW_40MM", label: "Screw 40mm", category: "SCREWS", description: "A 40mm screw used for securing cabinet legs and vertical uprights." },
  SCREW_40MM_THICK: { id: "SCREW_40MM_THICK", label: "Screw 40x4mm", category: "SCREWS", description: "A heavy-duty 40x4mm screw used for wall-mounting brackets through wall plugs." },
  WALL_PLUG: { id: "WALL_PLUG", label: "Wall Plug", category: "SCREWS", description: "A plastic wall plug inserted into a drilled hole in the wall. The mounting screw expands it for a secure grip." },
  SYSTEM_SCREW: { id: "SYSTEM_SCREW", label: "System Screw", category: "SCREWS", description: "A euro-system screw designed for 32mm cabinet system holes. Used with drawer runners, Keku clips, and push-to-open pistons." },
  BACK_CORNER_SCREW: { id: "BACK_CORNER_SCREW", label: "Right Angle Screws", category: "SCREWS", description: "Right-angle bracket screws used to secure back corner panels where two backs meet at 90 degrees." },
  SPIDER_BRACKET: { id: "SPIDER_BRACKET", label: "Spider Bracket", category: "BRACKETS", description: "A concealed wall-mounting bracket that hooks onto a wall plate. Allows the cabinet to be hung and adjusted after fitting." },
  SPIDER_BRACKET_PLATE: { id: "SPIDER_BRACKET_PLATE", label: "Spider Bracket Plate", category: "BRACKETS", description: "The wall-mounted plate that the spider bracket hooks onto. Secured to the wall with plugs and screws." },
  SPIDER_BRACKET_HOLE_COVER: { id: "SPIDER_BRACKET_HOLE_COVER", label: "Spider Bracket Hole Cover", category: "BRACKETS", description: "A snap-on cover that conceals the spider bracket adjustment hole on the inside of the cabinet." },
  UNHANDED_BRACKET: { id: "UNHANDED_BRACKET", label: "Unhanded Bracket", category: "BRACKETS", description: "A universal wall-mounting bracket that works on either side of the cabinet. Hooks onto the wall plate for secure hanging." },
  UNHANDED_BRACKET_PLATE: { id: "UNHANDED_BRACKET_PLATE", label: "Unhanded Bracket Plate", category: "BRACKETS", description: "The wall plate for the unhanded bracket. Screwed to the wall with plugs and provides the hook point." },
  ANTI_TILT_BRACKET: { id: "ANTI_TILT_BRACKET", label: "Anti-Tilt Bracket", category: "BRACKETS", description: "A safety bracket that prevents tall cabinets from tipping forward. Secured to both the cabinet top and the wall." },
  ANTI_TILT_PLATE: { id: "ANTI_TILT_PLATE", label: "Anti-Tilt Plate", category: "BRACKETS", description: "The wall plate for the anti-tilt bracket. Fixed to the wall and interlocks with the cabinet bracket." },
  DRAWER_RUNNER_250_450: { id: "DRAWER_RUNNER_250-450", label: "Drawer Runner 250-450", category: "DRAWERS", description: "An undermount soft-close drawer runner suitable for drawer depths between 250mm and 450mm." },
  DRAWER_RUNNER_500: { id: "DRAWER_RUNNER_500", label: "Drawer Runner 500", category: "DRAWERS", description: "An undermount soft-close drawer runner for 500mm deep drawers." },
  DRAWER_RUNNER_550: { id: "DRAWER_RUNNER_550", label: "Drawer Runner 550", category: "DRAWERS", description: "An undermount soft-close drawer runner for 550mm deep drawers." },
  DRAWER_CLIP: { id: "DRAWER_CLIP", label: "Drawer Clip", category: "DRAWERS", description: "A front-fixing clip that secures the drawer face to the undermount runner system. Allows adjustment after fitting." },
  FULL_HINGE_ARM: { id: "FULL_HINGE_ARM", label: "Full Overlay Hinge Arm", category: "HINGES", description: "A soft-close hinge arm for full overlay doors where the door fully covers the side panel edge." },
  HALF_HINGE_ARM: { id: "HALF_HINGE_ARM", label: "Half Overlay Hinge Arm", category: "HINGES", description: "A soft-close hinge arm for half overlay doors where two doors share a single side panel." },
  INSET_HINGE_ARM: { id: "INSET_HINGE_ARM", label: "Inset Hinge Arm", category: "HINGES", description: "A soft-close hinge arm for inset doors that sit flush within the cabinet frame." },
  BLINDER_CORNER_HINGE: { id: "BLINDER_CORNER_HINGE", label: "Blinder Corner Hinge", category: "HINGES", description: "A special hinge for blind corner cabinets that allows the door to clear the adjacent cabinet." },
  HINGE_PLATE: { id: "HINGE_PLATE", label: "Hinge Plate", category: "HINGES", description: "A mounting plate that screws to the inside of the cabinet side panel. The hinge arm clips onto it for easy fitting and removal." },
  SHELF_PIN: { id: "SHELF_PIN", label: "Shelf Pin", category: "PINS", description: "A small metal or plastic pin that slots into the 5mm system holes to support adjustable shelves." },
  PANEL_PIN: { id: "PANEL_PIN", label: "Panel Pin", category: "PINS", description: "A small nail-like pin used to tack back panels into position on the cabinet carcass." },
  KEKU_PAIR: { id: "KEKU_PAIR", label: "Keku Pair", category: "KEKU", description: "A push-fit clip system for attaching decorative panels and plinths. One half fixes to the cabinet, the other to the panel." },
  HANGING_RAIL_END: { id: "HANGING_RAIL_END", label: "Hanging Rail End", category: "RAILS", description: "End caps and fixings for a wardrobe hanging rail. Screwed inside the cabinet sides to support the clothes rail." },
  PTO_PISTON: { id: "PTO_PISTON", label: "PTO Piston", category: "PNEUMATIC", description: "A push-to-open piston that spring-ejects handleless doors or drawers when pressed. Provides a clean, minimal look." },
  PTO_PLATE: { id: "PTO_PLATE", label: "PTO Plate", category: "PNEUMATIC", description: "The mounting plate for the push-to-open piston. Screwed to the inside of the cabinet with the piston clipping on top." },
  MINI_FOOT: { id: "MINI_FOOT", label: "Mini Foot", category: "LEGS", description: "A small adjustable foot for low-profile cabinets. Provides levelling on uneven floors." },
  MINI_FOOT_SCREW: { id: "MINI_FOOT_SCREW", label: "Mini Foot Screw", category: "LEGS", description: "The fixing screw for the mini foot. Secures the foot housing to the underside of the cabinet." },
  LEG_80MM: { id: "LEG_80MM", label: "Leg 80mm", category: "LEGS", description: "An 80mm adjustable plastic cabinet leg. Screws into the leg base and allows height levelling." },
  LEG_100MM: { id: "LEG_100MM", label: "Leg 100mm", category: "LEGS", description: "A 100mm adjustable plastic cabinet leg. The most common size for standard kitchen and bathroom cabinets." },
  LEG_120MM: { id: "LEG_120MM", label: "Leg 120mm", category: "LEGS", description: "A 120mm adjustable plastic cabinet leg for slightly raised installations." },
  LEG_150MM: { id: "LEG_150MM", label: "Leg 150mm", category: "LEGS", description: "A 150mm adjustable plastic cabinet leg for raised installations or uneven floors." },
  LEG_180MM: { id: "LEG_180MM", label: "Leg 180mm", category: "LEGS", description: "A 180mm adjustable plastic cabinet leg for high-clearance installations." },
  LEG_200MM: { id: "LEG_200MM", label: "Leg 200mm", category: "LEGS", description: "A 200mm adjustable plastic cabinet leg for maximum clearance installations." },
  LEG_BASE: { id: "LEG_BASE", label: "Leg Base", category: "LEGS", description: "The clip-on base plate for cabinet legs. Fixed to the underside of the cabinet, the leg screws into it." },
  THIN_LEG_100MM: { id: "THIN_LEG_100MM", label: "Thin Leg 100mm", category: "LEGS", description: "A slim-profile 100mm cabinet leg for lightweight units with thinner panels." },
  THIN_LEG_BASE: { id: "THIN_LEG_BASE", label: "Thin Leg Base", category: "LEGS", description: "A slim base plate for thin cabinet legs. Screwed directly to the panel underside." },
  ANOUK_HANDLE_BLACK: { id: "ANOUK_HANDLE_BLACK", label: "Anouk Handle Black", category: "HANDLES", description: "A contemporary black finish Anouk handle for cabinet doors and drawers." },
  ANOUK_HANDLE_BRASS: { id: "ANOUK_HANDLE_BRASS", label: "Anouk Handle Brass", category: "HANDLES", description: "A contemporary brass finish Anouk handle for cabinet doors and drawers." },
  ANOUK_KNOB_BLACK: { id: "ANOUK_KNOB_BLACK", label: "Anouk Knob Black", category: "HANDLES", description: "A round black finish Anouk knob for cabinet doors." },
  ANOUK_KNOB_BRASS: { id: "ANOUK_KNOB_BRASS", label: "Anouk Knob Brass", category: "HANDLES", description: "A round brass finish Anouk knob for cabinet doors." },
  COLETTE_HANDLE_BRASS: { id: "COLETTE_HANDLE_BRASS", label: "Colette Handle Brass", category: "HANDLES", description: "An elegant brass finish Colette handle for cabinet doors and drawers." },
  COLETTE_HANDLE_NICKEL: { id: "COLETTE_HANDLE_NICKEL", label: "Colette Handle Nickel", category: "HANDLES", description: "An elegant nickel finish Colette handle for cabinet doors and drawers." },
  GABRIELLE_KNOB_BRASS: { id: "GABRIELLE_KNOB_BRASS", label: "Gabrielle Knob Brass", category: "HANDLES", description: "A decorative brass finish Gabrielle knob for cabinet doors." },
  GABRIELLE_KNOB_CHROME: { id: "GABRIELLE_KNOB_CHROME", label: "Gabrielle Knob Chrome", category: "HANDLES", description: "A decorative chrome finish Gabrielle knob for cabinet doors." },
  GABRIELLE_KNOB_GOLD: { id: "GABRIELLE_KNOB_GOLD", label: "Gabrielle Knob Gold", category: "HANDLES", description: "A decorative gold finish Gabrielle knob for cabinet doors." },
  GABRIELLE_KNOB_STEEL: { id: "GABRIELLE_KNOB_STEEL", label: "Gabrielle Knob Steel", category: "HANDLES", description: "A decorative steel finish Gabrielle knob for cabinet doors." },
  RENEE_HANDLE: { id: "RENEE_HANDLE", label: "Renée Handle", category: "HANDLES", description: "A classic Renée handle for cabinet doors and drawers." },
  RENEE_KNOB: { id: "RENEE_KNOB", label: "Renée Knob", category: "HANDLES", description: "A classic Renée knob for cabinet doors." },
  WOODEN_DOWEL: { id: "WOODEN_DOWEL", label: "Wooden Dowel", category: "FASTENERS", description: "A grooved wooden dowel for aligning and strengthening panel joints. Glued into pre-drilled holes on both panels." },
  CONNECTING_SCREW_MALE: { id: "CONNECTING_SCREW_MALE", label: "Connecting Screw Male", category: "FASTENERS", description: "The bolt half of a connecting screw pair used to join two cabinets side by side." },
  CONNECTING_SCREW_FEMALE: { id: "CONNECTING_SCREW_FEMALE", label: "Connecting Screw Female", category: "FASTENERS", description: "The barrel nut half of a connecting screw pair. Receives the male bolt through adjacent cabinet sides." },
};

// ── Public types ──

export interface ResolvedFitting {
  partId: string;
  label: string;
  category: string;
  description: string;
  qty: number;
}

// ── Resolution ──

/** Look up a canonical part by its ID */
export function getCanonicalPart(partId: string): CanonicalPart | undefined {
  return CANONICAL_PARTS[partId];
}

/**
 * Resolve a single ERP fitting name + quantity into canonical parts.
 * Returns an array of resolved fittings (may be multiple per alias).
 * Returns empty array for IGNORE entries or unknown fittings.
 */
export function resolveErpFitting(
  erpName: string,
  erpQty: number
): ResolvedFitting[] {
  const key = erpName.trim().toUpperCase();
  const alias = ALIASES[key];

  if (!alias || alias === "IGNORE") return [];

  // Single partId string
  if (typeof alias === "string") {
    const part = CANONICAL_PARTS[alias];
    if (!part) return [];
    return [{ partId: part.id, label: part.label, category: part.category, description: part.description, qty: erpQty }];
  }

  // Array of { partId, qty } — multiply each qty by the ERP row quantity
  const results: ResolvedFitting[] = [];
  for (const entry of alias) {
    const part = CANONICAL_PARTS[entry.partId];
    if (!part) continue;
    results.push({
      partId: part.id,
      label: part.label,
      category: part.category,
      description: part.description,
      qty: Math.round(entry.qty * erpQty * 100) / 100, // handle 0.5 multipliers
    });
  }
  return results;
}

/**
 * Resolve all ERP fitting rows into a deduplicated, aggregated list.
 * Input: array of { name, qty } from the CSV.
 * Output: aggregated fittings grouped by partId, sorted by category then label.
 */
export function resolveFittings(
  rawFittings: { name: string; qty: number }[]
): ResolvedFitting[] {
  const totals = new Map<string, ResolvedFitting>();

  for (const raw of rawFittings) {
    const resolved = resolveErpFitting(raw.name, raw.qty);
    for (const r of resolved) {
      const existing = totals.get(r.partId);
      if (existing) {
        existing.qty = Math.round((existing.qty + r.qty) * 100) / 100;
      } else {
        totals.set(r.partId, { ...r });
      }
    }
  }

  // Sort by category, then by label
  return Array.from(totals.values()).sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.label.localeCompare(b.label);
  });
}

/** Category display order and labels */
export const CATEGORY_LABELS: Record<string, string> = {
  BRACKETS: "Brackets",
  CAMS: "Cams & Connectors",
  DRAWERS: "Drawer Fittings",
  FASTENERS: "Fasteners",
  HANDLES: "Handles & Knobs",
  HINGES: "Hinges",
  KEKU: "Keku Clips",
  LEGS: "Legs & Feet",
  PINS: "Pins",
  PNEUMATIC: "Push-to-Open",
  RAILS: "Rails",
  SCREWS: "Screws & Fixings",
};

/** Group resolved fittings by category */
export function groupByCategory(
  fittings: ResolvedFitting[]
): { category: string; label: string; items: ResolvedFitting[] }[] {
  const map = new Map<string, ResolvedFitting[]>();
  for (const f of fittings) {
    const arr = map.get(f.category) ?? [];
    arr.push(f);
    map.set(f.category, arr);
  }

  return Array.from(map.entries())
    .map(([cat, items]) => ({
      category: cat,
      label: CATEGORY_LABELS[cat] ?? cat,
      items,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
