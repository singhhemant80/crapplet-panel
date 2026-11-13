/** @type {import('next').NextConfig} */
const api = process.env.API_INTERNAL_URL || "http://127.0.0.1:4000";
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // the panel doesn't use next/image — keep the image optimiser (and its advisories) out of reach
  images: { unoptimized: true },
  // In production Nginx routes /api to the API directly; this rewrite makes `next dev` / `next start` work standalone.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};
export default nextConfig;
