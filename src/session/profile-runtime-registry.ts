import type { ProfileRuntime } from './profile-runtime.js';

/** Process-wide index of the active profile runtimes. */
export class ProfileRuntimeRegistry {
  private readonly runtimes = new Map<string, ProfileRuntime>();

  constructor(runtimes: Iterable<ProfileRuntime> = []) {
    for (const runtime of runtimes) this.register(runtime);
  }

  register(runtime: ProfileRuntime): void {
    if (this.runtimes.has(runtime.userProfileId)) {
      throw new Error(`Profile runtime already registered: ${runtime.userProfileId}`);
    }
    this.runtimes.set(runtime.userProfileId, runtime);
  }

  unregister(userProfileId: string): ProfileRuntime | undefined {
    const runtime = this.runtimes.get(userProfileId);
    if (!runtime) return undefined;
    this.runtimes.delete(userProfileId);
    return runtime;
  }

  getRequiredRuntime(userProfileId: string): ProfileRuntime {
    const runtime = this.runtimes.get(userProfileId);
    if (!runtime) throw new Error(`Unknown user profile: ${userProfileId}`);
    return runtime;
  }

  all(): ProfileRuntime[] {
    return [...this.runtimes.values()];
  }

  /** Resolve ownership through the session containers rather than assuming profile 1. */
  findSessionOwner(sessionId: string): ProfileRuntime | undefined {
    let owner: ProfileRuntime | undefined;
    for (const runtime of this.runtimes.values()) {
      if (!runtime.sessionManager.hasSession(sessionId)) continue;
      if (owner) throw new Error(`Session id is owned by more than one profile: ${sessionId}`);
      owner = runtime;
    }
    return owner;
  }
}
