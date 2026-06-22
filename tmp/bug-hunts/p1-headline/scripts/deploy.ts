import type { LionDenRuntimeEnvironment } from "@lionden/core";

import { createConsumer } from "../typechain/Consumer.js";
import { createTokenRegistry } from "../typechain/TokenRegistry.js";

export default async function (lre: LionDenRuntimeEnvironment) {
  await lre.tasks.run("compile");
  await lre.tasks.run("deploy", { program: "registry" });
  await lre.tasks.run("deploy", { program: "token_registry" });
  await lre.tasks.run("deploy", { program: "consumer" });

  const consumer = createConsumer().connect(lre);
  const tokenRegistry = createTokenRegistry().connect(lre);

  const admin = { address: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px" };
  const info = await consumer.relay.locally({ info: { supply: 4242n, admin } });
  if (info.supply !== 4242n) throw new Error(`struct round-trip failed: ${info.supply}`);
  console.log("[deploy.ts] struct round-trip ok:", info.supply, String(info.admin));

  const tok = await tokenRegistry.mint.locally({ amount: 9n });
  const fwd = await consumer.forward.locally({ t: tok });
  if (fwd.amount !== 9n) throw new Error(`record round-trip failed: ${fwd.amount}`);
  console.log("[deploy.ts] record round-trip ok:", fwd.amount);
}
