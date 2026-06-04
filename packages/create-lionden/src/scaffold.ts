/**
 * Project scaffolding — writes template files to disk.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sharedFiles, type Template } from "./templates.js";

export interface ScaffoldOptions {
  /** Project directory (absolute or relative to cwd) */
  projectDir: string;
  /** Project name (used in package.json) */
  projectName: string;
  /** Template to use */
  template: Template;
}

export interface ScaffoldResult {
  /** Absolute path to the created project */
  projectDir: string;
  /** Number of files created */
  filesCreated: number;
}

/**
 * Scaffold a new LionDen project from a template.
 * Creates the project directory and writes all template files.
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { projectDir, projectName, template } = options;

  if (existsSync(projectDir)) {
    const entries = (await import("node:fs")).readdirSync(projectDir);
    if (entries.length > 0) {
      throw new Error(`Directory "${projectDir}" already exists and is not empty.`);
    }
  }

  await mkdir(projectDir, { recursive: true });

  // Collect all files: shared + template-specific
  const allFiles = [...sharedFiles(projectName), ...template.files];

  let filesCreated = 0;
  for (const file of allFiles) {
    const filePath = join(projectDir, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, "utf-8");
    filesCreated++;
  }

  return { projectDir, filesCreated };
}
