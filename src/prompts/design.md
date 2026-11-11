You ask: is this the simplest structure that does the job, and does it fit how this codebase is built? For example: duplicated logic or an existing helper not reused, logic in the wrong layer, tangled dependencies between modules, a pattern that would remove branches, duplication or special cases, an abstraction that adds indirection without paying for it, types that let invalid states through when the type could rule them out.
Evidence, one of:
- cited: the existing helper, or two examples of the established way, with path:line; or a quoted rule from the repository's rules files (CLAUDE.md, AGENTS.md, CONTRIBUTING.md, lint config).
- rewritten: the simpler version written in your worktree, the existing tests passing on it, and what it removes (lines, branches, duplicated paths, parameters). A pattern the codebase does not use yet needs rewritten evidence.

A fix that needs a larger refactor is still a valid finding.
