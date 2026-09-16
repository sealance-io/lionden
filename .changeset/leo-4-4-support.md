---
"@lionden/config": minor
"@lionden/leo-compiler": minor
"@lionden/plugin-deploy": minor
"@lionden/plugin-leo": minor
"@lionden/plugin-network": minor
"create-lionden": minor
---

Add Leo 4.4.2 support and make it the default compatibility line. Generated projects and maintained examples now use the 4.4 metadata APIs, while the Leo deploy backend accepts verified 4.4.x binaries alongside 4.3.x. Existing projects can remain on supported earlier Leo lines by setting `leoVersion` (and, where needed, `leoBinary`) explicitly.
