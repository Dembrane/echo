import { test as setup, expect } from '@playwright/test';
import { getCommonConfig } from '../commonUtils';

const config = getCommonConfig();

setup('authenticate admin', async ({ page }) => {
   await page.goto(config.dashboardUrl);
   await page.getByRole('textbox', { name: 'Email' }).fill(config.auth.admin.email);
   await page.getByRole('textbox', { name: 'Password' }).fill(config.auth.admin.password);
   await page.getByRole('button', { name: 'Login' }).click();

   await expect(page.getByText('Home')).toBeVisible()
   await expect(page.getByText('Projects')).toBeVisible()
   await expect(page.getByText('Create')).toBeVisible()

   await page.context().storageState({ path: config.authAdminStorePath });
});