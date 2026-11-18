/**
 * vitalo.uz (release 6, D-81). The browser talks to the same API as the Mini App: /api and /uploads are passed on to it.
 * On the server nginx does this itself; the rewrites are for `npm run dev` on the laptop.
 */
const API = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // A check build can go to its own folder while `npm run dev` keeps .next
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API}/api/:path*` },
      { source: '/uploads/:path*', destination: `${API}/uploads/:path*` },
      { source: '/sitemap.xml', destination: `${API}/api/sitemap.xml` },
    ];
  },
};
