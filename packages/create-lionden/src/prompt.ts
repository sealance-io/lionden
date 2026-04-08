/**
 * Simple interactive prompts using Node.js readline.
 * No external dependencies needed.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";

let rl: ReadlineInterface | null = null;

function getReadline(): ReadlineInterface {
  if (!rl) {
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

export function closeReadline(): void {
  rl?.close();
  rl = null;
}

export function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    getReadline().question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export function choose(question: string, choices: string[], defaultIndex = 0): Promise<string> {
  const lines = choices.map((c, i) =>
    `  ${i === defaultIndex ? ">" : " "} ${i + 1}. ${c}`
  );
  const prompt = `${question}\n${lines.join("\n")}\n\nChoice (1-${choices.length}) [${defaultIndex + 1}]: `;

  return new Promise((resolve) => {
    getReadline().question(prompt, (answer) => {
      const num = parseInt(answer.trim(), 10);
      if (num >= 1 && num <= choices.length) {
        resolve(choices[num - 1]!);
      } else {
        resolve(choices[defaultIndex]!);
      }
    });
  });
}
