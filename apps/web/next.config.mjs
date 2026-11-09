/** @type {import('next').NextConfig} */
const api = process.env.API_INTERNAL_URL || "http://127.0.0.1:4000";
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // In production Nginx routes /api to the API directly; this rewrite makes `next dev` / `next start` work standalone.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};
export default nextConfig;
