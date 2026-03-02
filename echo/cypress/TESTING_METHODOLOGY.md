# Testing Methodology

This document serves as a guide on how our Cypress tests are written, how to start writing a new test, the purpose of essential Cypress configuration files, and how to execute test suites via the command line.

---

## 1. How Tests Are Written

Our End-to-End (E2E) tests are written using the **Cypress** framework using JavaScript. Tests are structured using the standard Mocha syntax: `describe()` blocks for test suites and `it()` blocks for individual test cases.

### General Structure:
```javascript
describe('Feature Name Flow', () => {
  beforeEach(() => {
    // Code to run before every test, e.g., logging in, setting cookies, or visiting a URL.
  });

  it('should behave in a specific way under these conditions', () => {
    // 1. Arrange: Setup state, intercept network requests (cy.intercept).
    // 2. Act: Interact with the UI (cy.get().click(), cy.get().type()).
    // 3. Assert: Verify the expected outcome (cy.get().should('be.visible')).
  });
});
```

### Best Practices Enforced:
- **Data-Cy Attributes:** Whenever possible, use `data-cy` attributes to select elements (`cy.get('[data-cy="submit-btn"]')`) rather than unstable CSS classes or IDs.
- **Interception:** Mock or wait on network requests using `cy.intercept()` to prevent flaky tests caused by variable network speeds.
- **Isolation:** Tests should not rely on the state left by previous tests. Clean up state or use proper teardown logic.

---

## 2. How to Start Writing a Test

1. **Identify the Flow:** Figure out exactly what user journey you want to automate. Write it out in plain English step-by-step.
2. **Create the Spec File:** Inside `cypress/e2e/suites/`, create a new `.cy.js` file following the sequential naming convention (e.g., `36-new-feature.cy.js`).
3. **Use the App:** Go through the flow manually in your browser with Developer Tools open. Take note of the URLs, network requests, and DOM elements you need to interact with.
4. **Draft the Test:** Write the `describe` and `it` blocks.
5. **Run the Runner:** Open the Cypress UI using `npx cypress open`.
6. **Iterate:** Run your specific test file in the Cypress UI, watch it execute, and fix any failing steps until the entire journey turns green.

---

## 3. What is the Index File?

In Cypress, the "index" file (historically `cypress/support/index.js`, now typically `cypress/support/e2e.js`) acts as a global configuration and entry point that runs **before every single spec file**.

**Purpose:**
- **Global Commands:** It imports `cypress/support/commands.js` where custom Cypress commands (like `cy.login()`) are defined.
- **Global Behaviors:** It is the ideal place to handle global behaviors, such as suppressing unhandled exceptions from failing tests, preserving cookies between tests, or setting up global `beforeEach` hooks that apply universally.

---

## 4. Running Tests via Command Line

You can run your tests headless (in the background) or headed (with a browser window) using the terminal.

### Dissecting the Cypress Run Command

When you see a command like this:

```powershell
$env:CYPRESS_viewportWidth=1440; $env:CYPRESS_viewportHeight=900; npx cypress run --spec "e2e/suites/04-create-edit-delete-project.cy.js" --env version=staging --browser edge --headed --no-exit
```

Here is exactly what each part means:

- `$env:CYPRESS_viewportWidth=1440; $env:CYPRESS_viewportHeight=900;`: These are PowerShell commands that set environmental variables for the current session. They force Cypress to open the browser window at a specific resolution (1440x900), which is essential to ensure responsive UIs render consistently.
- `npx cypress run`: The core command telling Node Package Runner (npx) to execute Cypress in CLI mode.
- `--spec "e2e/suites/04-create-edit-delete-project.cy.js"`: Instead of running all 35 tests, this targets one specific file to run. 
- `--env version=staging`: Passes custom environment variables into the Cypress test itself. Inside the test, `Cypress.env('version')` will return `'staging'`, allowing tests to adapt to different backend environments or logic.
- `--browser edge`: Tells Cypress to specifically use the Microsoft Edge browser instead of the default Electron browser.
- `--headed`: Forces Cypress to physically open the browser window so you can watch what it is doing (by default `cypress run` operates headlessly without UI).
- `--no-exit`: Prevents the browser window from closing automatically after the test finishes. This is extremely useful for debugging, as it leaves the DOM exactly as it was at the end of the test.

### Running Entire Test Suites

If you want to run all the tests in a directory rather than a single file, you can pass a glob pattern or point to a directory:

```powershell
# Run all tests in the suites folder headlessly
npx cypress run --spec "cypress/e2e/suites/**/*.cy.js"
```

Or, simple shorthand:

```powershell
npx cypress run
```
*(This will run all specs defined in your `cypress.config.js` default spec pattern).*
