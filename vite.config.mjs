import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const wasm = resolve('node_modules/@mediapipe/tasks-vision/wasm');
const files = readdirSync(wasm);
const apiPort = process.env.PHOTOBOX_PORT || 8787;

export default defineConfig(({ command, mode, isPreview }) => ({
  base: process.env.PHOTOBOX_BASE_PATH || '/',
  plugins: [react(), {
    name: 'local-mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/vision', async (req, res, next) => {
        const file = req.url.split('?')[0].slice(1);
        if (!files.includes(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(await readFile(resolve(wasm, file)));
      });
    },
    generateBundle() {
      return Promise.all(files.map(async (name) => this.emitFile({
        type: 'asset', fileName: `vision/${name}`, source: await readFile(resolve(wasm, name)),
      })));
    },
  }],
  server: {
    port: 5173,
    https: command === 'serve' && mode === 'lan' && !isPreview ? {
      key: readFileSync(resolve('data/lan/server.key')),
      cert: readFileSync(resolve('data/lan/server.crt')),
    } : undefined,
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/data/**', '**/*.sqlite*', '**/exports/**'],
    },
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
}));
