import { loginToApp, logout } from '../../support/functions/login';
import { openSettingsMenu, changeLanguage, verifyLanguage } from '../../support/functions/settings';

describe('Multilingual Support Flow', () => {
    beforeEach(() => {
        // dynamic viewport
        // login before each test is fine, or preserve cookies. 
        // For this flow, a fresh login ensures clean state.
        loginToApp();
    });

    it('should successfully switch languages and translate content', () => {
        // 1. Open Settings Menu
        openSettingsMenu();

        // 2. Switch to Spanish (Español)
        // Value identified from browser inspection: 'es-ES'
        changeLanguage('es-ES');

        // 3. Verify Changes
        // URL should contain /es-ES/
        // Logout button should say "Cerrar sesión"
        verifyLanguage('Cerrar sesión', 'es-ES');

        // 4. Verification Check: Page Header
        // Heading level can vary by UI version (h2/h3), so assert by visible heading text.
        cy.contains('h1, h2, h3', /^Proyectos$/).should('be.visible');

        // 5. Switch back to English (Cleanup)
        // Ensure menu is open (verifyLanguage ensures it's open, but let's be safe)
        cy.get('body').then(($body) => {
            if ($body.find('[data-testid="header-language-picker"]').length === 0) {
                openSettingsMenu();
            }
        });

        changeLanguage('en-US');

        // 6. Verify back to English
        verifyLanguage('Logout', 'en-US');
        cy.contains('h1, h2, h3', /^Projects$/).should('be.visible');

        // 7. Logout
        // The menu should be open from the previous step (verifyLanguage ensures it).
        logout();
    });
});
