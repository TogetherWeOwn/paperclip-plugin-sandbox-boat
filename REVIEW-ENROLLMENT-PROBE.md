# Disposable review enrollment probe

This documentation-only pull request checks automatic review status emission on a
fresh commit after repository enrollment. It changes no runtime behavior,
dependencies, workflows, settings, or release artifacts.

This probe is not intended to merge. After recording the real review status and
answering any review findings, close its pull request and delete only its remote
test branch. A reported review status is enrollment evidence, not merge readiness
or permission to bypass required checks.
