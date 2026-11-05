import { defineConfig, passthroughImageService } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  outDir: 'dist/app',
  build: { inlineStylesheets: 'never' },
  vite: { build: { assetsInlineLimit: 0 } },
  image: { service: passthroughImageService() },
  devToolbar: { enabled: false },
});
