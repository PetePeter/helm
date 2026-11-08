# User profiles

Each user profile owns its own `ProfileRuntime`, including its `ProjectStore`. A session spawn uses the runtime that owns the caller; it never falls back to profile 1.

## Spawn working directories

Desktop, MCP, scheduled, operator, restored, cloned, CLI-switched, API, ComfyUI and peer-created sessions must start inside a canonical or alternate folder registered in the owning profile's `ProjectStore`. The check resolves paths and existing symlinks/junctions, compares path boundaries, and treats Windows paths without case sensitivity. A rejected spawn reports the cwd and says it is outside that profile's project folders.

The row-less headless CLI used for auto-memory follows the same rule. It creates a per-run scratch folder beneath an existing project folder in its own profile and removes that folder after the run. If the profile has no existing project folder, the headless CLI does not start.

This rule limits the process's starting directory. Further folder limits come from the CLI's own sandbox or directory flags configured in that profile's CLI types. Helm does not add hook-policy confinement.
