import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Guard for the release workflow's token split: the build job runs tagged code
// with a read-only token, and the publish job holds the write token without
// checking out source or running any install, build or test step. A future
// change that merges the jobs or adds a build step to publish must fail here
// first, while the diff is still small.
//
// The workflow is parsed as YAML, never matched as raw substrings, so a
// required command that survives only in a comment (`# sha256sum -c ...`,
// `# needs: [build]`) is not evidence of anything: commented-out lines do
// not appear in the parsed permissions, needs, steps or run scripts below.
// Mutation cases at the bottom prove each of those shapes fails the guard.
const workflowText = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

type Step = {
  name?: unknown;
  uses?: unknown;
  run?: unknown;
  with?: Record<string, unknown>;
};
type Job = {
  permissions?: unknown;
  needs?: unknown;
  steps?: unknown;
};
type WorkflowDoc = {
  permissions?: unknown;
  jobs?: Record<string, Job>;
};

function parseWorkflow(text: string): WorkflowDoc {
  const doc = parse(text) as WorkflowDoc;
  expect(doc, "workflow must parse as a YAML mapping").not.toBeNull();
  expect(typeof doc, "workflow must parse as a YAML mapping").toBe("object");
  expect(doc.jobs, "workflow must declare jobs").toBeDefined();
  return doc;
}

function stepsOf(job: Job | undefined): Step[] {
  expect(job, "job must exist").toBeDefined();
  const steps = job!.steps;
  expect(Array.isArray(steps), "job must declare steps as a list").toBe(true);
  return steps as Step[];
}

function permissionsOf(scope: { permissions?: unknown } | undefined): Record<string, string> {
  const permissions = scope?.permissions;
  expect(permissions, "permissions must be a mapping").toBeTypeOf("object");
  return permissions as Record<string, string>;
}

function needsOf(job: Job | undefined): string[] {
  const needs = job?.needs;
  if (typeof needs === "string") return [needs];
  if (Array.isArray(needs)) return needs.map(String);
  return [];
}

function runScripts(steps: Step[]): string[] {
  return steps.filter((s) => typeof s.run === "string").map((s) => s.run as string);
}

