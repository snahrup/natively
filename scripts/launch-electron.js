const { spawn } = require('node:child_process');
const path = require('node:path');

// This repo can inherit ELECTRON_RUN_AS_NODE=1 from other tooling.
// When set, Electron spawns in pure Node mode and `require('electron').app`
// disappears, causing startup crashes.
delete process.env.ELECTRON_RUN_AS_NODE;

const mode = process.argv.includes('--production') ? 'production' : 'development';
process.env.NODE_ENV = mode;
const forwardedArgs = process.argv
  .slice(2)
  .filter((arg) => !['--production', '--development', '--no-show'].includes(arg));

const electronBinary = require('electron');
const projectRoot = path.resolve(__dirname, '..');

const appArgs = [projectRoot];
// In dev we want a visible window every time; otherwise the app can start hidden
// (tray/undetectable state) and looks like it never launched.
if (mode === 'development' && !process.argv.includes('--no-show')) {
  appArgs.push('--show');
}
if (forwardedArgs.length > 0) {
  appArgs.push(...forwardedArgs);
}

const child = spawn(electronBinary, appArgs, {
  stdio: 'inherit',
  env: process.env
});

child.on('error', (error) => {
  console.error('[launch-electron] failed to start Electron:', error);
  process.exitCode = 1;
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});
