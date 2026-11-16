# ci_matrix

Reads `.github/ci-matrix.txt`, the one place the tmux releases and Bun versions
CI runs are written down. The plan script, the documentation gates and the argv
budget test read it, and the typescript workflow reads the plan, so a list of
versions appears nowhere else.

`parseCiMatrix(text)` returns the supported tmux releases (oldest first), the
preview and development refs, the Bun versions the gates job runs, and the Bun
version the tmux lanes run. It refuses anything the plan could not trust: an
unknown kind, a repeated version, an invalid ref. It is a module with no command of its
own; [`ci_plan`](../ci_plan/README.md) is its main caller.

```console
$ bun test scripts/ci_matrix
```
