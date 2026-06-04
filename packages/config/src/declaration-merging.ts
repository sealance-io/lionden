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

// Declared as interfaces (not type aliases) so plugins can merge fields into them
// via `declare module "@lionden/config"`. Interface declaration merging does not
// work on type aliases. These are wired into LionDenUserConfig / LionDenResolvedConfig
// in types.ts, so augmented fields surface on the resolved config types.
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target — must stay an interface (a type alias cannot be module-augmented) and starts empty
export interface LionDenUserConfigExtensions {}

// biome-ignore lint/suspicious/noEmptyInterface: augmentation target — must stay an interface (a type alias cannot be module-augmented) and starts empty
export interface LionDenResolvedConfigExtensions {}
