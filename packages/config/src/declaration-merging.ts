/**
 * Module augmentation interfaces for plugins to extend LionDen config types.
 *
 * Plugins add custom config fields by augmenting these interfaces:
 *
 * @example
 * ```ts
 * // my-plugin/type-extensions.ts
 * declare module "@lionden/config" {
 *   interface LionDenUserConfigExtensions {
 *     myPlugin?: { foo: string };
 *   }
 *   interface LionDenResolvedConfigExtensions {
 *     myPlugin: { foo: string };
 *   }
 * }
 * ```
 */

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type LionDenUserConfigExtensions = {};

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type LionDenResolvedConfigExtensions = {};
