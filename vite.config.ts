import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    // `npm run server` on :8080; the dev site talks to it on the same origin.
    proxy: { '/api': 'http://localhost:8080', '/admin': 'http://localhost:8080', '/photos': 'http://localhost:8080' },
  },
  build: { target: 'es2022', sourcemap: true },
});
