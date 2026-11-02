import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const configuredBase = process.env.VITE_BASE_PATH
const base = configuredBase && configuredBase.length > 0 ? configuredBase : '/'

if (!base.startsWith('/') || !base.endsWith('/')) {
  throw new Error('VITE_BASE_PATH must start and end with a slash, for example /scratch-combo-web/.')
}

export default defineConfig({
  base,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    exclude: ['e2e/**'],
    clearMocks: true,
    restoreMocks: true,
  },
})
