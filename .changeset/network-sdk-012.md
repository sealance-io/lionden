---
"@lionden/network": patch
---

Raise the minimum `@provablehq/sdk` version to `0.12.1`, which includes snarkVM 4.11.0 and Varuna V3 support. If you call the SDK's `snarkVerify` or `snarkVerifyBatch` directly, regenerate stored Varuna V2 proofs before verifying them with this version.
