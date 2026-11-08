// Parse repo-controlled TOML with the isolated Python stdlib, never imports
// from the source tree. No Python/tomllib, unsupported shapes or parse failure
// means stay local. This deliberately supports only the root registry-backed
// `test` extra, not workspaces, sources, dependency groups or arbitrary extras.
import { execFile } from "node:child_process";

export const MAX_UV_EXTRA_MANIFEST_BYTES = 256 * 1024;
export const MAX_UV_EXTRA_LOCK_BYTES = 4 * 1024 * 1024;

const VALIDATE = String.raw`
import json, re, resource, sys, tomllib
resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (3, 3))

def canonical(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?", value):
        raise ValueError("name")
    return re.sub(r"[-_.]+", "-", value).lower()

def release(value):
    # Bounded final numeric releases only. Zero-padding implements PEP 440
    # release ordering/equality; epochs, pre/dev/post/local forms stay local.
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,9}(?:\.[0-9]{1,9}){0,7}", value):
        raise ValueError("release")
    parts = tuple(int(part) for part in value.split("."))
    return parts + (0,) * (8 - len(parts))

def satisfies(version, specifier):
    target = release(version)
    if not specifier:
        return True
    # Do not approximate compatible-release, wildcard or arbitrary equality.
    # Unsupported constraints fail closed rather than invoke a resolver.
    clauses = specifier.split(",")
    if len(clauses) > 16:
        return False
    for clause in clauses:
        match = re.fullmatch(r"(==|!=|<=|>=|<|>)([0-9.]+)", clause)
        if not match:
            return False
        bound = release(match[2])
        if not {"==": target == bound, "!=": target != bound,
                "<=": target <= bound, ">=": target >= bound,
                "<": target < bound, ">": target > bound}[match[1]]:
            return False
    return True

def validate(manifest, lock):
    if type(lock.get("version")) is not int or lock["version"] != 1:
        return False
    project = manifest["project"]
    uv = manifest.get("tool", {}).get("uv", {})
    # Extra/group conflicts require selection resolution outside this contract.
    # Inspect both inputs independently: frozen sync uses lock-recorded conflicts.
    if any(key in uv for key in ("workspace", "sources", "conflicts")) or "conflicts" in lock:
        return False
    if "dynamic" in project:
        return False
    name = canonical(project["name"])
    extras = project["optional-dependencies"]
    if not isinstance(extras, dict) or len({canonical(key) for key in extras}) != len(extras):
        return False
    declared = extras["test"]
    if not isinstance(declared, list) or not 1 <= len(declared) <= 64:
        return False
    # Only simple registry requirements. Markers, URLs and nested extras need
    # a wider contract; do not guess their resolution or execute a resolver.
    requirements = {}
    for requirement in declared:
        if not isinstance(requirement, str):
            return False
        match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)\s*((?:(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+\s*)(?:,\s*(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+\s*)*)?", requirement.strip())
        if not match:
            return False
        dep = canonical(match[1])
        if dep in requirements:
            return False
        requirements[dep] = re.sub(r"\s", "", match[2] or "")
    packages = lock["package"]
    if not isinstance(packages, list) or not all(isinstance(p, dict) for p in packages):
        return False
    roots = [p for p in packages if p.get("source") in ({"editable": "."}, {"virtual": "."})]
    if len(roots) != 1:
        return False
    root = roots[0]
    if not isinstance(project["version"], str) or not project["version"] or canonical(root["name"]) != name or root.get("version") != project["version"]:
        return False
    # Other local projects can change which optional dependencies uv selects.
    if any(any(k in p.get("source", {}) for k in ("editable", "virtual", "directory")) for p in packages if p is not root):
        return False
    optional = root["optional-dependencies"]
    if len({canonical(key) for key in optional}) != len(optional):
        return False
    edges = optional["test"]
    if not isinstance(edges, list) or len(edges) != len(requirements):
        return False
    locked_names = []
    for edge in edges:
        if not isinstance(edge, dict) or set(edge) - {"name", "version", "source"}:
            return False
        dep = canonical(edge["name"])
        locked_names.append(dep)
        targets = [p for p in packages if canonical(p["name"]) == dep]
        # Forked resolutions and conditional edges need a wider contract.
        # Require one unconditional target, including any explicit edge pins.
        if len(targets) != 1 or any(not isinstance(p.get("version"), str) or not p["version"]
                              or ("version" in edge and p.get("version") != edge["version"])
                              or ("source" in edge and p.get("source") != edge["source"])
                              or set(p.get("source", {})) != {"registry"}
                              or not isinstance(p["source"]["registry"], str) for p in targets):
            return False
        if dep not in requirements or not satisfies(targets[0]["version"], requirements[dep]):
            return False
    if len(set(locked_names)) != len(locked_names) or set(locked_names) != set(requirements):
        return False
    metadata = root["metadata"]
    provided = metadata["provides-extras"]
    if not isinstance(provided, list) or len({canonical(x) for x in provided}) != len(provided) or "test" not in provided:
        return False
    recorded = {}
    for dep in metadata["requires-dist"]:
        marker = dep.get("marker", "")
        if not isinstance(marker, str):
            return False
        if "extra" not in marker:
            continue
        if marker not in ("extra == 'test'", 'extra == "test"'):
            # An expression involving test but not exactly the supported marker
            # is ambiguous, not permission to silently ignore a dependency.
            if re.search(r"\btest\b", marker):
                return False
            continue
        if set(dep) - {"name", "specifier", "marker"}:
            return False
        dep_name = canonical(dep["name"])
        if dep_name in recorded or not isinstance(dep.get("specifier", ""), str):
            return False
        recorded[dep_name] = re.sub(r"\s", "", dep.get("specifier", ""))
    return recorded == requirements

try:
    data = json.load(sys.stdin)
    if validate(tomllib.loads(data[0]), tomllib.loads(data[1])):
        print("ok")
except (KeyError, ValueError, TypeError, AttributeError, RecursionError):
    pass
`;

export async function supportsLockedUvTestExtra(manifest: Buffer, lock: Buffer): Promise<boolean> {
  if (manifest.length > MAX_UV_EXTRA_MANIFEST_BYTES || lock.length > MAX_UV_EXTRA_LOCK_BYTES) return false;
  let input: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    input = JSON.stringify([decoder.decode(manifest), decoder.decode(lock)]);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    // Absolute interpreter, fixed cwd, no environment/secret forwarding, no
    // site initialization and no source imports. Bounded time, memory, output.
    const child = execFile("/usr/bin/python3", ["-I", "-S", "-c", VALIDATE], {
      cwd: "/", env: {}, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024,
    }, (error, stdout) => resolve(!error && stdout === "ok\n"));
    child.stdin?.on("error", () => resolve(false));
    child.stdin?.end(input);
  });
}
