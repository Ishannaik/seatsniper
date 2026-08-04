## Summary

One or two sentences. What does this change and why?

## Related issue

Fixes #0

## Checklist

- [ ] Change is one thing (split bigger changes into separate PRs)
- [ ] `bun test` passes
- [ ] No regression of the constraints in [CONTRIBUTING.md](CONTRIBUTING.md):
      Safari TLS profile, `showDateCode` field comparison, errors throw instead
      of returning `[]`
- [ ] New Discord copy lives in `src/messages.ts` and matches the existing voice
