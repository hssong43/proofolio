import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep credential-free test builds separate from a running signed-in preview.
  distDir: process.env.PROOFOLIO_E2E === '1' ? '.next-e2e' : '.next',
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)),
  outputFileTracingIncludes: {
    '/api/analyze{,/**}': ['../node_modules/pdfjs-dist/package.json', '../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm,legacy/build}/**/*', '../node_modules/@napi-rs/canvas*/**/*'],
  },
};

export default nextConfig;
