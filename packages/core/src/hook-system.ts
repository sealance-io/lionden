import type { HookCategory, HookDispatcher, HookHandlerMap, LionDenPlugin } from "./types.js";

type AnyHandlerMap = HookHandlerMap[HookCategory];
type HandlerFn = (...args: unknown[]) => unknown;

/**
 * The hook dispatcher manages all hook registrations and executions.
 * Hook handlers are lazy-loaded by category on first invocation.
 */
export class HookDispatcherImpl implements HookDispatcher {
  /**
   * category -> plugin ID -> resolved handlers (or a factory for lazy loading)
   */
  private readonly registry = new Map<
    HookCategory,
    Array<{
      pluginId: string;
      handlers: AnyHandlerMap | null;
      factory: (() => Promise<AnyHandlerMap>) | null;
    }>
  >();

  /** Track which categories have been fully resolved */
  private readonly resolved = new Set<HookCategory>();

  /**
   * Track in-flight category resolution so concurrent dispatches share work.
   * A factory must not dispatch its own category while resolving — that would
   * await the very promise it is inside and deadlock.
   */
  private readonly resolving = new Map<HookCategory, Promise<void>>();

  /**
   * Register all hook handlers from a list of plugins (already in load order).
   */
  registerPlugins(plugins: readonly LionDenPlugin[]): void {
    for (const plugin of plugins) {
      if (!plugin.hookHandlers) continue;

      for (const [category, handlerOrFactory] of Object.entries(plugin.hookHandlers) as Array<
        [HookCategory, unknown]
      >) {
        if (!handlerOrFactory) continue;

        let entries = this.registry.get(category);
        if (!entries) {
          entries = [];
          this.registry.set(category, entries);
        }

        if (typeof handlerOrFactory === "function") {
          // Lazy-loaded — factory function
          entries.push({
            pluginId: plugin.id,
            handlers: null,
            factory: handlerOrFactory as () => Promise<AnyHandlerMap>,
          });
        } else {
          // Eager — direct handler object
          entries.push({
            pluginId: plugin.id,
            handlers: handlerOrFactory as AnyHandlerMap,
            factory: null,
          });
        }
      }
    }
  }

  /**
   * Ensure all handlers for a category are resolved (lazy factories called).
   */
  private async resolveCategory(category: HookCategory): Promise<void> {
    if (this.resolved.has(category)) return;

    const existing = this.resolving.get(category);
    if (existing) {
      await existing;
      return;
    }

    const resolution = (async () => {
      const entries = this.registry.get(category);
      if (!entries) {
        this.resolved.add(category);
        return;
      }

      for (const entry of entries) {
        if (entry.handlers === null && entry.factory !== null) {
          entry.handlers = await entry.factory();
          entry.factory = null;
        }
      }

      this.resolved.add(category);
    })();

    this.resolving.set(category, resolution);

    try {
      await resolution;
    } finally {
      this.resolving.delete(category);
    }
  }

  /**
   * Get all resolved handler functions for a specific hook point,
   * in plugin dependency order.
   */
  private async getHandlers(category: HookCategory, hookName: string): Promise<HandlerFn[]> {
    await this.resolveCategory(category);

    const entries = this.registry.get(category) ?? [];
    const handlers: HandlerFn[] = [];

    for (const entry of entries) {
      if (entry.handlers) {
        const fn = (entry.handlers as Record<string, HandlerFn | undefined>)[hookName];
        if (typeof fn === "function") {
          handlers.push(fn);
        }
      }
    }

    return handlers;
  }

  /**
   * Serial dispatch: handlers execute sequentially in plugin order.
   * Each receives the context; return values are ignored.
   */
  async serial<TContext>(
    category: HookCategory,
    hookName: string,
    context: TContext,
  ): Promise<void> {
    const handlers = await this.getHandlers(category, hookName);
    for (const handler of handlers) {
      await handler(context);
    }
  }

  /**
   * Waterfall dispatch: each handler receives the previous handler's return
   * value. The final value is returned.
   */
  async waterfall<TValue>(
    category: HookCategory,
    hookName: string,
    initialValue: TValue,
    ...extraArgs: unknown[]
  ): Promise<TValue> {
    const handlers = await this.getHandlers(category, hookName);
    let value = initialValue;
    for (const handler of handlers) {
      const result = await handler(value, ...extraArgs);
      if (result !== undefined) {
        value = result as TValue;
      }
    }
    return value;
  }

  /**
   * Parallel dispatch: all handlers execute concurrently.
   * Return values are ignored. Errors from any handler propagate.
   */
  async parallel<TContext>(
    category: HookCategory,
    hookName: string,
    context: TContext,
  ): Promise<void> {
    const handlers = await this.getHandlers(category, hookName);
    await Promise.all(handlers.map((h) => h(context)));
  }
}
