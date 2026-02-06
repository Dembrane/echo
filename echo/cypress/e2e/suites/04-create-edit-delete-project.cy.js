import { loginToApp, logout } from '../../support/functions/login';
import { createProject, verifyProjectPage, deleteProject, updateProjectName, navigateToHome } from '../../support/functions/project';
import { openPortalEditor, selectTutorial, addTag, updatePortalContent, changePortalLanguage } from '../../support/functions/portal';
import { openSettingsMenu } from '../../support/functions/settings';

describe('Project Create, Edit, and Delete Flow', () => {
    beforeEach(() => {
        loginToApp();
    });

    it('should create a project, edit its name and portal settings, verify changes, and delete it', () => {
        const uniqueId = Cypress._.random(0, 10000);
        const newProjectName = `New Project_${uniqueId}`;
        const portalTitle = `Title_${uniqueId}`;
        const portalContent = `Content_${uniqueId}`;
        const thankYouContent = `ThankYou_${uniqueId}`;
        const tagName = `Tag_${uniqueId}`;
        const portalLanguage = 'it'; // Italian

        // 1. Create Project
        createProject();

        let createdProjectId;
        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                createdProjectId = parts[projectIndex + 1];
                cy.log(`Working with Project ID: ${createdProjectId}`);

                // 2. Edit Project Name
                updateProjectName(newProjectName);

                // 3. Edit Portal Settings
                openPortalEditor();
                selectTutorial('Basic');
                addTag(tagName);
                updatePortalContent(portalTitle, portalContent, thankYouContent);
                changePortalLanguage(portalLanguage);

                // 4. Return to Home and Verify Name in List
                navigateToHome();
                cy.wait(2000); // Wait for list reload

                // Check if the project list contains the new name
                // Target the main content area (not the mobile sidebar) using the visible desktop sidebar
                cy.get('main').within(() => {
                    cy.get(`a[href*="${createdProjectId}"]`).first().should('contain.text', newProjectName);
                });

                // 5. Enter Project and Verify Changes
                cy.get('main').within(() => {
                    cy.get(`a[href*="${createdProjectId}"]`).first().click();
                });
                cy.wait(3000); // Wait for dashboard load

                // Check Name on Dashboard - verify in the breadcrumb title
                cy.get('[data-testid="project-breadcrumb-name"]').should('contain.text', newProjectName);

                // Check Portal Settings Persistence
                openPortalEditor();
                // Verify Tag - inside mantine-Badge-label span
                cy.get('.mantine-Badge-label').contains(tagName).should('be.visible');
                // Verify Title Input Value
                cy.get('[data-testid="portal-editor-page-title-input"]').should('have.value', portalTitle);
                // Verify Language is set to Italian
                cy.get('[data-testid="portal-editor-language-select"]').should('have.value', portalLanguage);

                // 6. Delete Project
                deleteProject(createdProjectId);
            }
        });

        // 7. Logout
        openSettingsMenu();
        logout();
    });
});
