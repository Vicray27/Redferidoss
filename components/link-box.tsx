"use client";

// =============================================================================
// components/link-box.tsx — show a shareable link with copy + QR.
//
// The absolute URL is composed AFTER mount from `window.location.origin`, so
// the value the visitor copies is the origin they are actually using (dev,
// staging, production) without the server having to know it. Before mount the
// path alone is rendered — SSR and hydration agree, then the origin fills in.
// =============================================================================

import { useEffect, useState } from "react";

import { QrCode } from "@/components/qr-code";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";

export function LinkBox({ path, note }: { path: string; note?: string }) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const url = `${origin ?? ""}${path}`;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("[link-box] clipboard unavailable:", error);
    }
  };

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <QrCode value={url} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex gap-2">
          <Input readOnly value={url} onFocus={(event) => event.target.select()} />
          <Button type="button" variant="outline" onClick={onCopy}>
            {copied ? "Copiado" : "Copiar"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {note ?? "Comparte este link con quien quieras invitar."}
        </p>
      </div>
    </div>
  );
}
