"use client";

// =============================================================================
// components/sidebar-nav.tsx — the module menu of the signed-in shell.
//
// The area is derived from the PATH, not from the role: a ROOT who opens
// /portal must see the portal items, and a MEMBER never reaches /admin. The
// role only decides the staff cross-link at the bottom, the one door between
// the two areas that the login landing does not advertise.
//
// `variant="list"` is the desktop column; `variant="bar"` is the horizontal
// strip shown under the mobile top bar. Both render the same items, so a new
// module is added exactly once.
//
// The active rule excludes the two landing roots on purpose: `/admin` must not
// light up while the user reads `/admin/pagos`. Each subpage owns its item.
// =============================================================================

import { useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bell,
  CalendarDays,
  ClipboardCheck,
  CreditCard,
  HandCoins,
  Home,
  LayoutDashboard,
  ListChecks,
  Network,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  UserRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { isStaffRole } from "@/lib/auth/guards";
import type { SessionPayload } from "@/lib/auth/session";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };

const ADMIN_ITEMS: readonly NavItem[] = [
  { href: "/admin", label: "Panel", icon: LayoutDashboard },
  { href: "/admin/pagos", label: "Pagos", icon: Wallet },
  { href: "/admin/cumplimiento", label: "Cumplimiento", icon: ClipboardCheck },
  { href: "/admin/revisiones", label: "Revisión", icon: ListChecks },
  { href: "/admin/reportes", label: "Reportes", icon: BarChart3 },
  { href: "/admin/metodos-pago", label: "Métodos de pago", icon: CreditCard },
  { href: "/admin/campos-personalizados", label: "Campos personalizados", icon: SlidersHorizontal },
  { href: "/admin/configuracion", label: "Configuración", icon: Settings },
  { href: "/admin/notificaciones", label: "Notificaciones", icon: Bell },
];

const PORTAL_ITEMS: readonly NavItem[] = [
  { href: "/portal", label: "Inicio", icon: Home },
  { href: "/portal/network", label: "Mi red", icon: Network },
  { href: "/portal/invitations", label: "Invitaciones", icon: UserPlus },
  { href: "/portal/semana", label: "Semana y aportes", icon: CalendarDays },
  { href: "/portal/notificaciones", label: "Notificaciones", icon: Bell },
];

/** The staff-only door to the other area, from wherever the user is. */
const STAFF_CROSSLINK = {
  admin: { href: "/portal", label: "Mi portal", icon: UserRound },
  portal: { href: "/admin", label: "Panel de administración", icon: ShieldCheck },
} as const satisfies Record<"admin" | "portal", NavItem>;

function isActive(pathname: string, href: string): boolean {
  return (
    pathname === href ||
    (href !== "/admin" && href !== "/portal" && pathname.startsWith(`${href}/`))
  );
}

export function SidebarNav({
  role,
  variant = "list",
}: {
  role: SessionPayload["role"];
  variant?: "list" | "bar";
}) {
  const pathname = usePathname();
  const area = pathname.startsWith("/portal") ? "portal" : "admin";
  const items = area === "portal" ? PORTAL_ITEMS : ADMIN_ITEMS;
  const crossLink = isStaffRole(role) ? STAFF_CROSSLINK[area] : null;
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());

  const registerLink = useCallback((href: string, node: HTMLAnchorElement | null) => {
    if (node === null) linkRefs.current.delete(href);
    else linkRefs.current.set(href, node);
  }, []);

  // Keep the current module visible in the horizontal strip. `block: "nearest"`
  // avoids any vertical movement; only the strip's own overflow scrolls.
  useEffect(() => {
    if (variant !== "bar") return;
    const allItems = crossLink ? [...items, crossLink] : items;
    const active = allItems.find((item) => isActive(pathname, item.href));
    if (!active) return;
    linkRefs.current.get(active.href)?.scrollIntoView({
      block: "nearest",
      inline: "center",
    });
  }, [pathname, variant, crossLink, items]);

  return (
    <nav
      aria-label="Módulos"
      className={cn(
        variant === "bar"
          ? "flex gap-1 overflow-x-auto px-2 py-2"
          : "flex flex-col gap-1 px-3",
      )}
    >
      {items.map((item) => (
        <NavLink
          key={item.href}
          item={item}
          active={isActive(pathname, item.href)}
          variant={variant}
          onLinkRef={registerLink}
        />
      ))}

      {crossLink ? (
        <div
          className={cn(
            variant === "bar" ? "ml-1 flex shrink-0 border-l pl-1" : "mt-2 border-t pt-2",
          )}
        >
          <NavLink
            item={crossLink}
            active={isActive(pathname, crossLink.href)}
            variant={variant}
            onLinkRef={registerLink}
          />
        </div>
      ) : null}
    </nav>
  );
}

function NavLink({
  item,
  active,
  variant,
  onLinkRef,
}: {
  item: NavItem;
  active: boolean;
  variant: "list" | "bar";
  onLinkRef: (href: string, node: HTMLAnchorElement | null) => void;
}) {
  const Icon = item.icon;

  return (
    <Link
      ref={(node) => onLinkRef(item.href, node)}
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        variant === "bar" && "min-h-11 whitespace-nowrap py-2.5",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {item.label}
    </Link>
  );
}
