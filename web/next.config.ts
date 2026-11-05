import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The root package only forwards commands; dependencies belong to /web.
  // Pinning the application root prevents Turbopack from choosing a parent
  // package or an unrelated lockfile.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
