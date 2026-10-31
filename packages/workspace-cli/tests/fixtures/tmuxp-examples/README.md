# tmuxp example workspaces

The `.yaml` files in this directory are the workspace files in tmuxp's
[`examples/`](https://github.com/tmux-python/tmuxp/tree/153acdf6ff1268b14d3d03ed488f545a7123c8f1/examples)
directory at revision `153acdf6ff1268b14d3d03ed488f545a7123c8f1`, copied byte for byte. They are what
[tmuxp's configuration examples](https://tmuxp.git-pull.com/configuration/examples/)
page shows.

[`tmuxp-examples.test.ts`](../../tmuxp-examples.test.ts) runs
`tmux-workspace load -d` on each file against a private tmux server and
checks the windows and panes it builds. `plugin-system.yaml` is the one file
the CLI refuses, and the test asserts that refusal.

Do not edit these files. To follow tmuxp, copy the new versions over them and
change the revision above. A file that differs from tmuxp's is no longer an
example of tmuxp's.

## License

tmuxp is MIT licensed. The copies carry its notice:

```text
MIT License

Copyright (c) 2013- tmuxp contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
