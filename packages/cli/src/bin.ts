#!/usr/bin/env -S node --import tsx

import { main } from "./index.js";

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
