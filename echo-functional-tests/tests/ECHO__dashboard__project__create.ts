import { test, expect } from '@playwright/test';
import { getCommonConfig } from '../commonUtils';

const config = getCommonConfig();

test('can create project as admin', async ({ page }) => {

  await page.goto(config.dashboardUrl + "/projects");

  await page.getByRole('button', { name: 'Create' }).click();

  expect(page.url()).toMatch(/projects\/[a-f0-9-]+\/overview/);

  expect(page.getByText('New Project')).toBeVisible();
});