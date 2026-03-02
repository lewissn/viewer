"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useSearchParams } from "next/navigation";
import {
  NAVIGATION,
  type NavItem,
  type NavSection,
} from "@/lib/navigation";
import type { ResolvedFitting } from "@/lib/fittings";
import { FittingsPanel } from "./fittings-panel";
import { InstallationPanel } from "./installation-panel";
import { useTheme } from "@/lib/theme-context";

interface SideNavProps {
  /** Override default navigation sections (e.g. for project context) */
  sections?: NavSection[];
  /** Resolved fittings for the current cabinet (replaces Fittings Guide) */
  fittings?: ResolvedFitting[];
  /** Active cabinet/link ID for highlighting (e.g. cabinetId) */
  activeId?: string | null;
}

// ── Desktop sidebar (rendered in the flex root) ──

export function DesktopSidebar({
  sections,
  fittings,
  activeId,
}: SideNavProps = {}) {
  return (
    <aside className="hidden lg:flex flex-col w-[280px] h-screen flex-shrink-0 bg-[var(--sidebar-bg)] backdrop-blur-xl border-r border-[var(--sidebar-border)] overflow-y-auto transition-colors">
      <SidebarHeader />
      <NavContent
        sections={sections}
        fittings={fittings}
        activeId={activeId}
      />
    </aside>
  );
}

// ── Sidebar header (logo + Assembly Guide + theme toggle) ──

function SidebarHeader() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex-shrink-0 px-4 pt-5 pb-4 border-b border-[var(--sidebar-border)]">
      <div className="flex items-center gap-3">
        <Image
          src="/logo.png"
          alt="The Cabinet Shop"
          width={100}
          height={28}
          className="h-6 w-auto"
          priority
        />
        <span className="text-[12px] font-medium text-[var(--muted)]">
          Assembly Guide
        </span>
      </div>
      <button
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
        className="mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-[var(--muted)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
      >
        {theme === "light" ? <SunIcon /> : <MoonIcon />}
        {theme === "light" ? "Dark mode" : "Light mode"}
      </button>
    </div>
  );
}

// ── Mobile hamburger + drawer (rendered in the top bar) ──

export function MobileNav({
  sections,
  fittings,
  activeId,
}: SideNavProps = {}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        className="lg:hidden flex items-center justify-center w-9 h-9 rounded-xl backdrop-blur-xl bg-[var(--card-bg)] shadow-[0_1px_8px_rgba(0,0,0,0.08)] hover:opacity-90 transition-all active:scale-95"
      >
        <HamburgerIcon />
      </button>

      {open && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={close}
          />
          <div className="relative w-[300px] max-w-[85vw] h-full bg-[var(--sidebar-bg)] backdrop-blur-xl shadow-2xl overflow-y-auto animate-slide-in">
            <div className="sticky top-0 z-10 bg-[var(--sidebar-bg)] border-b border-[var(--sidebar-border)] pr-12">
              <SidebarHeader />
              <button
                onClick={close}
                aria-label="Close menu"
                className="absolute top-4 right-4 flex items-center justify-center w-8 h-8 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="px-4 pt-2">
              <NavContent
                sections={sections}
                fittings={fittings}
                activeId={activeId}
                onNavigate={close}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Shared nav content ──

function NavContent({
  sections,
  fittings,
  activeId,
  onNavigate,
}: {
  sections?: NavSection[];
  fittings?: ResolvedFitting[];
  activeId?: string | null;
  onNavigate?: () => void;
}) {
  const navSections = sections ?? NAVIGATION;
  const hasFittings = fittings && fittings.length > 0;

  return (
    <nav className="flex flex-col gap-1 py-4">
      {navSections.map((section) => {
        // Replace Fittings Guide with Included Fittings when fittings provided
        if (section.title === "Fittings Guide" && hasFittings) {
          return (
            <div key="fittings-and-installation">
              <div className="mb-3">
                <h3 className="px-3 pb-1 text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider">
                  Included Fittings
                </h3>
                <FittingsPanel fittings={fittings!} />
              </div>
              <div className="mb-3">
                <h3 className="px-3 pb-1 text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider">
                  Installation &amp; Finishing
                </h3>
                <InstallationPanel fittings={fittings} />
              </div>
            </div>
          );
        }
        return (
          <SectionBlock
            key={section.title}
            section={section}
            activeId={activeId}
            onNavigate={onNavigate}
          />
        );
      })}
    </nav>
  );
}

function SectionBlock({
  section,
  activeId,
  onNavigate,
}: {
  section: NavSection;
  activeId?: string | null;
  onNavigate?: () => void;
}) {
  return (
    <div className="mb-3">
      <h3 className="px-3 pb-1 text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider">
        {section.title}
      </h3>
      <ul className="flex flex-col">
        {section.items.map((item) => (
          <NavItemRow
            key={item.label}
            item={item}
            depth={0}
            activeId={activeId}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </div>
  );
}

// ── Recursive nav item renderer ──

function NavItemRow({
  item,
  depth,
  activeId,
  onNavigate,
}: {
  item: NavItem;
  depth: number;
  activeId?: string | null;
  onNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const paddingLeft = 12 + depth * 16;

  const isLinkActive = (href: string) => {
    if (href.includes("cabinet=")) {
      return activeId != null && href.includes(`cabinet=${activeId}`);
    }
    const hrefPath = href.split("?")[0];
    return pathname != null && hrefPath === pathname;
  };

  if (item.type === "group") {
    return (
      <li>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center w-full gap-2 rounded-lg px-3 py-2 text-[14px] text-[var(--foreground)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors active:scale-[0.98]"
          style={{ paddingLeft }}
        >
          <ChevronIcon expanded={expanded} />
          <span className="font-medium">{item.label}</span>
        </button>
        {expanded && (
          <ul className="flex flex-col">
            {item.children.map((child) => (
              <NavItemRow
                key={child.label}
                item={child}
                depth={depth + 1}
                activeId={activeId}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  if (item.type === "modal") {
    return (
      <li>
        <a
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-[14px] text-[var(--foreground)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors active:scale-[0.98]"
          style={{ paddingLeft }}
        >
          <PdfIcon />
          <span>{item.label}</span>
          <ExternalIcon />
        </a>
      </li>
    );
  }

  if (item.external) {
    return (
      <li>
        <a
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-[14px] text-[var(--foreground)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors active:scale-[0.98]"
          style={{ paddingLeft }}
        >
          <span>{item.label}</span>
          <ExternalIcon />
        </a>
      </li>
    );
  }

  const active = isLinkActive(item.href);

  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-[14px] text-[var(--foreground)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors active:scale-[0.98]"
        style={{ paddingLeft }}
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${active ? "bg-emerald-500" : "bg-transparent"}`}
          aria-hidden
        />
        <span className={active ? "font-medium" : ""}>{item.label}</span>
      </Link>
    </li>
  );
}

// ── Icons ──

function HamburgerIcon() {
  return (
    <svg
      className="w-[18px] h-[18px] text-[var(--foreground)]"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
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
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
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
  );
}

function PdfIcon() {
  return (
    <svg
      className="w-4 h-4 text-[var(--muted)] flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      className="w-3 h-3 text-[var(--muted)] flex-shrink-0 ml-auto"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-4.5-6h6m0 0v6m0-6L9.75 14.25"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
    </svg>
  );
}
