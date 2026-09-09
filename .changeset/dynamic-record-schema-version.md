---
"@lionden/leo-compiler": minor
---

Allow `codegen.dynamicRecords.*.schema` to declare optional `_version: "u8.public"` metadata so manually constructed dynamic-record inputs (JSON-rehydrated, spread copies, hand-built objects) can carry the on-chain record version. `_version` is optional on the value: omitting it still emits a versionless literal (version 0). Decrypted records keep replaying their cached plaintext. Generated helpers now emit the schema literal in the canonical record order (`owner`, ABI fields, `_nonce`, `_version`) regardless of the key order in the config; configs whose order differed previously produced literals the VM rejected. Regenerate existing bindings to pick up the change.
