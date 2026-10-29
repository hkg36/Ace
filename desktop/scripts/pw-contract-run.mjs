import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = await mkdtemp(path.join(os.tmpdir(), 'crew-pw-contract-'));
const script = fileURLToPath(new URL('./pw-contract.mjs', import.meta.url));

try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [script, `--user-data-dir=${path.join(root, 'user-data')}`], {
      stdio: 'inherit',
      env: {
        ...process.env,
        TEMP: root,
        TMP: root,
        TMPDIR: root,
        CREW_PW_CONTRACT_TEMP_ROOT: root,
      },
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (signal) reject(new Error(`Electron contract terminated by ${signal}`));
      else resolve(exitCode ?? 1);
    });
  });
  process.exitCode = code;
} finally {
  // Persistent Electron Sessions keep profile databases open until process exit.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
