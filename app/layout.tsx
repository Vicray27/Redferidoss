import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Red de Referidos",
  description: "Administra tu red, tus aportes y tu cumplimiento semanal.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
