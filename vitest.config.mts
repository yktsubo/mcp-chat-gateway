import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // Excludes vendored shadcn/ui and AI Elements components
      exclude: ['src/components/ui/**', 'src/components/ai-elements/**', 'src/**/*.test.{ts,tsx}', 'src/conformance/fakes.ts'],
      reporter: ['text', 'html'],
    },
  },
});
