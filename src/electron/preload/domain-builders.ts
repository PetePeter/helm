import { PRELOAD_API_DOMAINS, type PreloadApiDomain } from '../preload-api-contract.js';

type AnyFunction = (...args: any[]) => any;
export type PreloadMethodMap = Record<string, AnyFunction>;

export type DomainApi<
  TMethodMap extends PreloadMethodMap,
  TDomain extends PreloadApiDomain,
> = {
  [TMethod in (typeof PRELOAD_API_DOMAINS)[TDomain][number] as TMethod extends keyof TMethodMap
    ? TMethod
    : never]: TMethodMap[TMethod];
};

function pickDomainApi<TMethodMap extends PreloadMethodMap, TDomain extends PreloadApiDomain>(
  methodMap: TMethodMap,
  domain: TDomain,
): DomainApi<TMethodMap, TDomain> {
  return Object.fromEntries(
    PRELOAD_API_DOMAINS[domain].map((method) => [method, methodMap[method]]),
  ) as DomainApi<TMethodMap, TDomain>;
}

export const preloadDomainBuilders = {
  app: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'app'),
  sessions: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'sessions'),
  terminal: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'terminal'),
  delivery: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'delivery'),
  config: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'config'),
  tools: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'tools'),
  projects: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'projects'),
  mess: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'mess'),
  skills: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'skills'),
  plans: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'plans'),
  contexts: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'contexts'),
  memory: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'memory'),
  attachments: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'attachments'),
  incoming: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'incoming'),
  drafts: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'drafts'),
  scheduler: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'scheduler'),
  recycleBin: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'recycleBin'),
  runtimeGroups: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'runtimeGroups'),
  artifacts: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'artifacts'),
  peers: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'peers'),
  mobile: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'mobile'),
  patterns: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'patterns'),
  promptTemplates: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'promptTemplates'),
  telegram: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'telegram'),
  keyboard: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'keyboard'),
  dialog: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'dialog'),
  system: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'system'),
  events: <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => pickDomainApi(methodMap, 'events'),
} satisfies Record<PreloadApiDomain, <TMethodMap extends PreloadMethodMap>(methodMap: TMethodMap) => object>;

export type HelmPreloadApi<TMethodMap extends PreloadMethodMap> = {
  [TDomain in keyof typeof preloadDomainBuilders]: ReturnType<(typeof preloadDomainBuilders)[TDomain]>;
};

export function createPreloadDomains<TMethodMap extends PreloadMethodMap>(
  methodMap: TMethodMap,
): HelmPreloadApi<TMethodMap> {
  return Object.fromEntries(
    Object.entries(preloadDomainBuilders).map(([domain, buildDomain]) => [
      domain,
      buildDomain(methodMap),
    ]),
  ) as unknown as HelmPreloadApi<TMethodMap>;
}
