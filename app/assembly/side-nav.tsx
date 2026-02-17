"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import {
  NAVIGATION,
  type NavItem,
  type NavSection,
} from "@/lib/navigation";

// ── Desktop sidebar (rendered in the flex root) ──

export function DesktopSidebar() {
  return (
    <aside className="hidden lg:flex flex-col w-[280px] h-screen flex-shrink-0 bg-white/80 backdrop-blur-xl border-r border-[#e5e5ea] overflow-y-auto">
      <NavContent />
    </aside>
  );
}

// ── Mobile hamburger + drawer (rendered in the top bar) ──

export function MobileNav() {
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
        className="lg:hidden flex items-center justify-center w-9 h-9 rounded-xl backdrop-blur-xl bg-white/70 shadow-[0_1px_8px_rgba(0,0,0,0.08)] hover:bg-white/90 transition-all active:scale-95"
      >
        <HamburgerIcon />
      </button>

      {open && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={close}
          />
          <div className="relative w-[300px] max-w-[85vw] h-full bg-white/95 backdrop-blur-xl shadow-2xl overflow-y-auto animate-slide-in">
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <span className="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider">
                Menu
              </span>
              <button
                onClick={close}
                aria-label="Close menu"
                className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-[#f5f5f7] transition-colors active:scale-95"
              >
                <CloseIcon />
              </button>
            </div>
            <NavContent onNavigate={close} />
          </div>
        </div>
      )}
    </>
  );
}

// ── Shared nav content ──

function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1 px-3 py-4">
      {NAVIGATION.map((section) => (
        <SectionBlock
          key={section.title}
          section={section}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

function SectionBlock({
  section,
  onNavigate,
}: {
  section: NavSection;
  onNavigate?: () => void;
}) {
  return (
    <div className="mb-3">
      <h3 className="px-3 pb-1 text-[11px] font-semibold text-[#86868b] uppercase tracking-wider">
        {section.title}
      </h3>
      <ul className="flex flex-col">
        {section.items.map((item) => (
          <NavItemRow
            key={item.label}
            item={item}
            depth={0}
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
  onNavigate,
}: {
  item: NavItem;
  depth: number;
  onNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const paddingLeft = 12 + depth * 16;

  if (item.type === "group") {
    return (
      <li>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center w-full gap-2 rounded-lg px-3 py-2 text-[14px] text-[#1d1d1f] hover:bg-[#f5f5f7] transition-colors active:scale-[0.98]"
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
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-[14px] text-[#1d1d1f] hover:bg-[#f5f5f7] transition-colors active:scale-[0.98]"
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
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-[14px] text-[#1d1d1f] hover:bg-[#f5f5f7] transition-colors active:scale-[0.98]"
          style={{ paddingLeft }}
        >
          <span>{item.label}</span>
          <ExternalIcon />
        </a>
      </li>
    );
  }

  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-[14px] text-[#1d1d1f] hover:bg-[#f5f5f7] transition-colors active:scale-[0.98]"
        style={{ paddingLeft }}
      >
        <span>{item.label}</span>
      </Link>
    </li>
  );
}

// ── Icons ──

function HamburgerIcon() {
  return (
    <svg
      className="w-[18px] h-[18px] text-[#1d1d1f]"
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
      className="w-4 h-4 text-[#86868b]"
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
      className={`w-3.5 h-3.5 text-[#86868b] transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
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
      className="w-4 h-4 text-[#86868b] flex-shrink-0"
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
      className="w-3 h-3 text-[#86868b] flex-shrink-0 ml-auto"
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
