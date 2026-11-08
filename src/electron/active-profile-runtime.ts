import type { ProfileRuntime } from '../session/profile-runtime.js';

type RuntimeKey = keyof ProfileRuntime;
type RuntimeEventListener = (...args: unknown[]) => void;

interface RuntimeSubscription {
  service: RuntimeKey;
  event: string | symbol;
  listener: RuntimeEventListener;
  wrapper: RuntimeEventListener;
}

/** Stable service references whose calls follow the currently selected runtime. */
export class ActiveProfileRuntimeView {
  private current: ProfileRuntime;
  private readonly services = new Map<RuntimeKey, object>();
  private readonly subscriptions: RuntimeSubscription[] = [];
  readonly runtime: ProfileRuntime;

  constructor(initial: ProfileRuntime) {
    this.current = initial;
    this.runtime = new Proxy({} as ProfileRuntime, {
      get: (_target, property) => {
        const value = Reflect.get(this.current, property, this.current);
        return value !== null && typeof value === 'object'
          ? this.service(property as RuntimeKey)
          : typeof value === 'function' ? value.bind(this.current) : value;
      },
      set: (_target, property, value) => Reflect.set(this.current, property, value, this.current),
    });
  }

  select(runtime: ProfileRuntime): void {
    if (runtime === this.current) return;
    for (const subscription of this.subscriptions) {
      this.removeFrom(this.current, subscription);
    }
    this.current = runtime;
    for (const subscription of this.subscriptions) {
      this.addTo(this.current, subscription);
    }
  }

  private service(key: RuntimeKey): object {
    const cached = this.services.get(key);
    if (cached) return cached;

    const proxy = new Proxy(Object.create(null) as object, {
      get: (_target, property) => {
        if (property === 'on' || property === 'addListener') {
          return (event: string | symbol, listener: RuntimeEventListener) => {
            this.subscribe(key, event, listener);
            return proxy;
          };
        }
        if (property === 'off' || property === 'removeListener') {
          return (event: string | symbol, listener: RuntimeEventListener) => {
            this.unsubscribe(key, event, listener);
            return proxy;
          };
        }
        const target = this.current[key] as object;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set: (_target, property, value) => {
        const target = this.current[key] as object;
        return Reflect.set(target, property, value, target);
      },
      has: (_target, property) => property in (this.current[key] as object),
      ownKeys: () => Reflect.ownKeys(this.current[key] as object),
      getOwnPropertyDescriptor: (_target, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(this.current[key] as object, property);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    });
    this.services.set(key, proxy);
    return proxy;
  }

  private subscribe(service: RuntimeKey, event: string | symbol, listener: RuntimeEventListener): void {
    if (typeof listener !== 'function') throw new TypeError('Runtime event listener must be a function');
    if (this.subscriptions.some(item => item.service === service && item.event === event && item.listener === listener)) return;
    const subscription: RuntimeSubscription = {
      service,
      event,
      listener,
      wrapper: () => undefined,
    };
    this.subscriptions.push(subscription);
    this.addTo(this.current, subscription);
  }

  private addTo(runtime: ProfileRuntime, subscription: RuntimeSubscription): void {
    const target = runtime[subscription.service] as { on?: (event: string | symbol, listener: RuntimeEventListener) => unknown };
    if (typeof target?.on !== 'function') return;
    const owner = runtime;
    const wrapper = (...args: unknown[]) => {
      if (this.current === owner) subscription.listener(...args);
    };
    subscription.wrapper = wrapper;
    target.on(subscription.event, wrapper);
  }

  private removeFrom(runtime: ProfileRuntime, subscription: RuntimeSubscription): void {
    const target = runtime[subscription.service] as { off?: (event: string | symbol, listener: RuntimeEventListener) => unknown };
    target?.off?.(subscription.event, subscription.wrapper);
  }

  private unsubscribe(service: RuntimeKey, event: string | symbol, listener: RuntimeEventListener): void {
    for (let index = this.subscriptions.length - 1; index >= 0; index -= 1) {
      const item = this.subscriptions[index];
      if (item.service !== service || item.event !== event || item.listener !== listener) continue;
      this.removeFrom(this.current, item);
      this.subscriptions.splice(index, 1);
    }
  }
}

/** Forward a stable dependency to whichever profile-owned service is active. */
export function createActiveServiceProxy<T extends object>(getCurrent: () => T): T {
  return new Proxy(Object.create(null) as T, {
    get: (_target, property) => {
      const target = getCurrent();
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set: (_target, property, value) => {
      const target = getCurrent();
      return Reflect.set(target, property, value, target);
    },
    has: (_target, property) => property in getCurrent(),
    ownKeys: () => Reflect.ownKeys(getCurrent()),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(getCurrent(), property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}
