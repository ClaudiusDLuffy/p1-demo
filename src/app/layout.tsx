import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "P1 Service Portal",
  description: "Operations management for 7-Eleven facility services",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "P1 Portal",
  },
  icons: {
    icon: "/p1-icon-192.png",
    apple: "/p1-icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#1F1E1C",
};

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument-serif",
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`h-full antialiased ${inter.variable} ${instrumentSerif.variable} ${jetBrainsMono.variable}`}>
      <body
        className="min-h-full"
        style={{
          fontFamily: "var(--font-inter), system-ui, sans-serif",
          background: "#FAF7F2",
          color: "#1F1E1C",
        }}
      >
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
