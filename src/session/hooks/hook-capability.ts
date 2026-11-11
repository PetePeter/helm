/**
 * The G4 rules-via-hooks capability check — the ONE decision behind both
 * delivery paths (HelmSessionDeliveryService's prepended [HELM_MSG] rules and
 * the remote chat instruction line).
 *
 * A recipient injects its rules out-of-band only when ALL of these hold:
 * - a provider can be resolved for its CLI type — the top-level `provider`
 *   mapping (auto-migrated, dropdown-editable), falling back to the legacy
 *   hooks block — and it is one whose UserPromptSubmit command-hook output
 *   reaches the model (Copilot's is dropped by the CLI — see ContextInjector),
 * - the hook block is actually on disk (installed or merely outdated — a stale
 *   block still fires; not-installed or a missing interpreter does not),
 *   read against the type's hooks block or, absent one, the provider's
 *   canonical config (hook-providers.ts).
 *
 * EVERY failure answers false: false means "prepend as today", so a disk error
 * can never degrade delivery, only fall back to the behaviour sessions without
 * hooks already have.
 */

import type { CliHooksIntegration, CliTypeConfig } from '../../config/loader.js';
import type { SessionInfo } from '../../types/session.js';
import { type HookIntegrationStatus, type HookInstallerDeps } from './hook-installer.js';
import { getHookProviderConfig } from './hook-providers.js';
import { PROMPT_INJECTION_PROVIDERS } from './context-injector.js';
import { logger } from '../../utils/logger.js';

/** Per-recipient capability read shared by the delivery and relay paths. */
export type RulesViaHooksFn = (session: SessionInfo) => Promise<boolean>;

/** Whether a CLI type's hooks are on disk, so its sessions report hook events. */
export type HooksInstalledFn = (cliTypeId: string) => Promise<boolean>;

type CliTypeHooksEntry = (cliTypeId: string) => Pick<CliTypeConfig, 'hooks' | 'provider'> | null;
type ReadHookStatus = (hooks: CliHooksIntegration) => Promise<HookIntegrationStatus>;

/**
 * The provider a CLI type maps to. The top-level mapping is authoritative
 * (auto-migrated, dropdown-editable); the legacy hooks block is the fallback
 * for entries that predate it. `null` is an explicit "Not mapped" — it answers
 * the question, so the legacy fallback must NOT resurrect what the user turned off.
 */
function providerOf(entry: Pick<CliTypeConfig, 'hooks' | 'provider'> | null): string | null | undefined {
  return entry?.provider !== undefined ? entry.provider : entry?.hooks?.provider;
}

/**
 * Installed or merely outdated (a stale block still fires) counts; not-installed
 * or a missing interpreter does not. Every failure answers false.
 */
export function createHooksInstalledFn(getCliTypeEntry: CliTypeHooksEntry, readStatus: ReadHookStatus): HooksInstalledFn {
  return (cliTypeId) => checkInstalled(getCliTypeEntry, readStatus, cliTypeId, () => true);
}

export function createRulesViaHooksFn(getCliTypeEntry: CliTypeHooksEntry, readStatus: ReadHookStatus): RulesViaHooksFn {
  return (session) => checkInstalled(getCliTypeEntry, readStatus, session.cliType, p => PROMPT_INJECTION_PROVIDERS.has(p));
}

async function checkInstalled(
  getCliTypeEntry: CliTypeHooksEntry,
  readStatus: ReadHookStatus,
  cliTypeId: string,
  providerQualifies: (provider: string) => boolean,
): Promise<boolean> {
  try {
    const entry = getCliTypeEntry(cliTypeId);
    const provider = providerOf(entry);
    if (!provider || !providerQualifies(provider)) return false;
    // Provider known, no hooks block: the provider's canonical config
    // (hook-providers.ts) is what would be installed — read status by it.
    const hooks = entry?.hooks ?? (getHookProviderConfig(provider) as CliHooksIntegration | null);
    if (!hooks) return false;
    const status = await readStatus(hooks);
    return status === 'installed' || status === 'outdated';
  } catch (error) {
    logger.warn(`[HookCapability] hook install check failed for ${cliTypeId}: ${String(error)}`);
    return false;
  }
}

export type { HookInstallerDeps };
