import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { OFFLOAD_SSH_SCRIPT } from "./offload-ssh-script.js";

// Execute the shipped Python RPC, not a reimplementation. Only ownership and
// locking are stubbed: this reader fixture needs neither SSH nor delegated
// cgroups, and deterministically pauses the writer at a partial flush boundary.
const READ_FIXTURE = String.raw`
import base64, contextlib, io, json, pathlib, sys, tempfile
request = json.load(sys.stdin)
sys.argv = ['guest.py', 'boot']
sys.stdin = io.TextIOWrapper(io.BytesIO(b'{}'))
guest = {}
with contextlib.redirect_stdout(io.StringIO()):
    exec(request['program'], guest)
state = {'identity': {}, 'result': None, 'supervisorPid': 1, 'supervisorStart': 'owned'}
guest['locked'] = lambda root: contextlib.nullcontext()
guest['validate'] = lambda root, identity: state
guest['start_time'] = lambda pid: 'owned'
with tempfile.TemporaryDirectory(prefix='boat-read-', dir=request['scratch']) as directory:
    root = pathlib.Path(directory)
    filename = root / 'output'
    first = {'stream': 'stdout', 'dataBase64': base64.b64encode(b'hello').decode()}
    second = {'stream': 'stderr', 'dataBase64': base64.b64encode(b'x' * 8192).decode()}
    line = json.dumps(second) + '\n'
    data = {'root': str(root), 'identity': {}, 'after': 0}
    if request['malformed']:
        filename.write_text('{invalid}\n')
    else:
        split = request['split'] if request['split'] > 0 else len(line) - 1
        filename.write_text(json.dumps(first) + '\n' + line[:split])
    try:
        before = guest['rpc']('read', data)
        with filename.open('a') as output:
            output.write(line[split:])
        state['result'] = {'exitCode': 0, 'seconds': 1}
        data['after'] = len(before['events'])
        after = guest['rpc']('read', data)
        data['after'] += len(after['events'])
        finished = guest['rpc']('read', data)
        print(json.dumps({'before': before, 'after': after, 'finished': finished}))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__}))
`;

function readFixture(split: number, malformed = false) {
  return JSON.parse(execFileSync("python3", ["-I", "-c", READ_FIXTURE], {
    input: JSON.stringify({ program: OFFLOAD_SSH_SCRIPT, split, malformed,
      scratch: process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir() }),
    encoding: "utf8", timeout: 5_000,
  }));
}

describe("guest output record boundaries", () => {
  it.each([8192, -1])("defers a torn output tail at split %i without losing or duplicating events", (split) => {
    const pages = readFixture(split);
    expect(pages).not.toHaveProperty("error");
    expect(pages.before).toMatchObject({ events: [{ stream: "stdout", dataBase64: Buffer.from("hello").toString("base64") }],
      result: null, supervisorAlive: true });
    expect(pages.before.events).toHaveLength(1);
    expect(pages.after.events).toEqual([{ stream: "stderr", dataBase64: Buffer.alloc(8192, "x").toString("base64") }]);
    expect(pages.after.result).toBe(null);
    expect(pages.finished).toMatchObject({ events: [], result: { exitCode: 0, seconds: 1 } });
  });

  it("still fails closed on a complete malformed output record", () => {
    expect(readFixture(8192, true)).toEqual({ error: "JSONDecodeError" });
  });
});

// Deterministically lands a writer's os.replace between load()'s open and
// fstat, the window that failed prepare on ubuntu-26.04 (TWO-374).
const STATE_FIXTURE = String.raw`
import contextlib, io, json, os, pathlib, sys, tempfile
request = json.load(sys.stdin)
sys.argv = ['guest.py', 'boot']
sys.stdin = io.TextIOWrapper(io.BytesIO(b'{}'))
guest = {}
with contextlib.redirect_stdout(io.StringIO()):
    exec(request['program'], guest)
with tempfile.TemporaryDirectory(prefix='boat-state-', dir=request['scratch']) as directory:
    root = pathlib.Path(directory)
    guest['save'](root, {'generation': 1})
    if request['hardlink']:
        os.link(root / 'state', root / 'alias')
    real_open = os.open
    raced = []
    def racing_open(path, flags, *rest):
        fd = real_open(path, flags, *rest)
        if not raced and not request['hardlink'] and pathlib.Path(path) == root / 'state':
            raced.append(True)
            guest['save'](root, {'generation': 2})
        return fd
    os.open = racing_open
    try:
        print(json.dumps({'state': guest['load'](root)}))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
    finally:
        os.open = real_open
`;

function stateFixture(hardlink: boolean) {
  return JSON.parse(execFileSync("python3", ["-I", "-c", STATE_FIXTURE], {
    input: JSON.stringify({ program: OFFLOAD_SSH_SCRIPT, hardlink,
      scratch: process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir() }),
    encoding: "utf8", timeout: 5_000,
  }));
}

describe("guest state reads racing an atomic save", () => {
  it("reopens the replaced state instead of refusing it as unsafe", () => {
    expect(stateFixture(false)).toEqual({ state: { generation: 2 } });
  });

  it("still refuses a hardlinked state file", () => {
    expect(stateFixture(true)).toEqual({ error: "unsafe guest state" });
  });
});
