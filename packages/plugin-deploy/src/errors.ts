/**
 * Shared error classes for the deploy plugin.
 */

export class DeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployError";
  }
}
