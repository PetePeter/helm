/**
 * The G4 rules-via-hooks capability check — the ONE decision behind both
 * delivery paths (HelmSessionDeliveryService's prepended [HELM_MSG] rules and
 * the Telegram relay's trailing instruction line).
 *
 * A recipient injects its rules out-of-band only when ALL of these hold:
 * - its CLI type has a hooks block configured at all,
 * - the provider is one whose UserPromptSubmit command-hook output reaches the
 *   model (Copilot's is dropped by the CLI — see ContextInjector), and
 * - the hook block is actually on disk (installed or merely outdated — a stale
 *   block still fires; not-installed or a missing interpreter does not).
 *
 * EVERY failure answers false: false means "prepend as today", so a disk error
 * can never degrade delivery, only fall back to the behaviour sessions without
 * hooks already have.
 */

import type { CliHooksIntegration, CliTypeConfig } from '../../config/loader.js';
import type { SessionInfo } from '../../types/session.js';
import { readHookIntegrationStatus, type HookIntegrationStatus, type HookInstallerDeps } from './hook-installer.js';
import { PROMPT_INJECTION_PROVIDERS } from './context-injector.js';
import { logger } from '../../utils/logger.js';

/** Per-recipient capability read shared by the delivery and relay paths. */
export type RulesViaHooksFn = (session: SessionInfo) => Promise<boolean>;

export function createRulesViaHooksFn(
  getCliTypeEntry: (cliTypeId: string) => Pick<CliTypeConfig, 'hooks'> | null,
  readStatus: (hooks: CliHooksIntegration) => Promise<HookIntegrationStatus>,
): RulesViaHooksFn {
  return async (session) => {
    try {
      const hooks = getCliTypeEntry(session.cliType)?.hooks;
      if (!hooks || !PROMPT_INJECTION_PROVIDERS.has(hooks.provider)) return false;
      const status = await readStatus(hooks);
      return status === 'installed' || status === 'outdated';
    } catch (error) {
      logger.warn(`[HookCapability] rules-via-hooks check failed for ${session.id}: ${String(error)}`);
      return false;
    }
  };
}

export type { HookInstallerDeps };
