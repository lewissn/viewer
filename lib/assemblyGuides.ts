/**
 * Assembly Guide Registry
 *
 * Maps guide slugs to their model URL, explode settings, and step definitions.
 * To add a new guide, add an entry to ASSEMBLY_GUIDES below.
 */

export interface AssemblyStep {
  /** Part-name prefixes to highlight and assemble in this step (case-insensitive startsWith) */
  prefixes: string[];
  /** One-sentence instruction shown to the user */
  copy: string;
}

export interface ExplodeConfig {
  /** Base distance (multiplied by model radius) to push parts outward */
  distance: number;
  /** Per-prefix explicit offset directions [x, y, z] – each axis is a multiplier of distance */
  offsets: Record<string, [number, number, number]>;
}

export interface AssemblyGuide {
  title: string;
  modelUrl: string;
  explode: ExplodeConfig;
  steps: AssemblyStep[];
}

export const ASSEMBLY_GUIDES: Record<string, AssemblyGuide> = {
  "low-double-cupboard": {
    title: "Low Double Cupboard",
    modelUrl:
      "https://www.dropbox.com/scl/fi/6tr564o5gpg8tlknjxfi4/LDC.3ds?rlkey=rbf45xegiuhf9aouvshvegza6&dl=0",
    explode: {
      distance: 4.8,
      offsets: {
        Bottom: [0, -1, 0],
        Plinth: [0, -1.4, 0.3],
        Top: [0, 1, 0],
        "Vertical Division": [0, 0.3, 0.5],
        "Left Side": [-1, 0, 0],
        "Right Side": [1, 0, 0],
        Back: [0, 0, -1.2],
        Door: [0, 0, 1.4],
        "Counter Top": [0, 1.3, 0.3],
      },
    },
    steps: [
      {
        prefixes: ["Bottom", "Plinth"],
        copy: "Connect the bottom and plinth panels.",
      },
      {
        prefixes: ["Vertical Division", "Top"],
        copy: "Fit the divider and top panel.",
      },
      {
        prefixes: ["Left Side", "Right Side"],
        copy: "Attach the left and right sides.",
      },
      {
        prefixes: ["Back"],
        copy: "Secure the back panels to square the cabinet.",
      },
      {
        prefixes: ["Door"],
        copy: "Fit the doors to the carcass.",
      },
      {
        prefixes: ["Counter Top"],
        copy: "Place the counter top to finish.",
      },
    ],
  },
};
