import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Red de Referidos",
  description: "Referral network foundation (F1 scaffold).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
