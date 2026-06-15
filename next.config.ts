import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "img.clerk.com",
      },
    ],    
  },
  allowedDevOrigins:[
    "871f-102-210-105-71.ngrok-free.app"
  ]
};

export default nextConfig;
