/**
 * create-lionden — Interactive scaffolder for LionDen projects.
 *
 * Usage:
 *   npm create lionden my-project
 *   npm create lionden               # prompts for name
 *   npm create lionden my-project --template token
 */

import { resolve } from "node:path";
import { TEMPLATES, getTemplate, getTemplateIds } from "./templates.js";
import { scaffold } from "./scaffold.js";
import { ask, choose, closeReadline } from "./prompt.js";

export { scaffold, type ScaffoldOptions, type ScaffoldResult } from "./scaffold.js";
export { TEMPLATES, getTemplate, getTemplateIds } from "./templates.js";

function parseArgs(argv: string[]): { projectName?: string; template?: string } {
  let projectName: string | undefined;
  let template: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--template" || arg === "-t") {
      template = argv[++i];
    } else if (!arg.startsWith("-")) {
      projectName = arg;
    }
  }

  return { projectName, template };
}

export async function main(argv: string[]): Promise<void> {
  console.log("\n  create-lionden — scaffold a new LionDen project\n");

  const parsed = parseArgs(argv);
  let projectName = parsed.projectName;
  let templateId = parsed.template;

  try {
    // Prompt for project name if not provided
    if (!projectName) {
      projectName = await ask("Project name", "my-lionden-project");
    }

    if (!projectName) {
      throw new Error("Project name is required.");
    }

    // Prompt for template if not provided
    if (!templateId) {
      const ids = getTemplateIds();
      const descriptions = TEMPLATES.map((t) => `${t.id} — ${t.description}`);
      const selected = await choose("Select a template:", descriptions);
      templateId = ids[descriptions.indexOf(selected)] ?? ids[0]!;
    }

    const template = getTemplate(templateId);
    if (!template) {
      const valid = getTemplateIds().join(", ");
      throw new Error(`Unknown template "${templateId}". Available: ${valid}`);
    }

    const projectDir = resolve(process.cwd(), projectName);

    console.log(`\n  Creating ${projectName} with template "${template.id}"...\n`);

    const result = await scaffold({
      projectDir,
      projectName,
      template,
    });

    console.log(`  Created ${result.filesCreated} files in ${result.projectDir}\n`);
    console.log("  Next steps:\n");
    console.log(`    cd ${projectName}`);
    console.log("    npm install --ignore-scripts");
    console.log("    npx lionden compile");
    console.log("    npx lionden test");
    console.log("");
  } finally {
    closeReadline();
  }
}
