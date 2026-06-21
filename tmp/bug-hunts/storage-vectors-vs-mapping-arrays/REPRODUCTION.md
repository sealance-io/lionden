# Storage Vector vs Mapping Array Probe

This is a disposable peer-review note for the local probe at:

```text
tmp/bug-hunts/storage-vectors-vs-mapping-arrays/
```

The probe confirms a real LionDen bug in generated storage vector accessors. It also confirms fixed-size mapping arrays are a separate, working path.

## What This Reproduces

The positive probe program declares:

```leo
storage admin: address;
storage field_history: [field];
mapping fixed_rows: bool => [u8; 3];
```

After deployment and seeding:

- Leo can read `field_history.get(index).unwrap()` on-chain.
- Raw devnode state contains lowered vector storage:
  - `field_history__len__["false"] == 2u32`
  - `field_history__["0u32"] == 101field`
  - `field_history__["1u32"] == 202field`
- Generated singleton storage accessor works:
  - `contract.storage.admin.get()`
- Generated vector storage accessor misses the lowered vector entries:
  - `contract.storage.fieldHistory.tryGet()` returns `null`
  - `contract.storage.fieldHistory.get()` throws `StorageValueNotFoundError`
- Generated fixed mapping array accessor works:
  - `contract.mappings.fixedRows.get(true)` returns `[1, 2, 3]`

The negative probe declares:

```leo
mapping dynamic_rows: bool => [field];
```

Real Leo rejects it with:

```text
ETYC0372189: vector types can only be used in storage declarations
```

That proves mapping values do not use `StorageType.Vector`; fixed-size mapping arrays are ABI `Plaintext.Array` values.

## Relevant Probe Files

```text
tmp/bug-hunts/storage-vectors-vs-mapping-arrays/lionden.config.ts
tmp/bug-hunts/storage-vectors-vs-mapping-arrays/tsconfig.json
tmp/bug-hunts/storage-vectors-vs-mapping-arrays/programs/storage_vector_probe/main.leo
tmp/bug-hunts/storage-vectors-vs-mapping-arrays/test/storage-vectors-vs-mapping-arrays.test.ts
tmp/bug-hunts/storage-vectors-vs-mapping-arrays/scripts/deploy.ts
tmp/bug-hunts/storage-vectors-vs-mapping-arrays/dynamic-mapping-vector/lionden.config.ts
tmp/bug-hunts/storage-vectors-vs-mapping-arrays/dynamic-mapping-vector/programs/dynamic_mapping_vector/main.leo
```

Generated evidence after compile:

```text
tmp/bug-hunts/storage-vectors-vs-mapping-arrays/artifacts/storage_vector_probe.aleo/abi.json
tmp/bug-hunts/storage-vectors-vs-mapping-arrays/typechain/StorageVectorProbe.ts
```

## Reproduction Commands

Run from the repository root.

Build current package output first:

```bash
npm run build
```

Compile the positive probe:

```bash
PROBE=tmp/bug-hunts/storage-vectors-vs-mapping-arrays
node --import tsx packages/cli/src/bin.ts --config "$PROBE/lionden.config.ts" compile
```

