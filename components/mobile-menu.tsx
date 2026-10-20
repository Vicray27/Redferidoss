"use client";

// =============================================================================
// components/mobile-menu.tsx — the hamburger trigger and left slide-over menu
// for the mobile session shell.
//
// The drawer reuses the proven modal mechanics of `ConfirmDialog` (focus trap,
// initial focus, Escape, backdrop mousedown, body scroll lock/restore and focus
// restore) without importing a dialog library. The trigger and the drawer live
// in the same client component, but the identity block and the sign-out form
// are received as server-rendered slots: `NotificationBadge` queries the
// database, so it must never be rendered from here.
//
// The drawer only exists while it is open, so a closed menu never leaves a
// second hidden "Módulos" landmark in the document.
// =============================================================================

import * as React from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

import { SidebarNav } from "@/components/sidebar-nav";
import type { SessionPayload } from "@/lib/auth/session";

export function MobileMenu({
  role,
  roleLabel,
  identity,
  signOut,
}: {
  role: SessionPayload["role"];
  roleLabel: string;
  identity: React.ReactNode;
  signOut: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const titleId = React.useId();
  const drawerId = React.useId();
  const pathname = usePathname();

  // A route change always dismisses the drawer. Same-page clicks are handled
  // explicitly by `onNavigate`, never by this effect.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!open) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }

      if (event.key !== "Tab" || panel === null) return;

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );

      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      (triggerRef.current ?? previouslyFocused)?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Abrir menú"
        aria-expanded={open}
        aria-controls={drawerId}
        onClick={() => setOpen(true)}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-input bg-background text-foreground transition-colors hover:bg-muted"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            aria-hidden="true"
            onMouseDown={() => setOpen(false)}
            className="absolute inset-0 bg-black/40 animate-fade-in motion-reduce:animate-none"
          />

          <div
            ref={panelRef}
            id={drawerId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="absolute inset-y-0 left-0 flex h-full w-[min(20rem,85vw)] flex-col border-r bg-background text-foreground shadow-2xl animate-drawer-in motion-reduce:animate-none"
          >
            <div className="flex items-start justify-between gap-3 border-b px-4 py-4">
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Red de Referidos
                </p>
                <h2 id={titleId} className="mt-1 text-base font-semibold tracking-tight">
                  Menú de navegación
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">{roleLabel}</p>
              </div>

              <button
                ref={closeRef}
                type="button"
                aria-label="Cerrar menú"
                onClick={() => setOpen(false)}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-input bg-background transition-colors hover:bg-muted"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <div className="border-b px-4 py-3">{identity}</div>

            <div className="flex-1 overflow-y-auto py-2">
              <SidebarNav role={role} variant="drawer" onNavigate={() => setOpen(false)} />
            </div>

            <div className="mt-auto border-t p-4">{signOut}</div>
          </div>
        </div>
      ) : null}
    </>
  );
}
