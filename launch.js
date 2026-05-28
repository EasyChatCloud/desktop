const { spawn } = require('child_process')
const path = require('path')

// Remove ELECTRON_RUN_AS_NODE to ensure Electron runs in full mode
delete process.env.ELECTRON_RUN_AS_NODE

const electron = require('electron')
const args = [path.join(__dirname, 'main/index.js')]

if (process.argv.includes('--dev')) {
  args.push('--dev')
}

const child = spawn(electron, args, {
  stdio: 'inherit',
  windowsHide: false
})

child.on('close', (code) => process.exit(code))
