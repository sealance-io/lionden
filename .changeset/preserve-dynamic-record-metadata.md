---
"@lionden/leo-compiler": patch
---

Preserve the original decrypted record plaintext in generated dynamic-record helpers, including runtime version metadata absent from the ABI. This prevents held-record routing from reconstructing the wrong ledger commitment during proving. Manually constructed inputs continue to use schema encoding and validation. Regenerate existing bindings to pick up the fix.
