import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildVersion(): string {
  // If VITE_APP_VERSION is explicitly set (e.g. by Vercel build command), use it
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION;
  try {
    const result = execSync('node scripts/gen-version.mjs', {
      encoding: 'utf8',
      cwd: __dirname,
    }).trim();
    return result || 'dev-local';
  } catch {
    return 'dev-local';
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(buildVersion()),
  },
});
