"use client";

// =============================================================================
// components/ui/confirm-dialog.tsx — controlled confirmation modals and the
// required rejection-motive flow, with no dialog dependency.
//
// A native `window.confirm`/`window.prompt` cannot be styled, blocks the event
// loop and, for rejections, discards the typed motive with no inline error.
// This primitive keeps the same server contract while giving the operator a
// real dialog: `role="dialog"`, focus trap, Escape/backdrop cancel, focus
// restore, and a busy state that prevents a second submit.
// =============================================================================

import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Same copy the server-side guard implies for an empty rejection motive. */
export const REJECTION_MOTIVE_ERROR = "El rechazo necesita un motivo.";

/** Pure validation so the required-motive rule is unit-testable. */
export function isRejectionMotiveValid(value: string): boolean {
  return value.trim() !== "";
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  /** Defaults to "Cancelar". */
  cancelLabel?: string;
  variant?: "default" | "danger";
  /** Disables both actions while the action is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional body content (for example the rejection motive textarea). */
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancelar",
  variant = "default",
  busy = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const confirmRef = React.useRef<HTMLButtonElement | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);

  // Latest callbacks without retriggering the focus effect on every render
  // (call sites pass inline handlers).
  const onCancelRef = React.useRef(onCancel);
  const busyRef = React.useRef(busy);
  React.useEffect(() => {
    onCancelRef.current = onCancel;
    busyRef.current = busy;
  });

  React.useEffect(() => {
    if (!open) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    // Content that must own the initial focus (the motive textarea) opts in.
    const requested = panel?.querySelector<HTMLElement>("[data-autofocus]");
    const initial =
      requested ??
      (variant === "danger" ? cancelRef.current : confirmRef.current) ??
      panel;
    initial?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onCancelRef.current();
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
      previouslyFocused?.focus();
    };
  }, [open, variant]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-lg border bg-background p-5 text-foreground shadow-xl animate-dialog-in motion-reduce:animate-none"
      >
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
        {children ? <div className="mt-4 space-y-2">{children}</div> : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={busy}
            className="h-9 px-3"
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              "h-9 px-3",
              variant === "danger" &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface MotiveDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** Defaults to "Rechazar". */
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: (motive: string) => void;
  onCancel: () => void;
}

/**
 * The rejection flow: a required textarea in the shared dialog shell. The
 * server still refuses an empty motive; this just keeps the operator from
 * submitting one and shows the same message inline.
 */
export function MotiveDialog({
  open,
  title,
  description,
  confirmLabel = "Rechazar",
  busy = false,
  onConfirm,
  onCancel,
}: MotiveDialogProps) {
  const textareaId = React.useId();
  const errorId = React.useId();
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [motive, setMotive] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // A closed dialog must never reopen with someone else's motive.
  React.useEffect(() => {
    if (!open) return;
    setMotive("");
    setError(null);
  }, [open]);

  const submit = () => {
    if (!isRejectionMotiveValid(motive)) {
      setError(REJECTION_MOTIVE_ERROR);
      textareaRef.current?.focus();
      return;
    }
    onConfirm(motive.trim());
  };

  return (
    <ConfirmDialog
      open={open}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      busy={busy}
      onConfirm={submit}
      onCancel={onCancel}
    >
      <label htmlFor={textareaId} className="text-sm font-medium">
        Motivo (lo verá cada persona)
      </label>
      <textarea
        ref={textareaRef}
        id={textareaId}
        data-autofocus
        rows={3}
        value={motive}
        disabled={busy}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          setMotive(event.target.value);
          if (error !== null) setError(null);
        }}
        className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive"
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
