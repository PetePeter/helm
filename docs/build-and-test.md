# Build & Test

## Commands

```bash
npm run build    # esbuild: main (dist-electron/main.js) + preload (dist-electron/preload.cjs); Vite: renderer (dist/renderer/)
npm run start    # Build and launch
npm run package  # Build + package portable Windows EXE to release/
npm test         # Vitest suite
```

## Release Workflow (two-step)

```bash
python prepareDeploy.py patch   # Bump version, strip configs, build, package EXE -> release/YYYYMMDD-vX.Y.Z/
# ... validate the EXE manually ...
python sendDeploy.py            # Commit, tag, push, upload installer via gh CLI
```

| Script | Purpose |
|--------|---------|
| `runApp.py` | Dev workflow - install deps, build, launch |
| `runTests.py` | Run Vitest suite |
| `prepareDeploy.py` | Release step 1 - bump version, strip configs for deploy, build, package EXE, build + signer-verify the Android APK |
| `sendDeploy.py` | Release step 2 - commit, tag, push, upload installer **and APK** to GitHub Releases via `gh` CLI |
| `deploy_android.py` | The shared Android half - APK build, certificate verification, refuse-to-publish gates. See [apk-distribution.md](apk-distribution.md) |

## Deploy Config Stripping

`prepareDeploy.py` creates a `config-deploy/` staging directory containing sanitised config files:
- **Profile YAMLs** - `workingDirectories` removed (no personal paths)
- **settings.yaml** - clean defaults only (no window bounds or session groups)
- **sessions.yaml** - empty (no saved sessions)

`electron-builder` overlays `config-deploy/` onto `config/` during packaging (see `build.files` in `package.json`). The staging directory is automatically cleaned up after the build, and is gitignored.

## Build Notes

- Three outputs, two bundlers: esbuild for main (`dist-electron/main.js`, ESM) and preload (`dist-electron/preload.cjs`, CJS — the preload runs in a context that is not ESM); Vite for the renderer into `dist/renderer/` from `renderer/index.html`
- Renderer filenames are **unhashed** (`assets/[name].js`) and `emptyOutDir` is off, because Helm can rebuild the renderer while Electron windows are still open — hashing would leave live windows pointing at chunks the build just deleted
- node-pty is `--external` in the electron esbuild (native addon, not bundled)

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop shell | Electron 41 |
| Language | TypeScript (ESM) |
| UI framework | Vue 3 (Composition API) + Pinia stores |
| Bundler | Vite (renderer) + esbuild (electron main/preload) |
| Tests | Vitest + @vue/test-utils |
| Gamepad input | Browser Gamepad API (sole input source) |
| Embedded terminals | node-pty (PTY) + @xterm/xterm (xterm.js) |
| PTY shell | cmd.exe (Windows), bash (Unix) |
| Haptic feedback | Config setting (implementation pending - PowerShell XInput path removed) |
| Config | YAML (yaml package) |
| Logging | Winston |
