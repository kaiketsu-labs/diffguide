# Releases and Marketplace publishing

The extension publisher is configured as `kaiketsu-labs`.

## Publisher registration

Use the owner's Microsoft account to sign in to [Marketplace publisher management](https://marketplace.visualstudio.com/manage) and verify the `kaiketsu-labs` publisher. [Official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher)

Publishing is supported both via Trusted Publishing (OIDC) and via Personal Access Tokens (`VSCE_PAT`). For Open VSX (Cursor / VSCodium), configure `OVSX_PAT`.

For the first release, browser upload is the simplest route: package the extension, open the publisher's management page, and upload the VSIX as a VS Code extension. This uses the signed-in account; no CLI personal access token is needed for this route. Review the listing and confirm its published status before adding a Marketplace install link. [Manual upload instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-an-extension)

Account sign-in, publisher creation, and acceptance of Marketplace terms belong to the account owner. Do not commit credentials.

## Prepare a GitHub release

Update the version in `package.json` and its lockfile, and describe the change in `CHANGELOG.md`. Resolve the source findings and complete the checks recorded in [REVIEW.md](REVIEW.md). Before Marketplace upload, also settle the publisher ID, licensing, repository metadata, and listing assets.

A developer preview can be shared earlier for evaluation when its release notes explicitly list unfinished verification. The initial 0.1.1 GitHub prerelease follows this route: packaging succeeded, while type checking, automated tests, and a live authenticated Claude walkthrough remain pending. It is not a validated stable release.

The **Validate and package** workflow is manual. On the repository's **Actions** page, select it, choose the intended branch, and explicitly approve the checks. It installs locked dependencies, runs type checking and tests, builds the extension, and uploads the VSIX as a workflow artifact. A successful run is evidence for that commit only.

The **Prepare release** workflow is also manual. Run it on `main`, supply the version already committed in `package.json`, and approve checks and draft-release creation. It validates, packages, creates a **draft GitHub prerelease** with the VSIX attached, and automatically publishes to the VS Code Marketplace and Open VSX when publishing tokens (`VSCE_PAT`, `OVSX_PAT`) or Trusted Publishing (`VSCE_USE_OIDC`) are configured. Review the draft, install its VSIX, record the live smoke-test result, then publish the release in GitHub when ready.

Run these workflows only after human approval. They are deliberately not triggered by pushes, pull requests, or tags. GitHub explains [how to run a manual workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

## Listing assets

The README links to a staged demo with simulated Claude replies. Keep that disclosure when sharing it. Relative README images need a reachable repository URL when rendered on the Marketplace; if the repository is private, use an appropriate public HTTPS image location before packaging a public listing.
