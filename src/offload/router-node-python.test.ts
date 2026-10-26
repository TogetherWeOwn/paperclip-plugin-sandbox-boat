import { describe, expect, it } from "vitest";
import { classifyNode, classifyPython } from "./router.js";

const NODE = { id: "node-public-1" };
const PY = { id: "python-public-1" };

describe("classifyNode", () => {
  it.each([
    ["npm", ["run", "test"]],
    ["npm", ["run", "test:integration"]],
    ["npm", ["run", "e2e"]],
    ["npm", ["run", "build"]],
    ["npm", ["test"]],
    ["npm", ["test", "--", "--coverage"]],
    ["pnpm", ["run", "spec"]],
    ["yarn", ["test"]],
    ["yarn", ["run", "tests-e2e"]],
  ])("routes %s %s to a remote candidate", (runner, argv) => {
    const result = classifyNode(runner, argv, NODE);
    expect(result.mode).toBe("remote_candidate");
    expect(result.profileId).toBe("node-public-1");
    expect(result.runner).toBe(runner);
  });

  it.each([
    ["npx", ["vitest", "run"]],
    ["npx", ["vitest", "run", "--coverage"]],
    ["npx", ["vitest", "run", "tests/e2e"]],
    ["npx", ["jest"]],
    ["npx", ["jest", "--ci"]],
    ["npx", ["playwright", "test"]],
    ["npx", ["playwright", "test", "tests/e2e"]],
    ["npx", ["next", "build"]],
    ["pnpm", ["exec", "vitest", "run"]],
    ["pnpm", ["vitest", "run"]],
    ["yarn", ["jest", "--ci"]],
  ])("routes %s %s to a remote candidate", (runner, argv) => {
    expect(classifyNode(runner, argv, NODE).mode).toBe("remote_candidate");
  });

  it.each([
    ["npm", ["run", "lint"]],
    ["npm", ["run", "typecheck"]],
    ["npm", ["run", "format:check"]],
    ["npm", ["run", "dev"]],
    ["npm", ["install"]],
    ["npm", ["ci"]],
    ["npm", ["start"]],
    ["npm", ["run"]],
    ["npm", ["run", "deploy"]],
    ["npm", ["run", "test", "--", "--watch"]],
    ["npm", ["run", "test", "--watchAll"]],
    ["npm", ["test", "--", "foo.test.ts"]],
    ["npm", ["test", "--", "tests/e2e/login.spec.ts"]],
    ["npm", ["run", "test", "--", "-t", "login"]],
    ["npx", ["vitest"]],
    ["npx", ["vitest", "run", "foo.test.ts"]],
    ["npx", ["vitest", "run", "--ui"]],
    ["npx", ["jest", "--watch"]],
    ["npx", ["jest", "foo.test.ts"]],
    ["npx", ["playwright", "test", "--ui"]],
    ["npx", ["next", "dev"]],
    ["npx", ["next", "start"]],
    ["npx", ["next", "lint"]],
    ["npx", ["tsc", "--noEmit"]],
    ["npx", ["eslint", "."]],
    ["npx", ["rimraf", "dist"]],
  ])("keeps %s %s local", (runner, argv) => {
    expect(classifyNode(runner, argv, NODE).mode).toBe("local");
  });

  it("keeps build deploy/publish/release scripts local while plain build stays remote", () => {
    expect(classifyNode("npm", ["run", "build"], NODE).mode).toBe("remote_candidate");
    expect(classifyNode("npm", ["run", "build:test"], NODE).mode).toBe("remote_candidate");
    expect(classifyNode("npm", ["run", "build:deploy-prod"], NODE).mode).toBe("local");
    expect(classifyNode("npm", ["run", "build:publish"], NODE).mode).toBe("local");
    expect(classifyNode("npm", ["run", "build:release"], NODE).mode).toBe("local");
    expect(classifyNode("npm", ["run", "build:prod"], NODE).mode).toBe("local");
    expect(classifyNode("npm", ["run", "build:ship"], NODE).mode).toBe("local");
  });

  it("keeps compound shell text local", () => {
    expect(classifyNode("npm", ["run", "test", "&&", "run", "e2e"], NODE).mode).toBe("local");
    expect(classifyNode("npx", ["jest;echo"], NODE).mode).toBe("local");
  });

  it("keeps unknown runners and empty argv local", () => {
    expect(classifyNode("bun", ["run", "test"], NODE).mode).toBe("local");
    expect(classifyNode("npm", [], NODE).mode).toBe("local");
  });

  it("treats an explicit suite dir with -t as whole-suite", () => {
    const result = classifyNode("npx", ["jest", "-t", "login", "tests/e2e"], NODE);
    expect(result.mode).toBe("remote_candidate");
  });

  it("keeps watch-mode Node commands local", () => {
    expect(classifyNode("npm", ["run", "test:watch"], NODE).mode).toBe("local");
    expect(classifyNode("npm", ["run", "test:watchAll"], NODE).mode).toBe("local");
    expect(classifyNode("npm", ["run", "build:watch"], NODE).mode).toBe("local");
    expect(classifyNode("npm", ["run", "test", "--", "-w"], NODE).mode).toBe("local");
    expect(classifyNode("npm", ["test", "--", "-w"], NODE).mode).toBe("local");
    expect(classifyNode("yarn", ["run", "test", "--", "-w"], NODE).mode).toBe("local");
  });

  it("does not mistake flag values for suite dirs", () => {
    expect(classifyNode("npx", ["jest", "-t", "login", "--config", "foo/bar.js"], NODE).mode).toBe("local");
    expect(classifyNode("npx", ["vitest", "run", "__tests__/login.ts"], NODE).mode).toBe("local");
    expect(classifyNode("npx", ["jest", "login"], NODE).mode).toBe("local");
    // --config's value is not a positional filter: the whole suite still runs.
    expect(classifyNode("npx", ["jest", "--config", "jest.config.js"], NODE).mode).toBe("remote_candidate");
  });
});