// Lines that actually execute: inside a YAML block scalar a `#` line is a
// shell comment, not YAML, so it must not count as a required command nor
// as banned tagged code.
function executable(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const PINNED = /^[\w./-]+@[0-9a-f]{40}$/;

// Every token-split / verify / publish invariant, as a list of violations so
// the mutation cases can reuse the exact same guard on mutated workflows.
// An empty list means the workflow passes the guard.
function guardViolations(doc: WorkflowDoc): string[] {
  const violations: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) violations.push(message);
  };

  const build = doc.jobs?.build;
  const publish = doc.jobs?.publish;
  check(build !== undefined, "build job must exist");
  check(publish !== undefined, "publish job must exist");
  if (!build || !publish) return violations;

  check(permissionsOf(doc).contents === "read", "top-level permissions must be contents: read");
  check(permissionsOf(build).contents === "read", "build permissions must be contents: read");
  check(!Object.values(permissionsOf(build)).includes("write"), "build must hold no write permission");
  check(permissionsOf(publish).contents === "write", "publish permissions must be contents: write");
  check(needsOf(publish).includes("build"), "publish must depend on build via needs");

  const buildSteps = stepsOf(build);
  const publishSteps = stepsOf(publish);

  for (const [label, steps] of [["build", buildSteps], ["publish", publishSteps]] as const) {
    for (const step of steps) {
      if (typeof step.uses === "string") {
        check(PINNED.test(step.uses), `${label} action must be pinned to a full SHA: ${step.uses}`);
      }
    }
  }

  // The publish job may download the build artifact and nothing else: any
  // other action (checkout, setup-node, ...) executes tagged code or
  // restores state while the write token is present.
  for (const step of publishSteps) {
    if (typeof step.uses === "string") {
      check(
        /^actions\/download-artifact@[0-9a-f]{40}$/.test(step.uses),
        `publish may only use download-artifact, found: ${step.uses}`,
      );
    }
  }
  const bannedPublishRuns = [
    "actions/checkout@",
    "actions/setup-node@",
    "scripts/stage-package.sh",
    "scripts/check-",
    "scripts/release-notes.sh",
    "npm ci",
    "npm install",
    "npm run",
    "npm test",
    "git rev-parse",
  ];
  for (const script of runScripts(publishSteps)) {
    for (const banned of bannedPublishRuns) {
      check(!executable(script).includes(banned), `publish must not run tagged code (${banned})`);
    }
  }

  const buildUses = buildSteps.map((s) => s.uses).filter((u): u is string => typeof u === "string");
  const publishUses = publishSteps.map((s) => s.uses).filter((u): u is string => typeof u === "string");
  check(buildUses.some((u) => u.startsWith("actions/upload-artifact@")), "build must upload the release assets");
  check(publishUses.some((u) => u.startsWith("actions/download-artifact@")), "publish must download the release assets");

  const verifyStep = publishSteps.find(
    (s) => typeof s.run === "string" && executable(s.run as string).includes("sha256sum -c"),
  );
  check(verifyStep !== undefined, "publish must verify the artifact with sha256sum -c in an actual run script");
  const verify = typeof verifyStep?.run === "string" ? executable(verifyStep.run) : "";
  // Bind the published tarball to its checksum name: exactly one tarball and
  // one checksum, the checksum filename is the tarball's own .sha256, the
  // file holds exactly one entry, and that entry names the tarball by
  // basename. The pre-fix bare glob (`sha256sum -c *.tgz.sha256`) trusts
  // whatever filename the checksum file lists, so a checksum naming
  // notes.md would pass while the published tarball went unchecked.
  check(!verify.includes("sha256sum -c *"), "verify must not use the bare checksum glob");
  check(verify.includes('sha256sum -c "${checksums[0]}"'), "verify must check the specific bound checksum file");
  check(verify.includes('"$tarball.sha256"') || verify.includes("$tarball.sha256"), "verify must require the checksum basename to match the tarball");
  check(verify.includes("wc -l"), "verify must require exactly one checksum entry");
  check(verify.includes("cut -c67-"), "verify must compare the whole entry filename, not one whitespace field");

  const publishStep = publishSteps.find(
    (s) => typeof s.run === "string" && executable(s.run as string).includes("gh release create"),
  );
  check(publishStep !== undefined, "publish must create the release with gh release create");
  const publishScript = typeof publishStep?.run === "string" ? executable(publishStep.run) : "";
  check(publishScript.includes("*.tgz"), "publish must upload the tarball explicitly");
  check(publishScript.includes("*.tgz.sha256"), "publish must upload the checksum explicitly");
  check(publishScript.includes('"$TAG"'), "publish must create the release for the tag");
  check(publishScript.includes("--verify-tag"), "publish must verify the tag");
  check(publishScript.includes("--notes-file"), "publish must pass the notes as release notes");
  check(!/\bassets\/\*(?:\s|"|$)/.test(publishScript), "publish must not upload the whole assets directory");

  return violations;
}

const doc = parseWorkflow(workflowText);
const build = doc.jobs!.build!;
const publish = doc.jobs!.publish!;
const publishSteps = stepsOf(publish);
const verifyScript = runScripts(publishSteps).find((s) => executable(s).includes("sha256sum -c"))!;

describe("release workflow token split", () => {
  it("passes the YAML-aware guard on the workflow as committed", () => {
    expect(guardViolations(doc)).toEqual([]);
  });

  it("runs the build job with a read-only token and no write permission", () => {
    expect(permissionsOf(doc).contents).toBe("read");
    expect(permissionsOf(build).contents).toBe("read");
    expect(Object.values(permissionsOf(build))).not.toContain("write");
  });

  it("runs the publish job with the write token and depends on the build job", () => {
    expect(permissionsOf(publish).contents).toBe("write");
    expect(needsOf(publish)).toContain("build");
  });

  it("runs no tagged code in the publish job", () => {
    const violations = guardViolations(doc).filter((v) => v.includes("tagged code") || v.includes("download-artifact"));
    expect(violations).toEqual([]);
    for (const step of publishSteps) {
      if (typeof step.uses === "string") {
        expect(step.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/);
      }
    }
  });

  it("hands the assets from build to publish as an artifact and verifies the digest", () => {
    const buildUses = stepsOf(build).map((s) => s.uses).filter((u): u is string => typeof u === "string");
    const publishUses = publishSteps.map((s) => s.uses).filter((u): u is string => typeof u === "string");
    expect(buildUses.some((u) => u.startsWith("actions/upload-artifact@"))).toBe(true);
    expect(publishUses.some((u) => u.startsWith("actions/download-artifact@"))).toBe(true);
    expect(verifyScript).toContain('sha256sum -c "${checksums[0]}"');
  });

  it("publishes only the tarball and its checksum, not the notes", () => {
    const script = runScripts(publishSteps).find((s) => s.includes("gh release create"))!;
    expect(script).toContain("*.tgz");
    expect(script).toContain("*.tgz.sha256");
    expect(script).toContain('"$TAG"');
    expect(script).toContain("--notes-file");
    expect(script).not.toMatch(/\bassets\/\*(?:\s|"|$)/);
  });
});

// Run the workflow's actual verify script (extracted from the parsed YAML)
// against a staged artifact directory, exactly as the publish job does with
// RUNNER_TEMP/assets. Returns the script's exit status.
function runVerifyScript(script: string, files: Record<string, string>): number {
  const root = mkdtempSync(join(tmpdir(), "release-verify-"));
  try {
    const assets = join(root, "assets");
    mkdirSync(assets, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(assets, name), content);
    }
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      env: { ...process.env, RUNNER_TEMP: root },
      encoding: "utf8",
    });
    expect(result.error, `verify script must run: ${result.error?.message ?? ""}`).toBeUndefined();
    return result.status ?? -1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
function checksumFor(entryName: string, content: string): string {
  return `${sha256(content)}  ${entryName}\n`;
}

const TARBALL = "pkg-1.2.3-abc1234.tgz";
const TARBALL_CONTENT = "fake tarball bytes\n";
const NOTES = "release notes\n";

function goodArtifact(): Record<string, string> {
  return {
    [TARBALL]: TARBALL_CONTENT,
    [`${TARBALL}.sha256`]: checksumFor(TARBALL, TARBALL_CONTENT),
    "notes.md": NOTES,
  };
}

describe("release workflow publish verification", () => {
  it("accepts an artifact whose checksum names the single tarball", () => {
    expect(runVerifyScript(verifyScript, goodArtifact())).toBe(0);
  });

  it("rejects a checksum that names notes.md instead of the tarball", () => {
    // The malformed artifact the bare glob missed: the checksum verifies
    // notes.md (which exists) while the published tarball is unchecked.
    const files = goodArtifact();
    files[`${TARBALL}.sha256`] = checksumFor("notes.md", NOTES);
    expect(runVerifyScript(verifyScript, files)).not.toBe(0);
  });

  it("rejects a checksum whose basename does not match the tarball", () => {
    const files = goodArtifact();
    delete files[`${TARBALL}.sha256`];
    files["other.tgz.sha256"] = checksumFor("other.tgz", TARBALL_CONTENT);
    expect(runVerifyScript(verifyScript, files)).not.toBe(0);
  });

  it("rejects a checksum with more than one entry", () => {
    const files = goodArtifact();
    files[`${TARBALL}.sha256`] =
      checksumFor(TARBALL, TARBALL_CONTENT) + checksumFor("notes.md", NOTES);
    expect(runVerifyScript(verifyScript, files)).not.toBe(0);
  });

  it("rejects a checksum entry naming a whitespace decoy instead of the tarball", () => {
    // `sha256sum -c` treats everything after the digest separator as the
    // filename, so an entry for "pkg.tgz decoy" checks that decoy file
    // while the published tarball goes unchecked. Comparing only the
    // second whitespace field would wrongly accept this.
    const files = goodArtifact();
    files[`${TARBALL} decoy`] = "";
    files[`${TARBALL}.sha256`] = checksumFor(`${TARBALL} decoy`, "");
    expect(runVerifyScript(verifyScript, files)).not.toBe(0);
  });

  it("rejects a checksum entry naming the tarball with the wrong digest", () => {
    const files = goodArtifact();
    files[`${TARBALL}.sha256`] = checksumFor(TARBALL, "different bytes\n");
    expect(runVerifyScript(verifyScript, files)).not.toBe(0);
  });

  it("rejects an artifact with two tarballs", () => {
    const files = goodArtifact();
    files["extra.tgz"] = TARBALL_CONTENT;
    expect(runVerifyScript(verifyScript, files)).not.toBe(0);
  });

  it("documents that the pre-fix bare glob passed the notes.md malformation", () => {
    // Regression contrast: the old `sha256sum -c *.tgz.sha256` script exits 0
    // on the malformed artifact above, which is why the bound check exists.
    const oldScript = [
      'cd "$RUNNER_TEMP/assets"',
      "test -f notes.md",
      "sha256sum -c *.tgz.sha256",
    ].join("\n");
    const files = goodArtifact();
    files[`${TARBALL}.sha256`] = checksumFor("notes.md", NOTES);
    expect(runVerifyScript(oldScript, files)).toBe(0);
    expect(runVerifyScript(verifyScript, files)).not.toBe(0);
  });
});

describe("release workflow guard mutation coverage", () => {
  // Each mutation is applied to the raw workflow text and re-parsed, so a
  // guard built on substrings would keep passing (the text is still there,
  // just commented out or removed from the parsed structure) while the
  // YAML-aware guard must fail.
  function mutatedViolations(mutate: (text: string) => string): string[] {
    return guardViolations(parseWorkflow(mutate(workflowText)));
  }

  it("fails when the checksum verification survives only in a comment", () => {
    const violations = mutatedViolations((text) =>
      text.replace('sha256sum -c "${checksums[0]}"', '# sha256sum -c "${checksums[0]}"'),
    );
    expect(violations).toContain("publish must verify the artifact with sha256sum -c in an actual run script");
  });

  it("fails when the publish dependency on build survives only in a comment", () => {
    const violations = mutatedViolations((text) => text.replace("needs: [build]", "# needs: [build]"));
    expect(violations).toContain("publish must depend on build via needs");
  });

  it("fails when the publish dependency on build is removed", () => {
    const violations = mutatedViolations((text) => text.replace("\n    needs: [build]", ""));
    expect(violations).toContain("publish must depend on build via needs");
  });

  it("fails when publish checks out tagged code", () => {
    const violations = mutatedViolations((text) =>
      text.replace(
        "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      ),
    );
    expect(violations.some((v) => v.includes("download-artifact"))).toBe(true);
  });

  it("fails when the build job gains a write permission", () => {
    const violations = mutatedViolations((text) =>
      text.replace("contents: read # build only", "contents: write # build only"),
    );
    expect(violations).toContain("build permissions must be contents: read");
  });

  it("fails on the pre-fix bare-glob verification", () => {
    const violations = mutatedViolations((text) =>
      text.replace('sha256sum -c "${checksums[0]}"', "sha256sum -c *.tgz.sha256"),
    );
    expect(violations).toContain("verify must not use the bare checksum glob");
  });
});
