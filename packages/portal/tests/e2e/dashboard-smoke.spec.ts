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

  await expect(page.getByText('EV Portal')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('No sites yet')).toBeVisible();
});
