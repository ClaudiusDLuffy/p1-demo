import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "P1 Service Portal",
  description: "Operations management for 7-Eleven facility services",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        className="min-h-full"
        style={{
          fontFamily: "'Inter', system-ui, sans-serif",
          background: "#FAF7F2",
          color: "#1F1E1C",
        }}
      >
        {children}
      </body>
    </html>
  );
}
