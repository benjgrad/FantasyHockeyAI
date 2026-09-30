import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { build, defineConfig, type Plugin } from 'vite';
import { precacheManifest } from './src/pwa/precache';

/** The app server (apps/app) in dev. Vite proxies the API and the sign-in flow to it. */
const API_TARGET = process.env['API_TARGET'] ?? 'http://127.0.0.1:8720';

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The service worker is built separately, after the main bundle, as one unhashed IIFE at
 * `/sw.js`: a worker's identity is its URL, so it cannot carry a content hash, and some
 * browsers still refuse module workers.
 *
 * This build's precache manifest (every emitted file, public/ files and index.html, plus a
 * version derived from them — see src/pwa/precache.ts) is injected as `__FHA_PRECACHE__`.
 * Baking it into the worker's bytes means any change to the app changes `sw.js`, which is
 * what makes the browser install the new worker; no second request is needed at install.
 * The same approach as personal-os, hand-written instead of vite-plugin-pwa/workbox.
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'fha-service-worker',
    apply: 'build',
    // writeBundle, not generateBundle: the worker's own build writes into the same outDir,
    // and doing that mid-bundle confuses Rollup's asset graph.
    async writeBundle(options, bundle) {
      const publicDir = src('./public');
      const publicFiles = readdirSync(publicDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
      const html = bundle['index.html'];
      const manifest = precacheManifest({
        emitted: Object.keys(bundle),
        publicFiles,
        fingerprint: [
          html?.type === 'asset' ? String(html.source) : '',
          ...publicFiles.map((name) =>
            createHash('sha256')
              .update(readFileSync(`${publicDir}/${name}`))
              .digest('hex'),
          ),
        ],
      });
      await build({
        configFile: false,
        logLevel: 'warn',
        define: { __FHA_PRECACHE__: JSON.stringify(manifest) },
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
