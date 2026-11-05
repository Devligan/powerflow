## What and why

## Release notes

- [ ] CI is green (lint, types, tests, build, database suites, secret scan)
- [ ] Migrations are new files only; superseded ones are never re-run
- [ ] A migration this code depends on is applied to production **before** merging
- [ ] Engine changes: migration, TypeScript mirror and both test layers move together
