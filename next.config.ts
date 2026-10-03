import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  devIndicators: false,
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  async redirects() {
    return [{ source: "/", destination: "/ru", permanent: true }];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      { source: "/:lang/dating", headers: [{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" }] },
      { source: "/:lang/dating/:id", headers: [{ key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" }] },
      { source: "/:lang/clubhouse/:path*", headers: [{ key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" }] },
      { source: "/:lang/cloud-gaming/session/:path*", headers: [{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), display-capture=(self)" }] },
      // Every page refuses to be framed, except the widgets made for other sites.
      { source: "/((?!embed/).*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
      { source: "/embed/:path*", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }] },
    ];
  },
};
export default config;
