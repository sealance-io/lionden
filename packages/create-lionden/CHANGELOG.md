# create-lionden

## 0.4.0

### Minor Changes

- [#106](https://github.com/sealance-io/lionden/pull/106) [`be7b450`](https://github.com/sealance-io/lionden/commit/be7b4507697e52456aec370846beba4eb489854e) Thanks [@NadavPeled1998](https://github.com/NadavPeled1998)! - Add Leo 4.4.2 support and make it the default compatibility line. Generated projects and maintained examples now use the 4.4 metadata APIs, while the Leo deploy backend accepts verified 4.4.x binaries alongside 4.3.x. Existing projects can remain on supported earlier Leo lines by setting `leoVersion` (and, where needed, `leoBinary`) explicitly.

## 0.3.0

### Minor Changes

- [#104](https://github.com/sealance-io/lionden/pull/104) [`5a3a427`](https://github.com/sealance-io/lionden/commit/5a3a42778226eb074d238ad20e38ff2135d81a9b) Thanks [@fullkomnun](https://github.com/fullkomnun)! - Recover from the partial LionDen 0.2 publication with a coordinated 0.3.0 release of all 11 public
  packages.

## 0.1.1

### Patch Changes

- [#76](https://github.com/sealance-io/lionden/pull/76) [`b4a8b28`](https://github.com/sealance-io/lionden/commit/b4a8b28a9ba7d35b1d238313028af5c83321228c) Thanks [@fullkomnun](https://github.com/fullkomnun)! - First release through the automated OIDC trusted-publishing pipeline; ships provenance
  attestations. No functional changes.
