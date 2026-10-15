"use client";

// =============================================================================
// components/qr-code.tsx — the QR image for an invitation link (§8.2).
//
// Generated in the browser from the link the visitor's own origin produced:
// the URL the QR encodes is therefore the SAME one the address bar shows, in
// dev and in production alike, without configuring APP_PUBLIC_URL twice.
// This is a real client component (dynamic import happens inside `qrcode`),
// so the encoder never lands in the server bundle.
// =============================================================================

import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrCode({
  value,
  size = 148,
  alt = "Código QR de la invitación",
}: {
  value: string;
  size?: number;
  alt?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDataUrl(null);
    QRCode.toDataURL(value, { width: size, margin: 1 })
      .then((url) => {
        if (active) setDataUrl(url);
      })
      .catch((error) => {
        console.error("[qr] generation failed:", error);
      });
    return () => {
      active = false;
    };
  }, [value, size]);

  if (!dataUrl) {
    return (
      <div
        aria-hidden
        className="animate-pulse rounded bg-muted"
        style={{ width: size, height: size }}
      />
    );
  }

  // A data: URL produced locally by `qrcode` — nothing remote, nothing user
  // controlled beyond the link text the encoder consumes.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={dataUrl} width={size} height={size} alt={alt} className="rounded border" />;
}