describe("classifyPython", () => {
  it.each([
    ["pytest", []],
    ["pytest", ["-q"]],
    ["pytest", ["tests/"]],
    ["pytest", ["-n", "auto", "tests/"]],
    ["pytest", ["-x", "--tb=short"]],
    ["python", ["-m", "pytest"]],
    ["python", ["-m", "pytest", "tests/"]],
    ["python3", ["-m", "pytest", "."]],
    ["pytest", ["-k", "not slow", "tests/"]],
    ["python", ["-m", "unittest"]],
    ["python", ["-m", "unittest", "discover"]],
    ["python3", ["-m", "unittest", "discover", "-s", "tests"]],
  ])("routes %s %s to a remote candidate", (runner, argv) => {
    const result = classifyPython(runner, argv, PY);
    expect(result.mode).toBe("remote_candidate");
    expect(result.profileId).toBe("python-public-1");
    expect(result.runner).toBe(runner);
  });

  it.each([
    ["pytest", ["tests/test_auth.py::TestLogin::test_ok"]],
    ["pytest", ["-k", "test_login"]],
    ["pytest", ["-m", "smoke"]],
    ["pytest", ["tests/test_auth.py"]],
    ["pytest", ["--lf"]],
    ["pytest", ["--co", "-q"]],
    ["pytest", ["--deselect", "tests/test_slow.py"]],
    ["python", ["-c", "import pytest; pytest.main()"]],
    ["python", ["script.py"]],
    ["python", ["-m", "unittest", "a.b.TestC.test_d"]],
    ["python", ["-m", "unittest", "-k", "login"]],
    ["python", ["-m", "http.server"]],
    ["python", ["-m", "pytest", "tests/test_a.py::test_x"]],
  ])("keeps %s %s local", (runner, argv) => {
    expect(classifyPython(runner, argv, PY).mode).toBe("local");
  });

  it("keeps compound shell text and unknown runners local", () => {
    expect(classifyPython("pytest", ["tests/", "&&", "lint"], PY).mode).toBe("local");
    expect(classifyPython("ruby", ["-m", "pytest"], PY).mode).toBe("local");
    expect(classifyPython("python", [], PY).mode).toBe("local");
  });

  it("treats pytest -c config files as suite runs, not inline code", () => {
    expect(classifyPython("python", ["-m", "pytest", "-c", "pytest.ini", "tests/"], PY).mode).toBe("remote_candidate");
    expect(classifyPython("python", ["-c", "import pytest; pytest.main()"], PY).mode).toBe("local");
  });

  it("keeps verbose unittest discovery remote", () => {
    expect(classifyPython("python", ["-m", "unittest", "discover", "--verbose"], PY).mode).toBe("remote_candidate");
    expect(classifyPython("python", ["-m", "unittest", "discover", "--failfast"], PY).mode).toBe("remote_candidate");
  });

  it("does not mistake pytest flag values for suite dirs", () => {
    expect(classifyPython("pytest", ["-k", "foo", "--junitxml", "results/out.xml"], PY).mode).toBe("local");
  });
});
