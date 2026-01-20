import { loginToApp, logout } from '../../support/functions/login';
import { openSettingsMenu } from '../../support/functions/settings';

describe('Announcements Feature Test', () => {
    beforeEach(() => {
        loginToApp();
    });

    it('should open and close the announcements sidebar', () => {
        // 1. Click on the Announcements button (megaphone icon next to settings)
        // Using same pattern as settings icon selector
        cy.log('Clicking Announcements button');
        cy.wait(2000); // Wait for stability
        cy.xpath('//button[descendant::*[local-name()="svg" and contains(@class, "tabler-icon-speakerphone")]]')
            .should('be.visible')
            .click();

        // 2. Verify the Announcements sidebar/drawer opens
        cy.log('Verifying Announcements sidebar is open');
        cy.xpath('//section[@role="dialog" and .//h2[contains(., "Announcements")]]')
            .should('be.visible');

        // 3. Verify the title is "Announcements"
        cy.xpath('//h2[contains(@class, "mantine-Drawer-title")]')
            .should('be.visible')
            .and('contain.text', 'Announcements');

        // 4. Verify the content area exists (may show "No announcements available" if empty)
        cy.xpath('//section[@role="dialog"]//p')
            .should('exist');

        // 5. Close the sidebar by clicking the close button
        cy.log('Closing Announcements sidebar');
        cy.xpath('//button[@aria-label="Close drawer"]')
            .should('be.visible')
            .click();

        // 6. Verify the sidebar is closed
        cy.xpath('//section[@role="dialog" and .//h2[contains(., "Announcements")]]')
            .should('not.exist');

        cy.log('Announcements sidebar test completed successfully');
    });

    afterEach(() => {
        // Logout
        openSettingsMenu();
        logout();
    });
});
