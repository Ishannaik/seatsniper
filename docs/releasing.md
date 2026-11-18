# Releasing SeatSniper

Tags follow **`vX.Y.Z`** (e.g. `v0.2.0`), matching `version` in [`package.json`](../package.json).

Pushing a `v*.*.*` tag triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml), which automatically:
1. Verifies the Git tag matches `package.json` `version` and runs the full CI gate (`lint`, `typecheck`, `quality`, `deadcode`, `bun test`, shell syntax checks).
2. Builds and pushes a multi-architecture (`linux/amd64` + `linux/arm64` for x86 and Oracle Cloud Ampere A1) container image to GitHub Container Registry (`ghcr.io/ishannaik/seatsniper:X.Y.Z`, `:X.Y`, and `:latest`).
3. Publishes the GitHub Release using the PR label categories in [`.github/release.yml`](../.github/release.yml) (unless you already created custom release notes beforehand).

---

## Release Checklist

1. **Land all changes on `main`** via pull request and confirm `.github/workflows/ci.yml` is green.
2. **Run the local verification suite**:

   ```bash
   bun run check
   ```

3. **Bump `version`** in [`package.json`](../package.json) (semver: patch / minor / major).
4. **Update [`CHANGELOG.md`](../CHANGELOG.md)**:
   - Move items from `[Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD` section.
   - Add the compare link at the bottom (`[X.Y.Z]: https://github.com/Ishannaik/seatsniper/compare/vPREV...vX.Y.Z`).
5. **Merge or commit** the version + changelog update to `main`.
6. **Create an annotated tag and push it**:

   ```bash
   git checkout main && git pull --ff-only
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

7. **Verify the Release workflow**:

   ```bash
   gh run list --workflow=release.yml --limit 3
   gh release view vX.Y.Z
   ```

---

## Custom Release Notes (Optional)

If you want curated prose from `CHANGELOG.md` instead of `--generate-notes` alone, create the GitHub Release right before pushing the tag (or edit it afterward)—`release.yml` detects existing releases and preserves your body:

```bash
gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes-file RELEASE_NOTES.md
```

---

## Notes

- Always use **annotated tags** (`git tag -a`) so `git describe` resolves cleanly.
- Prerelease tags such as `v0.3.0-rc.1` are marked `--prerelease` on GitHub Releases and do **not** move the `:latest` GHCR tag.
- Label pull requests (`feature`, `bug`, `docs`, `chore`) so [`.github/release.yml`](../.github/release.yml) groups auto-generated notes cleanly.
