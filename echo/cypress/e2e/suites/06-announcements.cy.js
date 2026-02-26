import { loginToApp, logout } from '../../support/functions/login';
import { openSettingsMenu } from '../../support/functions/settings';

describe('Announcements Feature Test', () => {
    beforeEach(() => {
        loginToApp();
    });

    it('should open and close the announcements sidebar', () => {
        // 1. Click on the announcements icon button
        cy.log('Clicking Announcements button');
        cy.wait(2000); // Wait for header controls to stabilize
        cy.get('[data-testid="announcement-icon-button"]')
            .filter(':visible')
            .first()
            .should('be.visible')
            .click();

        // 2. Verify the Announcements sidebar/drawer opens
        cy.log('Verifying Announcements sidebar is open');
        cy.get('[data-testid="announcement-drawer"]').should('be.visible');

        // 3. Verify the title is "Announcements"
        cy.xpath('//h2[contains(@class, "mantine-Drawer-title")]')
            .should('be.visible')
            .and('contain.text', 'Announcements');

        // 4. Verify the content area exists (may show "No announcements available" if empty)
        cy.xpath('//section[@role="dialog"]//p')
            .should('exist');

        // 5. Close the sidebar by clicking the close button
        cy.log('Closing Announcements sidebar');
        cy.get('[data-testid="announcement-close-drawer-button"]')
            .should('be.visible')
            .click();



        cy.log('Announcements sidebar test completed successfully');
    });

    afterEach(() => {
        // Logout
        openSettingsMenu();
        logout();
    });
});
