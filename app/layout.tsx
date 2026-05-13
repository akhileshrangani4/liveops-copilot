import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LiveOps Copilot",
  description: "Operator copilot for live-commerce sellers",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
