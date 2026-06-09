import type { Metadata } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "P1 Service Portal",
  description: "Operations management for 7-Eleven facility services",
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
