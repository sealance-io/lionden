import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRemoteTagTarget,
  reconcileReleaseTags,
  releaseTag,
} from "./reconcile-release-tags.mjs";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const dir = mkdtempSync(join(tmpdir(), "release-tags-"));
const repo = join(dir, "repo");
const remote = join(dir, "remote.git");

try {
  mkdirSync(join(repo, ".changeset"), { recursive: true });
  mkdirSync(join(repo, "packages", "public-package"), { recursive: true });
  mkdirSync(join(repo, "packages", "private-package"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  );
  writeFileSync(
    join(repo, "packages", "public-package", "package.json"),
    JSON.stringify({ name: "@scope/public-package", version: "1.0.0" }),
  );
  writeFileSync(
    join(repo, "packages", "private-package", "package.json"),
    JSON.stringify({ name: "private-package", version: "1.0.0", private: true }),
  );
  writeFileSync(
    join(repo, ".changeset", "config.json"),
    JSON.stringify({ fixed: [["@scope/public-package"]] }),
  );

  git(repo, ["init"]);
  git(repo, ["config", "user.email", "release-test@example.com"]);
  git(repo, ["config", "user.name", "Release Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "release"]);
  git(dir, ["init", "--bare", remote]);
  git(repo, ["remote", "add", "origin", remote]);

  const gitHead = git(repo, ["rev-parse", "HEAD"]);
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        name: "@scope/public-package",
        versions: {
          "0.9.0": { name: "@scope/public-package", version: "0.9.0", gitHead },
          "1.0.0": { name: "@scope/public-package", version: "1.0.0", gitHead },
        },
      }),
      { status: 200 },
    );
  const outputPath = join(dir, "release-tags.txt");

  const tags = await reconcileReleaseTags({ rootDir: repo, outputPath, push: true, fetchImpl });
  assert.deepEqual(tags, ["@scope/public-package@0.9.0", "@scope/public-package@1.0.0"]);
  assert.equal(
    readFileSync(outputPath, "utf8"),
    "@scope/public-package@0.9.0\n@scope/public-package@1.0.0\n",
  );
  assert.equal(
    git(repo, ["ls-remote", "--tags", "origin", "refs/tags/@scope/public-package@1.0.0"]),
    `${gitHead}\trefs/tags/@scope/public-package@1.0.0`,
  );

  await reconcileReleaseTags({ rootDir: repo, push: false, fetchImpl });

  writeFileSync(join(repo, "README.md"), "later commit\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "later"]);
  const laterGitHead = git(repo, ["rev-parse", "HEAD"]);
  const laterFetch = async () =>
    new Response(
      JSON.stringify({
        name: "@scope/public-package",
        versions: {
          "0.9.0": { name: "@scope/public-package", version: "0.9.0", gitHead },
          "1.0.0": {
            name: "@scope/public-package",
            version: "1.0.0",
            gitHead: laterGitHead,
          },
        },
      }),
      { status: 200 },
    );
  await assert.rejects(
    reconcileReleaseTags({ rootDir: repo, push: true, fetchImpl: laterFetch }),
    /Remote tag .* but npm records/,
  );

  assert.equal(releaseTag({ name: "@scope/pkg", version: "2.3.4" }), "@scope/pkg@2.3.4");
  assert.equal(
    parseRemoteTagTarget(
      `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/pkg@1.0.0\n` +
        `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/pkg@1.0.0^{}`,
      "pkg@1.0.0",
    ),
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );

  console.log("Release tag reconciliation tests passed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
