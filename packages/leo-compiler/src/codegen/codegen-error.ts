/**
 * Codegen-stage error. Thrown by typechain emit and helper routing when the
 * resolved config or ABI shape rules out a clean emission. Distinct from
 * `CompilationError` (which represents Leo CLI failures).
 */
export class CodegenError extends Error {
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "CodegenError";
    this.context = context;
  }
}
