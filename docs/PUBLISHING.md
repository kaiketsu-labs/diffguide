# Releases and Marketplace publishing

The extension publisher is configured as `kaiketsu-labs`.

## Publisher registration

Use the owner's Microsoft account to sign in to [Marketplace publisher management](https://marketplace.visualstudio.com/manage) and verify the `kaiketsu-labs` publisher. [Official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher)

Publishing is supported both via Trusted Publishing (OIDC) and via Personal Access Tokens (`VSCE_PAT`). For Open VSX (Cursor / VSCodium), configure `OVSX_PAT`.

Account sign-in, publisher creation, and acceptance of Marketplace terms belong to the account owner. Do not commit credentials.

## Automated releases via Release Please

Releases and versioning are fully automated using **Release Please**:

1. **Conventional Commits**: Every change merged into `main` follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, etc.).
2. **Release PR**: On every push to `main`, Release Please automatically maintains an open Release Pull Request that bumps `package.json`, `package-lock.json`, and records changelog entries in `CHANGELOG.md`.
3. **Triggering a release**: Merging that Release PR creates the GitHub tag and Release, builds the VSIX package, attaches it to the release, and automatically publishes it to the VS Code Marketplace and Open VSX.

## Listing assets

The README links to a staged demo with simulated Claude replies. Keep that disclosure when sharing it. Relative README images need a reachable repository URL when rendered on the Marketplace; if the repository is private, use an appropriate public HTTPS image location before packaging a public listing.
