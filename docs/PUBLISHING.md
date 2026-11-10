# Releases and Marketplace publishing

The extension publisher is `kaiketsu-labs` and the extension ID is `kaiketsu-labs.diffguide`.

## Publisher registration

Use the owner's Microsoft account to sign in to [Marketplace publisher management](https://marketplace.visualstudio.com/manage) and verify the `kaiketsu-labs` publisher. [Official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher)

Publishing is supported both via Trusted Publishing (OIDC) and via Personal Access Tokens (`VSCE_PAT`). For Open VSX (Cursor / VSCodium), configure `OVSX_PAT`.

Account sign-in, publisher creation, and acceptance of Marketplace terms belong to the account owner. Do not commit credentials.

## Automated releases via Release Please

Releases and versioning are fully automated using **Release Please**:

1. **Conventional Commits**: Every change merged into `main` follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, etc.).
2. **Release PR**: On every push to `main`, Release Please automatically maintains an open Release Pull Request that bumps `package.json`, `package-lock.json`, and records changelog entries in `CHANGELOG.md`. The release workflow then moves the hand-written lines under `## Unreleased` into the new release as `### Notes`.
3. **Triggering a release**: Merging that Release PR creates the GitHub tag and Release, builds the VSIX package, attaches it to the release, and automatically publishes it to the VS Code Marketplace and Open VSX.

## Renaming from Pair Review

These steps happen outside the repository and belong to the account owner.

- Rename the GitHub repository from `kaiketsu-labs/pair-review` to `kaiketsu-labs/diffguide` in its settings. GitHub redirects the old URLs, including the release links in older changelog entries.
- Update the repository description and topics to the DiffGuide name.
- The first release of `kaiketsu-labs.diffguide` creates new Marketplace and Open VSX listings. Open VSX has no `kaiketsu-labs.pair-review` listing, so nothing needs to be retired there.
- Mark the `kaiketsu-labs.pair-review` Marketplace listing deprecated in favor of `kaiketsu-labs.diffguide`. VS Code's [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) asks for a comment in the [deprecated extensions discussion](https://github.com/microsoft/vscode-discussions/discussions/1); it names no `vsce` command or portal setting for this. VS Code then shows a **Migrate** button, but does not uninstall Pair Review.
- After the rename, check that the next push to `main` still opens or updates the Release PR, and that merging it tags, uploads `diffguide-<version>.vsix` and publishes. The workflow uses the current repository, so no URL in it changes.

## Listing assets

The README links to a staged demo with simulated Claude replies. Keep that disclosure when sharing it. Relative README images need a reachable repository URL when rendered on the Marketplace; if the repository is private, use an appropriate public HTTPS image location before packaging a public listing.
