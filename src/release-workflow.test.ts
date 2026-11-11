import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guard for the release workflow's token split: the build job runs tagged code
// with a read-only token, and the publish job holds the write token without
// checking out source or running any install, build or test step. A future
// change that merges the jobs or adds a build step to publish must fail here
// first, while the diff is still small.
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

function jobBlock(name: string): string {
  const startMarker = `\n  ${name}:`;
  const start = workflow.indexOf(startMarker);
  expect(start, `job ${name} must exist`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + startMarker.length);
  const next = rest.search(/\n  [a-z][\w-]*:\s*\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

const build = jobBlock("build");
const publish = jobBlock("publish");

describe("release workflow token split", () => {
  it("runs the build job with a read-only token and no write permission", () => {
    expect(build).toContain("contents: read");
    expect(build).not.toContain("contents: write");
  });

  it("runs the publish job with the write token and depends on the build job", () => {
    expect(publish).toContain("contents: write");
    expect(publish).toContain("needs: [build]");
  });

  it("runs no tagged code in the publish job", () => {
    expect(publish).not.toContain("actions/checkout@");
    expect(publish).not.toContain("actions/setup-node@");
    expect(publish).not.toContain("scripts/stage-package.sh");
    expect(publish).not.toContain("scripts/check-");
    expect(publish).not.toContain("scripts/release-notes.sh");
    expect(publish).not.toContain("npm ci");
    expect(publish).not.toContain("npm run");
    expect(publish).not.toContain("git rev-parse");
  });

  it("hands the assets from build to publish as an artifact and verifies the digest", () => {
    expect(build).toContain("actions/upload-artifact@");
    expect(publish).toContain("actions/download-artifact@");
    expect(publish).toContain("sha256sum -c");
  });

  it("publishes only the tarball and its checksum, not the notes", () => {
    expect(publish).toContain("gh release create");
    expect(publish).toContain("*.tgz.sha256");
    expect(publish).toContain('"$TAG"');
    // The notes travel with the artifact but are named as the release notes,
    // never attached as a downloadable asset. The publish upload lists the
    // tarball and checksum explicitly, not the whole assets directory.
    expect(publish).toContain("--notes-file");
    expect(publish).not.toContain("assets/* ");
  });
});
