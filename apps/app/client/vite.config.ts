import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { build, defineConfig, type Plugin } from 'vite';

/** The app server (apps/app) in dev. Vite proxies the API and the sign-in flow to it. */
const API_TARGET = process.env['API_TARGET'] ?? 'http://127.0.0.1:8720';

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The service worker is built separately, after the main bundle, as one unhashed IIFE at
 * `/sw.js`: a worker's identity is its URL, so it cannot carry a content hash, and some
 * browsers still refuse module workers. (The same approach as personal-os, minus the precache:
 * this app shows what is true *now*, and a cached copy of a lineup is worse than none.)
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'fha-service-worker',
    apply: 'build',
    async writeBundle(options) {
      await build({
        configFile: false,
        logLevel: 'warn',
        build: {
          outDir: options.dir,
          emptyOutDir: false,
          lib: {
            entry: src('./src/sw.ts'),
            formats: ['iife'],
            name: 'sw',
            fileName: () => 'sw.js',
          },
          rollupOptions: { output: { entryFileNames: 'sw.js', extend: true } },
        },
      });
    },
  };
}

/** Cross-origin in dev: the server checks Origin on mutations, so present its own. */
const proxyTo = {
  target: API_TARGET,
  changeOrigin: true,
  configure: (proxy: {
    on: (
      event: 'proxyReq',
      fn: (req: { setHeader: (k: string, v: string) => void }) => void,
    ) => void;
  }) => {
    proxy.on('proxyReq', (req) => req.setHeader('origin', API_TARGET));
  },
};

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss(), serviceWorkerPlugin()],
  resolve: {
    // Both are pure zod; bundling the source avoids depending on a built dist.
    alias: {
      '@fha/api': src('../../../libs/api/src/index.ts'),
      '@fha/core': src('../../../libs/core/src/index.ts'),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 700 },
  server: {
    port: 5173,
    proxy: { '/api': proxyTo, '/auth': proxyTo },
  },
});
