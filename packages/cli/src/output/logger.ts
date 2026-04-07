export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private level: number;

  constructor(level: LogLevel = "info") {
    this.level = LOG_LEVELS[level];
  }

  setLevel(level: LogLevel): void {
    this.level = LOG_LEVELS[level];
  }

  debug(...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.debug) {
      console.debug("\x1b[90m[debug]\x1b[0m", ...args);
    }
  }

  info(...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.info) {
      console.log(...args);
    }
  }

  warn(...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.warn) {
      console.warn("\x1b[33m⚠\x1b[0m", ...args);
    }
  }

  error(...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.error) {
      console.error("\x1b[31m✗\x1b[0m", ...args);
    }
  }

  success(...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.info) {
      console.log("\x1b[32m✓\x1b[0m", ...args);
    }
  }
}

export const logger = new Logger();
