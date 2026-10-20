"use client";

import { Button } from "@/components/ui/button";

/**
 * window.print() is the PDF: the print dialog lets the operator pick "Save as
 * PDF" and the page is already laid out for A4 landscape. No PDF library, no
 * second rendering path (D48).
 */
export function PrintButton() {
  return (
    <Button
      type="button"
      onClick={() => window.print()}
      className="bg-[#2e67ff] text-white hover:bg-[#2456d8]"
    >
      Imprimir / Guardar PDF
    </Button>
  );
}
