## Summary

One or two sentences. What does this change and why?

## Related issue

Fixes #0

## Checklist

- [ ] Scope is focused on one logical change (split unrelated features into separate PRs)
- [ ] `bun run check` passes locally (`typecheck` + `lint` + `quality` + `deadcode` + `bun test`)
- [ ] `AGENTS.md` module table is synced (`bun run agents:sync` if `src/*.ts` modules were added/removed)
- [ ] Preserves hard invariants in [`CLAUDE.md`](CLAUDE.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md):
  - Strictly read-only public observation (never logs in, holds seats, or automates checkout)
  - BookMyShow: Safari/Firefox `node-tls-client` profile only (never Chrome or custom headers), per-show `showDateCode` check, child `formatSelector` chips respected
  - District: public `__NEXT_DATA__` / Flight parsing only, non-OK response bodies cancelled
  - Provider failures throw `BmsError` instead of silently returning `[]`
- [ ] Any Discord copy or embed changes live in `src/messages.ts` with matching unit tests in `src/messages.test.ts`
