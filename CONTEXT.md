# Boat execution

This context distinguishes leasing a machine for a whole agent run from borrowing one for a single expensive command.

## Language

**Run lease**:
A machine assignment covering an agent's execution window, including time the agent spends waiting for a model.
_Avoid_: Command lease

**Offload command**:
One eligible heavy command borrowed from an otherwise local agent run, with its own execution identity and result.
_Avoid_: Remote agent run

**Offload pool**:
A bounded set of machines shared by commands from the same repository and trust boundary.
_Avoid_: Per-card fleet

**Card workspace**:
A card's isolated source copy within a pool machine, distinct from the machine's reusable build cache.
_Avoid_: Agent home

**Safe local fallback**:
Execution through the existing local command path after establishing that the offload command never started remotely.
_Avoid_: Retry anywhere

**Staged return**:
A command's returned workspace changes preserved separately for explicit local inspection and application, without changing live source files.
_Avoid_: Automatic writeback

**Uncertain execution**:
An offload command whose remote start or result cannot yet be established, so it cannot safely be replayed locally.
_Avoid_: Safe timeout retry

**Idle tail**:
The billed interval after a machine's last active command and before it stops, attributed separately from command execution.
_Avoid_: Free idle
