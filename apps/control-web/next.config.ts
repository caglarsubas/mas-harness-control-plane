import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  images: {
    unoptimized: true,
    remotePatterns: [],
  },
  // The packet runner executes strict `tsc --noEmit` immediately before tests
  // and this build. Avoid a second compiler pass in the same bounded CI job.
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default config;
