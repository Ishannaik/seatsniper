# Releasing SeatSniper

Tags follow **`vX.Y.Z`** (e.g. `v0.1.0`), matching `version` in [`package.json`](../package.json).

## Checklist

1. **Finish the work** on a feature branch and merge to `main` when ready.
2. **Bump version** in `package.json` (semver: patch / minor / major).
3. **Update [`CHANGELOG.md`](../CHANGELOG.md)**:
   - Move items from `[Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD` section.
   - Add compare links at the bottom (`[X.Y.Z]: …/compare/vPREV…vX.Y.Z`).
4. **Commit** the version + changelog changes on `main`.
5. **Tag locally** (do not push until you are sure):

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   ```

6. **Create the GitHub release** (generates notes from merged PRs/commits; categories from [`.github/release.yml`](../.github/release.yml)):

   ```bash
   gh release create vX.Y.Z --generate-notes
   ```

   Or with a title and body from the changelog:

   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file CHANGELOG.md
   ```

7. **Push tag** only when intentional:

   ```bash
   git push origin vX.Y.Z
   ```

## First release (`v0.1.0`)

No tag exists on the remote yet. When ready to publish the current `0.1.0` line:

```bash
git checkout main
git tag -a v0.1.0 -m "v0.1.0 — first release"
gh release create v0.1.0 --generate-notes
git push origin v0.1.0
```

Copy the `[0.1.0]` section from `CHANGELOG.md` into the release description if you want richer notes than `--generate-notes` alone.

## Notes

- Prefer **annotated tags** (`-a`) so `git describe` works cleanly.
- Release notes categories are configured in `.github/release.yml`; label PRs (`feature`, `bug`, `docs`, etc.) for nicer auto-grouping.
- Do **not** tag pre-release WIP on feature branches unless explicitly shipping a prerelease (`v0.2.0-rc.1`).
