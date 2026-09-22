/**
 * The G4 rules-via-hooks capability check — the ONE decision behind both
 * delivery paths (HelmSessionDeliveryService's prepended [HELM_MSG] rules and
 * the Telegram relay's trailing instruction line).
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

export function createRulesViaHooksFn(
  getCliTypeEntry: (cliTypeId: string) => Pick<CliTypeConfig, 'hooks' | 'provider'> | null,
  readStatus: (hooks: CliHooksIntegration) => Promise<HookIntegrationStatus>,
): RulesViaHooksFn {
  return async (session) => {
    try {
      const entry = getCliTypeEntry(session.cliType);
      // The top-level mapping is authoritative (auto-migrated, dropdown-editable);
      // the legacy hooks block is the fallback for entries that predate it.
      // `null` is an explicit "Not mapped" — it answers the question, so the
      // legacy fallback must NOT resurrect capability the user turned off.
      const provider = entry?.provider !== undefined ? entry.provider : entry?.hooks?.provider;
      if (!provider || !PROMPT_INJECTION_PROVIDERS.has(provider)) return false;
      const hooks = entry?.hooks ?? null;
      if (!hooks) {
        // Provider known, no hooks block: the provider's canonical config
        // (hook-providers.ts) is what would be installed — read status by it.
        const canonical = getHookProviderConfig(provider);
        if (!canonical) return false;
        const status = await readStatus(canonical as CliHooksIntegration);
        return status === 'installed' || status === 'outdated';
      }
      const status = await readStatus(hooks);
      return status === 'installed' || status === 'outdated';
    } catch (error) {
      logger.warn(`[HookCapability] rules-via-hooks check failed for ${session.id}: ${String(error)}`);
      return false;
    }
  };
}

export type { HookInstallerDeps };
