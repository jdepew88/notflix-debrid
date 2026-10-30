# Testing and releasing

`main` is the only long-lived branch. Work on a short feature branch, merge it, delete it. Never
force-push or rewrite published history.

## Before merging to `main`

| Suite | Command |
|---|---|
| TypeScript | `npm run typecheck` |
| Lint | `npm run lint` |
| Web unit tests | `npm test` |
| Engine unit tests | `npm run engine:test` |
| Launcher, shortcut, processes, persistence, mDNS | `node scripts/test-windows-launcher.mjs` |
| Fresh copy install and onboarding | `node scripts/test-windows-install.mjs` |
| Integration and browser | `scripts\notflix.ps1 test -Integration -Browser` |

These test scripts use throwaway copies, data folders and ports, and they build in the copy. Don't run
`next build` or `dotnet build` in a folder a running server was started from.

## What cannot pass without live credentials

The browser suite is the only part that needs them, and the results below are what to expect
**without** a real TMDB key:

- 15 tests fail because their catalog rows are empty: `auth` (sign-up reaches the catalog),
  `brand` (TV navigation), `catalog`, `details`, `hero`, and two `permissions` tests.
- 4 tests skip, including the Real-Debrid playback test.

These are not passes. To run them, use a data folder that already holds your own keys (the values
are not printed):

```powershell
scripts\notflix.ps1 test -Browser -CredentialsFrom <onboarded data folder>
node scripts/test-live-debrid.mjs <server URL> <account> <password>
```

`npm run lint` currently reports 12 errors and 23 warnings in code older than the notification work.

## Publishing

1. Run the suites above and record any failures in the release notes.
2. Search for secrets and personal data before pushing. Real keys belong only in the data folder.
3. Merge to `main` and push normally.
4. Tag it: `git tag -a vX.Y.Z -m "..."`, `git push origin vX.Y.Z`, then create a GitHub Release.
5. Test a fresh clone: `git clone`, `Setup-Notflix.cmd`, the Desktop shortcut, a second double-click.
6. If the TV contract changed (`/api/health`, the announcement or the API), update and test
   [notflix-android-tv](https://github.com/jdepew88/notflix-android-tv), which is released separately.
