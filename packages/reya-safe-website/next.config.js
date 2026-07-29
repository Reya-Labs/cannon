/** @type {import('next').NextConfig} */
module.exports = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    unoptimized: true,
  },
  output: 'export',
  productionBrowserSourceMaps: false,
  reactStrictMode: true,
  transpilePackages: ['@reya/cannon-safe-ui'],
  webpack(config) {
    config.resolve.alias['@'] = require('path').resolve(
      __dirname,
      '../website/src'
    );
    config.resolve.alias['@cannon'] = require('path').resolve(
      __dirname,
      '../website/src'
    );
    config.resolve.fallback = {
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};
