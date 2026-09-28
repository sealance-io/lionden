---
"@lionden/network": patch
---

SDK initialization and devnode-support errors no longer quote a stale hard-coded `@provablehq/sdk` version range; they now refer to the SDK requirement declared by `@lionden/network`. A missing devnode builder is still reported by method name.
