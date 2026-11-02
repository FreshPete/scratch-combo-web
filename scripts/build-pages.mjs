import { spawnSync } from 'node:child_process'

const isWindows = process.platform === 'win32'
const command = isWindows ? process.env.ComSpec ?? 'cmd.exe' : 'npm'
const args = isWindows ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build']
const result = spawnSync(command, args, {
  env: { ...process.env, VITE_BASE_PATH: '/scratch-combo-web/' },
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
