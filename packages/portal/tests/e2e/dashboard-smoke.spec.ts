import { expect, test } from '@playwright/test';

test('dashboard renders with mocked empty site list', async ({ page }) => {
  await page.route('**/sites', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });

  await page.goto('/');

  // New auth shell in dev mode requires explicit sign-in before dashboard loads.
  const devSignIn = page.getByRole('button', { name: /Dev Mode — sign in as operator-001/i });
  if (await devSignIn.isVisible()) {
    await devSignIn.click();
  }

  await expect(page.getByRole('heading', { name: /Dashboard|Overview/i })).toBeVisible();
  await expect(page.getByText('Total Sites')).toBeVisible();
  await expect(page.getByText('No trend data for selected range.')).toBeVisible();
});
