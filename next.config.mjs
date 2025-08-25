/** @type {import('next').NextConfig} */
const nextConfig = {
  // optional: turn this off if the double-useEffect logs bother you in dev
  // reactStrictMode: false,

  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  images: { unoptimized: true },

  webpack: (config) => {
    // Ensure Human never tries to pull the Node TFJS backend in the browser
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "@tensorflow/tfjs-node": false,
      // quiet any stray node-only deps
      fs: false,
      path: false,
      canvas: false,
    };
    return config;
  },
};

export default nextConfig;
