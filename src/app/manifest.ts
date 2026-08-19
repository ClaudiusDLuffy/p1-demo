import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "P1 Service Portal",
    short_name: "P1 Portal",
    description: "Operations management for 7-Eleven facility services",
    start_url: "/",
    display: "standalone",
    background_color: "#FAF7F2",
    theme_color: "#1F1E1C",
    orientation: "any",
    icons: [
      { src: "/p1-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/p1-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
