---
"@lionden/network": patch
"@lionden/cli": patch
---

Raise the minimum `@provablehq/sdk` version to `0.11.11` and the CLI's `tsx` version to `4.23.15`.

The SDK update includes snarkVM 4.10.0 consensus support and authentication fixes. LionDen continues to supply explicit network endpoints and authorization headers. Consumers using the SDK directly should account for its new default gateway (`https://edge.provable.com/api`), lone-API-key authentication via `X-API-Key`, and the requirement for 21 entries when supplying explicit consensus test heights. LionDen initializes SDK consensus test heights without an explicit list. The SDK also rejects arbitrary signing of request-shaped messages.
