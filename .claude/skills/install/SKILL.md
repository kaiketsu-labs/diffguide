---
name: install
description: Package DiffGuide and install it into the user's VS Code. Use when the user asks to install, package or try a change, or when a change is ready for the user to test in the installed extension.
---

# Install the extension

The user tests in the installed extension, not the debug host.

1. Run `make install`. It packages `diffguide-<version>.vsix` from `package.json` and runs `code --install-extension <vsix> --force`.
2. Run `ls *.vsix` and delete VSIX files of other versions. Keep the one just built.
3. Tell the user to reload all VS Code windows. The install swaps `dist/overview.js` under open windows, so review pages opened before a reload pair old HTML with the new script and break.

Report what was installed (the version) and what the user must check by hand. An install is not verification.
