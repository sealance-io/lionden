const LOG_COLOR_CODES = {
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
} as const;

const LOG_COLOR_RESET = "\x1b[0m";

type LogColor = keyof typeof LOG_COLOR_CODES;
export type LogStyleRole = "action" | "success" | "warning" | "error" | "metadata" | "divider";

interface LogProcessLike {
  readonly env?: Record<string, string | undefined>;
  readonly stdout?: { readonly isTTY?: boolean };
}

function logProcess(): LogProcessLike | undefined {
  return (globalThis as typeof globalThis & { readonly process?: LogProcessLike }).process;
}

function logEnv(name: string): string | undefined {
  return logProcess()?.env?.[name];
}

export function shouldColorLogs(): boolean {
  if (logEnv("NO_COLOR") !== undefined) return false;
  const forceColor = logEnv("FORCE_COLOR");
  if (forceColor !== undefined && forceColor !== "0") return true;
  return logProcess()?.stdout?.isTTY === true;
}

export function shouldRenderDivider(): boolean {
  return !logEnv("VITEST") && !logEnv("LIONDEN_MANAGED_TEST");
}

export function colorLogText(text: string, color: LogColor): string {
  if (!shouldColorLogs()) return text;
  return LOG_COLOR_CODES[color] + text + LOG_COLOR_RESET;
}

export function styleLogRole(text: string, role: LogStyleRole): string {
  switch (role) {
    case "action":
      return colorLogText(text, "cyan");
    case "success":
      return colorLogText(text, "green");
    case "warning":
      return colorLogText(text, "yellow");
    case "error":
      return colorLogText(text, "red");
    case "metadata":
    case "divider":
      return colorLogText(text, "dim");
  }
}

export function logAction(text: string): string {
  return styleLogRole(text, "action");
}

export function logSuccess(text: string): string {
  return styleLogRole(text, "success");
}

export function logWarning(text: string): string {
  return styleLogRole(text, "warning");
}

export function logError(text: string): string {
  return styleLogRole(text, "error");
}

export function logMetadata(text: string): string {
  return styleLogRole(text, "metadata");
}

export function logDivider(text = "----------------------------------------"): string {
  return styleLogRole(text, "divider");
}

export function pluralize(word: string, count: number): string {
  return count === 1 ? word : word + "s";
}
