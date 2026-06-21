import type { LionDenRuntimeEnvironment } from "@lionden/core";
import type { NetworkManager } from "@lionden/network";
import { createStorageVectorProbe } from "../typechain/index.js";
import { Leo } from "../typechain/BaseContract.js";

export default async function (lre: LionDenRuntimeEnvironment) {
  await lre.tasks.run("compile");
  await lre.tasks.run("deploy", { program: "storage_vector_probe" });

  const contract = createStorageVectorProbe().connect(lre);
  const network = lre.network as NetworkManager;
  const accounts = network.getAccounts();
  const first = Leo.field(101);
  const second = Leo.field(202);

  await contract.seed.accepted({
    owner: Leo.address(accounts[0]!.address),
    first,
    second,
  });

  const fixed = await contract.mappings.fixedRows.get(true);
  const rawLength = await network.getMappingValue(
    "storage_vector_probe.aleo",
    "field_history__len__",
    "false",
  );
  const rawFirst = await network.getMappingValue(
    "storage_vector_probe.aleo",
    "field_history__",
    "0u32",
  );

  console.log(`[script] fixed_rows[true] = ${JSON.stringify(fixed)}`);
  console.log(`[script] field_history length = ${rawLength}`);
  console.log(`[script] field_history[0] = ${rawFirst}`);
}
