import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  testMatch: 'pages-base.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge',
  },
  webServer: {
    cwd: '..',
    command: 'npm run preview -- --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174/scratch-combo-web/',
    env: { VITE_BASE_PATH: '/scratch-combo-web/' },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
