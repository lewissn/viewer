/**
 * Navigation menu structure for the assembly guides section.
 *
 * Each item can be a link, an expandable group with children,
 * or a modal trigger (for hardware/fitting guides).
 */

export interface NavLink {
  type: "link";
  label: string;
  href: string;
  external?: boolean; // opens in new tab
}

export interface NavModal {
  type: "modal";
  label: string;
  /** URL to a PDF or page shown in a modal / new tab */
  href: string;
}

export interface NavGroup {
  type: "group";
  label: string;
  children: NavItem[];
}

export type NavItem = NavLink | NavModal | NavGroup;

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAVIGATION: NavSection[] = [
  {
    title: "Fittings Guide",
    items: [
      {
        type: "group",
        label: "Hardware",
        children: [
      {
        type: "modal",
        label: "Hinges",
        href: "/assets/fittings/hinges.pdf",
      },
      {
        type: "modal",
        label: "Cams",
        href: "/assets/fittings/cams.pdf",
      },
      {
        type: "modal",
        label: "Drawer Runners",
        href: "/assets/fittings/drawer-runners.pdf",
      },
    ],
  },
    ],
  },
  {
    title: "Cabinet Tutorials",
    items: [
      {
        type: "group",
        label: "Cupboards",
        children: [
          {
            type: "link",
            label: "Single Cupboard",
            href: "/assembly/single-cupboard",
          },
          {
            type: "link",
            label: "Double Cupboard",
            href: "/assembly/low-double-cupboard",
          },
          {
            type: "link",
            label: "Triple Cupboard",
            href: "/assembly/triple-cupboard",
          },
          {
            type: "link",
            label: "Quad Cupboard",
            href: "/assembly/quad-cupboard",
          },
        ],
      },
      {
        type: "group",
        label: "Bookcases",
        children: [
          {
            type: "link",
            label: "Single Bookcase",
            href: "/assembly/single-bookcase",
          },
          {
            type: "link",
            label: "Double Bookcase",
            href: "/assembly/double-bookcase",
          },
          {
            type: "link",
            label: "Triple Bookcase",
            href: "/assembly/triple-bookcase",
          },
          {
            type: "link",
            label: "Quad Bookcase",
            href: "/assembly/quad-bookcase",
          },
        ],
      },
      { type: "link", label: "Drawers", href: "/assembly/drawers" },
      {
        type: "link",
        label: "Meter Box Cupboards",
        href: "/assembly/meter-box-cupboard",
      },
      { type: "link", label: "Wardrobes", href: "/assembly/wardrobes" },
      { type: "link", label: "Dressers", href: "/assembly/dressers" },
      { type: "link", label: "Fillers", href: "/assembly/fillers" },
    ],
  },
  {
    title: "Need Help?",
    items: [
      {
        type: "link",
        label: "Contact Us",
        href: "https://www.thecabinetshop.co.uk/contact",
        external: true,
      },
      {
        type: "link",
        label: "Report an Issue",
        href: "https://www.thecabinetshop.co.uk/contact",
        external: true,
      },
    ],
  },
];
