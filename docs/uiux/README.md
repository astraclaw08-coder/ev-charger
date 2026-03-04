# UI/UX Visualization Pipeline

Created: 2026-03-01

## Structure
- `packages/portal/.storybook/` — Storybook config for the portal UI
- `packages/portal/src/stories/` — UI component stories
- `packages/portal/playwright.config.ts` — Playwright smoke config
- `packages/portal/tests/e2e/` — journey/smoke test specs
- `.github/workflows/uiux-artifacts.yml` — CI build/test + artifact upload

## Local Commands
```bash
npm run storybook --workspace=packages/portal
npm run build-storybook --workspace=packages/portal
npm run test:playwright --workspace=packages/portal
```

## CI Artifacts
- `storybook-static` — generated Storybook build output (`packages/portal/storybook-static`)
- `playwright-report` — Playwright HTML report (`packages/portal/playwright-report`)
- `playwright-test-results` — traces/screenshots/videos (`packages/portal/test-results`)
