// This file is processed and loaded automatically before your test files.
// This is a great place to put global configuration and behavior that modifies Cypress.

import './commands'
require('cypress-xpath')

beforeEach(() => {
    // Check for CLI viewport overrides first (--config viewportWidth=X,viewportHeight=Y)
    const cliWidth = Cypress.config('viewportWidth');
    const cliHeight = Cypress.config('viewportHeight');

    // If CLI overrides are not the default (1280x720), use them
    const defaultWidth = 1280;
    const defaultHeight = 720;

    if (cliWidth !== defaultWidth || cliHeight !== defaultHeight) {
        cy.viewport(cliWidth, cliHeight);
        cy.log(`Viewport set from CLI: ${cliWidth}x${cliHeight}`);
    } else {
        // Otherwise, use device-based viewport from env config
        const device = Cypress.env('device') || 'desktop';
        const viewports = Cypress.env('viewports');

        if (viewports && viewports[device]) {
            const { width, height } = viewports[device];
            cy.viewport(width, height);
            cy.log(`Viewport set to ${device} (${width}x${height})`);
        } else {
            cy.log(`Using default viewport: ${defaultWidth}x${defaultHeight}`);
        }
    }
});
