"use client";

// =============================================================================
// components/dynamic-form/field-renderer.tsx — one custom field, rendered from
// its database definition.
//
// Controlled component: the parent owns the value map and the error map, this
// renders the right input for `field.type` and reports changes. Keeping it
// dumb means the same renderer can sit inside the registration form today and
// the profile/payment forms later without knowing anything about them.
// =============================================================================

import { Input, Label } from "@/components/ui/form";
import type { RegistrationField } from "@/lib/invitations";

import { choicesOf } from "./build-zod-schema";

const BOOL_OPTIONS = ["true", "false"] as const;

export function FieldRenderer({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: RegistrationField;
  value: unknown;
  error?: string;
  disabled?: boolean;
  onChange: (next: unknown) => void;
}) {
  // FILE fields are skipped at registration (uploads arrive with the payments
  // phase). The server skips them too — rendering nothing keeps the two honest.
  if (field.type === "FILE") return null;

  const inputId = `field-${field.code}`;
  const errorId = `${inputId}-error`;
  const invalid = error ? true : undefined;

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>
        {field.label}
        {field.isRequired ? <span className="text-destructive"> *</span> : null}
      </Label>

      {renderControl(field, inputId, value, invalid, disabled, errorId, onChange)}

      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function renderControl(
  field: RegistrationField,
  inputId: string,
  value: unknown,
  invalid: true | undefined,
  disabled: boolean | undefined,
  errorId: string,
  onChange: (next: unknown) => void,
) {
  const describedBy = invalid ? errorId : undefined;

  switch (field.type) {
    case "TEXTAREA":
      return (
        <textarea
          id={inputId}
          rows={3}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          disabled={disabled}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case "BOOL":
      return (
        <select
          id={inputId}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          disabled={disabled}
          value={value === true ? "true" : value === false ? "false" : ""}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === "" ? "" : raw === "true");
          }}
        >
          <option value="">—</option>
          <option value={BOOL_OPTIONS[0]}>Sí</option>
          <option value={BOOL_OPTIONS[1]}>No</option>
        </select>
      );

    case "SELECT":
      return (
        <select
          id={inputId}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          disabled={disabled}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {choicesOf(field.options).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      );

    case "MULTISELECT": {
      const selected = Array.isArray(value) ? value.map(String) : [];
      return (
        <div
          id={inputId}
          role="group"
          aria-describedby={describedBy}
          className="space-y-2 rounded-md border border-input bg-background p-3"
        >
          {choicesOf(field.options).map((choice) => {
            const checked = selected.includes(choice);
            return (
              <label key={choice} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    const next = checked
                      ? selected.filter((v) => v !== choice)
                      : [...selected, choice];
                    onChange(next);
                  }}
                />
                {choice}
              </label>
            );
          })}
        </div>
      );
    }

    case "DATE":
      return (
        <Input
          id={inputId}
          type="date"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          disabled={disabled}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case "DATETIME":
      return (
        <Input
          id={inputId}
          type="datetime-local"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          disabled={disabled}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    default: {
      const inputType =
        field.type === "EMAIL"
          ? "email"
          : field.type === "URL"
            ? "url"
            : field.type === "PHONE"
              ? "tel"
              : field.type === "NUMBER" || field.type === "DECIMAL"
                ? "text"
                : "text";

      const inputMode =
        field.type === "NUMBER"
          ? "numeric"
          : field.type === "DECIMAL"
            ? "decimal"
            : field.type === "PHONE"
              ? "tel"
              : undefined;

      return (
        <Input
          id={inputId}
          type={inputType}
          inputMode={inputMode}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          disabled={disabled}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    }
  }
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return String(value);
}
