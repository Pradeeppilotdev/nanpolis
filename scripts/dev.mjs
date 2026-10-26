import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const live = process.argv.includes('--live-data');
const children = [];
let stopping = false;
function signalChild(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') console.error(error.message);
  }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) signalChild(child, 'SIGTERM');
  const timeout = setTimeout(() => {
    for (const child of children) signalChild(child, 'SIGKILL');
  }, 5000);
  timeout.unref();
}

function start(folder, script, extra = []) {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['--prefix', folder, 'run', script, ...extra], {
      cwd: root,
      detached: process.platform !== 'win32',
      stdio: 'inherit',
      env: { ...process.env, MODE: 'DRY_RUN', DEMO_MODE: live ? '0' : '1' },
    });
  children.push(child);
  child.on('error', error => {
    console.error(`Could not start ${folder}/${script}: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${folder}/${script} stopped (${signal ?? code}). Stopping development services.`);
      stop(code || 1);
    }
  });
}

console.log(live
  ? 'Starting live-data dashboard (Nansen API credits required). No transaction loop is started.'
  : 'Starting historical demo dashboard. No API key or transactions required.');
start('agent', 'api');
if (live) start('agent', 'record');
start('web', 'dev', ['--', '--host', '127.0.0.1', '--strictPort']);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
