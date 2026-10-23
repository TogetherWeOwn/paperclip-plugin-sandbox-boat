"""Isolated mutation evidence for native-sync acceptance tests.

Usage: python3 src/test-support/native-sync-review-mutations.py
Copies source into run-owned scratch. Never edits the checkout or commits a
mutant. Baseline's known longer-override RED is reported separately, not counted
as a mutation kill. Full selected files run without skips or test-name filters.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
scratch = os.environ.get('PAPERCLIP_RUN_SCRATCH_DIR') or os.environ.get('PAPERCLIP_SCRATCH_DIR')
if not scratch:
    raise SystemExit('Set PAPERCLIP_RUN_SCRATCH_DIR to confined test scratch.')
artifacts = Path(scratch) / 'native-sync-mutation-evidence'
artifacts.mkdir(exist_ok=True)
files = ['src/native-sync-review-regressions.test.ts', 'src/native-sync-metadata-bound.test.ts',
         'src/native-sync-activity-lifecycle.test.ts']


def run(label, mutate=None):
    with tempfile.TemporaryDirectory(prefix='sync-mutant-', dir=scratch) as temporary:
        target = Path(temporary)
        shutil.copytree(repo / 'src', target / 'src')
        for name in ['package.json', 'tsconfig.json', 'vitest.config.ts']:
            shutil.copy2(repo / name, target / name)
        (target / 'node_modules').symlink_to((repo / 'node_modules').resolve(), target_is_directory=True)
        if mutate:
            mutate(target)
        report = artifacts / (label + '.json')
        with (artifacts / (label + '.log')).open('w') as log:
            result = subprocess.run([str(target / 'node_modules/.bin/vitest'), 'run', *files,
                                     '--maxWorkers=2', '--reporter=verbose', '--reporter=json',
                                     '--outputFile.json=' + str(report)], cwd=target, stdout=log, stderr=subprocess.STDOUT)
        data = json.loads(report.read_text())
        failed = {case['fullName']: case['failureMessages']
                  for suite in data['testResults'] for case in suite['assertionResults'] if case['status'] == 'failed'}
        summary = {'name': label, 'exit': result.returncode, 'passed': data['numPassedTests'],
                   'failed': data['numFailedTests'], 'pending': data['numPendingTests'], 'failures': failed}
        if summary['pending'] or data.get('numRuntimeErrorTestSuites', 0):
            raise RuntimeError('Invalid evidence (skip/runtime error): ' + label)
        return summary


def replacement(file, before, after, sync_only=False):
    def apply(target):
        destination = target / file
        text = destination.read_text()
        if sync_only:
            start = text.index('  async sync(')
            end = text.index('  async execute(', start)
            scope = text[start:end]
            if scope.count(before) != 1:
                raise RuntimeError('Mutation seam changed: ' + file)
            text = text[:start] + scope.replace(before, after) + text[end:]
        else:
            if text.count(before) != 1:
                raise RuntimeError('Mutation seam changed: ' + file)
            text = text.replace(before, after)
        destination.write_text(text)
    return apply


baseline = run('baseline-restored')
known = set(baseline['failures'])
if len(known) != 1 or not next(iter(known)).endswith('longer override'):
    raise RuntimeError('Unexpected immutable baseline failures: ' + json.dumps(baseline))
results = [baseline]
mutants = [
    ('sync-begin-disabled', replacement('src/vm-manager.ts', '    this.beginActivity(config, sandboxId);',
                                       '    // isolated mutant: sync begin disabled', True), 4),
    ('sync-end-disabled', replacement('src/vm-manager.ts', '      await this.endActivity(params.companyId, sandboxId);',
                                     '      // isolated mutant: sync end disabled', True), 4),
    ('sync-extension-disabled', replacement('src/vm-manager.ts', '      await this.maybeExtend(config, sandboxId);',
                                           '      // isolated mutant: sync extension disabled', True), 4),
    ('gnu-cap-disabled', replacement('src/file-sync-script.ts', '            if self.size > MAX_METADATA:',
                                    '            if False:  # isolated mutant: metadata cap disabled'), 4),
    ('outbound-command-guard-disabled', replacement('src/file-sync.ts',
        '    if (direction === "out" && operation.postUploadCommands?.length) {',
        '    if (false) { // isolated mutant: outbound command guard disabled'), 2),
    ('accounting-validator-disabled', replacement('src/file-sync.ts',
        '  if (![counts.filesTransferred, counts.bytesTransferred].every((n) => Number.isSafeInteger(n) && n >= 0)) {',
        '  if (false) { // isolated mutant: accounting validation disabled'), 8),
]
for label, mutate, expected in mutants:
    evidence = run(label, mutate)
    additional = set(evidence['failures']) - known
    evidence['additionalFailures'] = sorted(additional)
    evidence['killed'] = len(additional) == expected and known.issubset(evidence['failures'])
    results.append(evidence)
    print(f"{label}: {evidence['passed']} passed, {evidence['failed']} failed, {evidence['pending']} skipped; "
          f"additional assertion failures={len(additional)}, killed={evidence['killed']}", flush=True)
    (artifacts / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
    if not evidence['killed']:
        raise RuntimeError('Mutation did not fail as expected: ' + label)
restored = run('baseline-after-mutants')
results.append(restored)
(artifacts / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
if set(restored['failures']) != known:
    raise RuntimeError('Restored baseline differs')
print(f"Restored baseline: {restored['passed']} passed, {restored['failed']} known RED, {restored['pending']} skipped", flush=True)
