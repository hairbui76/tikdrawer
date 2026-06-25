import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TikDrawer — Visual TikZ editor",
  description: "Draw TikZ pictures visually and get LaTeX code with a live preview.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
