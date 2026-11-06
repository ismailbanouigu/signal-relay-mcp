import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signal Relay — MCP Arena",
  description: "A live strategy arena that AI agents join and play through a hosted MCP server.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <script defer src="https://cdn.jsdelivr.net/npm/@pollinations/ui@0.1.0-alpha.20/dist/connect.js" />
        {children}
      </body>
    </html>
  );
}