Typecheck generated bindings and probe code. If `npx` is not on `PATH`, load the repo Node version first:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use
PROBE=tmp/bug-hunts/storage-vectors-vs-mapping-arrays
npx tsc -p "$PROBE/tsconfig.json" --noEmit
```

Compile the negative dynamic mapping-vector probe. This command is expected to fail:

```bash
NEG=tmp/bug-hunts/storage-vectors-vs-mapping-arrays/dynamic-mapping-vector
node --import tsx packages/cli/src/bin.ts --config "$NEG/lionden.config.ts" compile
```

Expected failure excerpt:

```text
vector types can only be used in storage declarations
```

Run the positive runtime probe with a manual devnode:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use
set -euo pipefail

PROBE="tmp/bug-hunts/storage-vectors-vs-mapping-arrays"
CONFIG="$PROBE/lionden.config.ts"
HEALTH_URL="http://127.0.0.1:3030/testnet/block/height/latest"
DEVNODE_PID=""

wait_for_health() {
  for _ in $(seq 1 150); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "devnode did not become healthy: $HEALTH_URL" >&2
  return 1
}

wait_for_down() {
  for _ in $(seq 1 50); do
    if ! curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
}

start_devnode() {
  node --import tsx packages/cli/src/bin.ts --config "$CONFIG" node &
  DEVNODE_PID=$!
  wait_for_health
}

stop_devnode() {
  if [ -n "$DEVNODE_PID" ] && kill -0 "$DEVNODE_PID" 2>/dev/null; then
    kill "$DEVNODE_PID"
    wait "$DEVNODE_PID" 2>/dev/null || true
  fi
  DEVNODE_PID=""
  wait_for_down || true
}

cleanup() {
  stop_devnode
}
trap cleanup EXIT

start_devnode
node --import tsx packages/cli/src/bin.ts --config "$CONFIG" compile
npx tsc -p "$PROBE/tsconfig.json" --noEmit
node --import tsx packages/cli/src/bin.ts --config "$CONFIG" test --no-compile
stop_devnode

start_devnode
node --import tsx packages/cli/src/bin.ts --config "$CONFIG" run scripts/deploy.ts
stop_devnode
```

On sandboxed agent runs, starting the devnode may require permission to bind `127.0.0.1:3030`.

## Expected Runtime Evidence

The Vitest probe should pass. The most important assertions are in:

```text
tmp/bug-hunts/storage-vectors-vs-mapping-arrays/test/storage-vectors-vs-mapping-arrays.test.ts
```

Expected raw storage checks:

```ts
network.getMappingValue(PROGRAM_ID, "admin__", "false") === admin;
network.getMappingValue(PROGRAM_ID, "field_history__len__", "false") === "2u32";
network.getMappingValue(PROGRAM_ID, "field_history__", "0u32") === "101field";
network.getMappingValue(PROGRAM_ID, "field_history__", "1u32") === "202field";
```

Expected generated accessor checks:

```ts
await contract.storage.admin.get(); // succeeds
await contract.storage.fieldHistory.tryGet(); // returns null
await contract.storage.fieldHistory.get(); // throws StorageValueNotFoundError
await contract.mappings.fixedRows.get(true); // returns [1, 2, 3]
```

The deploy script should print:

```text
[script] fixed_rows[true] = [1,2,3]
[script] field_history length = 2u32
[script] field_history[0] = 101field
```

## Bug Pinpoint

The generated vector accessor assumes `queryStorage("field_history")` returns one array literal string:

```ts
const _result = await this.queryStorage("field_history");
return BaseContract.parseArray(_result).map((e: string) => BaseContract.parseField(e));
```

But the current network storage path treats every storage variable like a singleton and queries:

```ts
const storageMappingName = `${variableName}__`;
nc.getProgramMappingValue(programId, storageMappingName, "false");
```

That is correct for singleton storage such as `admin`, which is lowered to:

```text
admin__["false"]
```

It is incorrect for vector storage. Leo lowers `field_history: [field]` to:

```text
field_history__len__["false"]
field_history__["0u32"]
field_history__["1u32"]
```

So `queryStorage("field_history")` asks for:

```text
field_history__["false"]
```

That entry does not exist. The generated `tryGet()` returns `null`, and `get()` throws even though the vector exists and Leo can read it.

## Current Conclusion

Confirmed bug:

```text
Generated storage vector accessors cannot read real Leo lowered vector storage.
```

Not a bug in this probe:

```text
Fixed-size mapping array accessors work.
Dynamic mapping vectors are rejected by Leo and do not produce MappingABI.value Vector shapes.
```

Likely owning area:

```text
packages/leo-compiler/src/codegen/typescript-generator.ts
packages/network/src/connection.ts
packages/network/src/types.ts
```

The fix likely needs a vector-aware storage query contract, not only a deserializer change.
