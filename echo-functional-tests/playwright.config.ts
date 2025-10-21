import { defineConfig, devices } from '@playwright/test';
import { getCommonConfig } from './commonUtils';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import dotenv from 'dotenv';

dotenv.config();

const config = getCommonConfig();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    // baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    { name: 'admin-auth', testMatch: /COMMON__auth__admin\.setup\.ts/ },


    {
      name: '(admin) chromium',
      use: { ...devices['Desktop Chrome'] ,
        storageState: config.authAdminStorePath
      },
      dependencies: ['admin-auth'],
    },

    {
      name: '(admin) firefox',
      use: { ...devices['Desktop Firefox'] ,
        storageState: config.authAdminStorePath
      },
      dependencies: ['admin-auth'],
    },

    {
      name: '(admin) webkit',
      use: { ...devices['Desktop Safari'] ,
        storageState: config.authAdminStorePath
      },
      dependencies: ['admin-auth'],
    },

    /* Test against mobile viewports. */
    {
      name: '(admin) Mobile Chrome',
      use: { ...devices['Pixel 5'] ,
        storageState: config.authAdminStorePath
      },
      dependencies: ['admin-auth'],
    },
    {
      name: '(admin) Mobile Safari',
      use: { ...devices['iPhone 12'] ,
        storageState: config.authAdminStorePath
      },
      dependencies: ['admin-auth'],
    },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
