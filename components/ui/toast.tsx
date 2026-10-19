"use client";

// =============================================================================
// components/ui/toast.tsx — the app-wide, dependency-free toast stack.
//
// The provider lives in the ROOT layout, outside every page subtree on
// purpose: Server Actions end with `router.refresh()`, and a toast rendered by
// the page itself would be unmounted by that refresh before the user could
// read it. Here the feedback survives the refresh, which is exactly what the
// approval journey asserts end to end.
// =============================================================================

import * as React from "react";

import { cn } from "@/lib/utils";

export type ToastVariant = "success" | "error";

export interface ToastItem {
  id: number;
  variant: ToastVariant;
  text: string;
}

/** At most this many toasts stay on screen; the oldest one is dropped. */
export const TOAST_MAX_VISIBLE = 4;

/** Errors stay longer than confirmations because they may need a retry. */
export const TOAST_DURATION_MS: Record<ToastVariant, number> = {
  success: 4000,
  error: 8000,
};

export function toastDurationMs(variant: ToastVariant): number {
  return TOAST_DURATION_MS[variant];
}

/**
 * Append a toast keeping insertion order (oldest first) and cap the stack from
 * the front. The viewport reverses the list so the NEWEST toast sits on top.
 * Pure so the capping rule is unit-testable without a DOM.
 */
export function pushToastStack(
  current: readonly ToastItem[],
  next: ToastItem,
  max = TOAST_MAX_VISIBLE,
): ToastItem[] {
  if (max <= 0) return [];
  return [...current, next].slice(-max);
}

interface ToastContextValue {
  success: (text: string) => void;
  error: (text: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (context === null) {
    throw new Error("useToast must be used inside ToastProvider");
  }
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const nextId = React.useRef(1);

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = React.useCallback((variant: ToastVariant, text: string) => {
    const item: ToastItem = { id: nextId.current, variant, text };
    nextId.current += 1;
    setToasts((current) => pushToastStack(current, item));
  }, []);

  const value = React.useMemo<ToastContextValue>(
    () => ({
      success: (text) => push("success", text),
      error: (text) => push("error", text),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col gap-2 p-4 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-96">
        {[...toasts].reverse().map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  React.useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toastDurationMs(toast.variant));
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast.id, toast.variant]);

  const isError = toast.variant === "error";

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-lg border border-l-4 bg-background p-3 text-sm text-foreground shadow-lg animate-toast-in motion-reduce:animate-none",
        isError ? "border-l-destructive" : "border-l-emerald-600",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
          isError ? "bg-destructive" : "bg-emerald-600",
        )}
      />
      <p className="min-w-0 flex-1 break-words">{toast.text}</p>
      <button
        type="button"
        aria-label="Cerrar"
        onClick={() => onDismiss(toast.id)}
        className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-lg leading-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <span aria-hidden>×</span>
      </button>
    </div>
  );
}
