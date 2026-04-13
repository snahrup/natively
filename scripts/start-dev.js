const { createServer } = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');

const PORT = 5180;
const HOST = '127.0.0.1';

let serverProc = null;
let launchedElectron = null;
let shouldStopServer = false;

const ELECTRON_BOOTSTRAP_PATH = path.join(process.cwd(), 'dist-electron', 'electron', 'bootstrap.js');

function portOpen(host, port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, host, () => {
      probe.close();
      resolve(false);
    });
  });
}

async function waitForUrl(url, attempts = 150, intervalMs = 200) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'manual' });
      if (response.ok || response.status >= 400) {
        return true;
      }
    } catch {
      // keep waiting
    }
    await sleep(intervalMs);
  }
  return false;
}

function startViteServer() {
  console.log('[start-dev] Starting Vite dev server on http://127.0.0.1:5180');
  const child = spawn(
    'npm',
    ['run', 'dev', '--', '--host', HOST, '--port', String(PORT), '--strictPort'],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: true,
    }
  );

  serverProc = child;

  child.on('error', (error) => {
    console.error('[start-dev] Vite spawn failed:', error);
    process.exit(1);
  });

  child.on('exit', (code) => {
    if (!shouldStopServer && code !== 0) {
      console.error('[start-dev] Vite exited unexpectedly with code', code);
      process.exit(code ?? 1);
    }
  });

  return child;
}

function ensureElectronBuild() {
  if (fs.existsSync(ELECTRON_BOOTSTRAP_PATH)) {
    return;
  }

  console.log('[start-dev] Electron bootstrap missing. Running npm run build:electron');
  const isWindows = process.platform === 'win32';
  const npmBinary = isWindows ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmBinary, ['run', 'build:electron'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  });

  if (result.status !== 0) {
    console.error('[start-dev] build:electron failed with code', result.status);
    process.exit(result.status ?? 1);
  }
}

function launchElectron() {
  console.log('[start-dev] Launching Electron');
  const forwardedArgs = process.argv.slice(2);
  launchedElectron = spawn(process.execPath, ['scripts/launch-electron.js', '--development', ...forwardedArgs], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  });

  launchedElectron.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  launchedElectron.on('error', (error) => {
    console.error('[start-dev] Electron launch failed:', error);
    process.exit(1);
  });
}

function shutdown() {
  shouldStopServer = true;
  if (launchedElectron && !launchedElectron.killed) {
    launchedElectron.kill('SIGINT');
  }
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGINT');
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  ensureElectronBuild();

  const url = `http://${HOST}:${PORT}`;
  const inUse = await portOpen(HOST, PORT);
  if (!inUse) {
    startViteServer();
  } else {
    console.log('[start-dev] Reusing existing server on 127.0.0.1:5180');
  }

  const ready = await waitForUrl(url);
  if (!ready) {
    console.error('[start-dev] Timed out waiting for', url);
    process.exit(1);
  }

  launchElectron();
})();
