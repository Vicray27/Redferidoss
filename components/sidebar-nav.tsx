"use client";

// =============================================================================
// components/sidebar-nav.tsx — the module menu of the signed-in shell.
//
// The area is derived from the PATH, not from the role: a ROOT who opens
// /portal must see the portal items, and a MEMBER never reaches /admin. The
// role only decides the staff cross-link at the bottom, the one door between
// the two areas that the login landing does not advertise.
//
// `variant="list"` is the desktop column; `variant="drawer"` is the same
// column inside the mobile menu, with larger touch rows and a primary-tinted
// active item. Both render the same items, so a new module is added exactly
// once. The mobile drawer passes `onNavigate` to dismiss itself on a link.
//
// The active rule excludes the two landing roots on purpose: `/admin` must not
// light up while the user reads `/admin/pagos`. Each subpage owns its item.
// =============================================================================

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
  { href: "/portal/semana", label: "Semana y ofrendas", icon: CalendarDays },
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
  onNavigate,
}: {
  role: SessionPayload["role"];
  variant?: "list" | "drawer";
  /** Called after a link is clicked; the drawer uses it to dismiss itself. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const area = pathname.startsWith("/portal") ? "portal" : "admin";
  const items = area === "portal" ? PORTAL_ITEMS : ADMIN_ITEMS;
  // The system ROOT is not a member, so it never gets the "Mi portal" door.
  const crossLink = role === "ROOT" ? null : isStaffRole(role) ? STAFF_CROSSLINK[area] : null;

  return (
    <nav aria-label="Módulos" className="flex flex-col gap-1 px-3">
      {items.map((item) => (
        <NavLink
          key={item.href}
          item={item}
          active={isActive(pathname, item.href)}
          variant={variant}
          onNavigate={onNavigate}
        />
      ))}

      {crossLink ? (
        <div className="mt-2 border-t pt-2">
          <NavLink
            item={crossLink}
            active={isActive(pathname, crossLink.href)}
            variant={variant}
            onNavigate={onNavigate}
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
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  variant: "list" | "drawer";
  onNavigate?: () => void;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        variant === "drawer" && "min-h-11 py-2.5",
        variant === "drawer" && active && "border border-primary/20 bg-primary/10",
        variant === "drawer" && !active && "border border-transparent",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {item.label}
    </Link>
  );
}
