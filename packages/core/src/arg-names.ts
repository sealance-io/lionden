/** Convert camelCase to kebab-case (e.g., "noCompile" -> "no-compile"). */
export function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}
