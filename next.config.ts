import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Produces .next/standalone with a minimal server.js + traced node_modules,
  // which keeps the Docker runtime image small.
  output: 'standalone',
  // `ws` must not be bundled: bundling breaks its optional native helpers
  // (bufferutil / utf-8-validate) and masking functions at runtime.
  serverExternalPackages: ['ws'],
  // `next dev` blocks dev assets for hostnames other than localhost, which
  // leaves the page unhydrated when opened via a LAN IP. Allow private ranges.
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '*.local'],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
