import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This repository is not an npm workspace; the Next application and its
  // only lockfile live in /web. Pinning the absolute root prevents Turbopack
  // from walking upward and selecting an unrelated lockfile.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
