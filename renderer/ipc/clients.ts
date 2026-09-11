import type { HelmAPI } from '../../src/electron/preload';

type DomainName = keyof HelmAPI;

function domainClient<TDomain extends DomainName>(domain: TDomain): HelmAPI[TDomain] {
  return new Proxy({} as HelmAPI[TDomain], {
    get(_target, property) {
      const helmDomain = window.helm?.[domain] as Record<PropertyKey, unknown> | undefined;
      if (helmDomain && property in helmDomain) return helmDomain[property];

      const legacyApi = window.gamepadCli as unknown as Record<PropertyKey, unknown> | undefined;
      return legacyApi?.[property];
    },
    has(_target, property) {
      return Boolean((window.helm?.[domain] as Record<PropertyKey, unknown> | undefined)?.[property])
        || Boolean((window.gamepadCli as unknown as Record<PropertyKey, unknown> | undefined)?.[property]);
    },
  });
}

export const appClient = domainClient('app');
export const sessionsClient = domainClient('sessions');
export const terminalClient = domainClient('terminal');
export const deliveryClient = domainClient('delivery');
export const configClient = domainClient('config');
export const toolsClient = domainClient('tools');
export const projectsClient = domainClient('projects');
export const messClient = domainClient('mess');
export const skillsClient = domainClient('skills');
export const plansClient = domainClient('plans');
export const contextsClient = domainClient('contexts');
export const memoryClient = domainClient('memory');
export const attachmentsClient = domainClient('attachments');
export const incomingClient = domainClient('incoming');
export const draftsClient = domainClient('drafts');
const baseSchedulerClient = domainClient('scheduler');

/**
 * Scheduler client with convenience history accessors layered on top of the
 * proxied preload domain. The underlying domainClient is a Proxy whose get trap
 * never returns own properties, so the aliases are exposed via a wrapper object
 * (not Object.assign on the proxy). The proxy is spread first so all raw
 * scheduledTask* methods remain reachable through getter forwarding.
 */
export const schedulerClient = new Proxy(baseSchedulerClient, {
  get(target, property, receiver) {
    if (property === 'listHistory') return () => baseSchedulerClient.scheduledTaskListHistory();
    if (property === 'clearHistory') return () => baseSchedulerClient.scheduledTaskClearHistory();
    return Reflect.get(target, property, receiver);
  },
}) as typeof baseSchedulerClient & {
  listHistory: () => ReturnType<typeof baseSchedulerClient.scheduledTaskListHistory>;
  clearHistory: () => ReturnType<typeof baseSchedulerClient.scheduledTaskClearHistory>;
};
export const recycleBinClient = domainClient('recycleBin');
export const artifactsClient = domainClient('artifacts');
export const runtimeGroupClient = domainClient('runtimeGroups');
export const patternsClient = domainClient('patterns');
export const telegramClient = domainClient('telegram');
export const keyboardClient = domainClient('keyboard');
export const dialogClient = domainClient('dialog');
export const systemClient = domainClient('system');
export const eventsClient = domainClient('events');
export const promptTemplatesClient = domainClient('promptTemplates');
export const peersClient = domainClient('peers');
export const mobileClient = domainClient('mobile');
