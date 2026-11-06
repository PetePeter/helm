// Builds the native hook shim (tools/hook-shim) into src/config/hooks/helm-hook.exe,
// where config seeding ships it. Optional: without Go, the installer keeps the
// Python shim, so a missing toolchain is a note, not a failure.
import { execFileSync } from 'node:child_process';

if (process.platform !== 'win32') process.exit(0);
try {
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', '../../src/config/hooks/helm-hook.exe', '.'], {
    cwd: 'tools/hook-shim',
    stdio: 'inherit',
  });
} catch (error) {
  console.warn(`[build-hook-shim] skipped, hooks stay on the Python shim: ${error.message}`);
}
