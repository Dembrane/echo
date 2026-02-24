import { loginToApp, logout } from '../../support/functions/login';
import { createProject, verifyProjectPage, deleteProject, updateProjectName, navigateToHome } from '../../support/functions/project';
import { openPortalEditor, selectTutorial, addTag, updatePortalContent, changePortalLanguage } from '../../support/functions/portal';
import { openSettingsMenu } from '../../support/functions/settings';

describe('Project Clone Flow', () => {
    beforeEach(() => {
        loginToApp();
    });

    it('project clone test', () => {
        const uniqueId = Cypress._.random(0, 10000);
        const projectName = 'Project To Clone';
        const clonedProjectName = `Clone Test_${uniqueId}`;

        // 1. Create project
        createProject();
        updateProjectName(projectName);

        let projectId;
        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                projectId = parts[projectIndex + 1];
                cy.log(`Project ID: ${projectId}`);
            }
        }).then(() => {
            // 2. Go to project settings
            // We ensure we are on the Overview tab where the actions are derived
            cy.get('[data-testid="project-overview-tab-overview"]').click();

            // 3. Instead of clicking delete, click on clone button
            cy.get('[data-testid="project-actions-clone-button"]').click();

            // 4. Modal interaction
            // Handle project-clone-name-input
            cy.get('[data-testid="project-clone-name-input"]').should('be.visible').clear().type(clonedProjectName);

            // Click project-clone-confirm-button
            cy.get('[data-testid="project-clone-confirm-button"]').click();

            // 5. Wait for 10 seconds
            cy.wait(10000);

            // 6. Check both the link whether the part between projects and portal editor changed
            cy.url().then((currentUrl) => {
                const parts = currentUrl.split('/');
                const projectIndex = parts.indexOf('projects');
                const newProjectId = parts[projectIndex + 1];

                cy.log(`New Project ID: ${newProjectId}`);

                // Assert ID has changed
                expect(newProjectId).to.not.equal(projectId);

                return cy.wrap(newProjectId);
            }).then((newProjectId) => {
                // 7. Check if the project-breadcrumb-name span text is updated to the newly given name
                cy.get('[data-testid="project-breadcrumb-name"]').should('contain.text', clonedProjectName);

                // 8. Delete the cloned project
                deleteProject(newProjectId);

                // 9. Search/Open the original project
                // We find the project in the list by looking for its link
                cy.get('main').find(`a[href*="${projectId}"]`).first().click();

                // 11. Delete the original project
                deleteProject(projectId);

                // 12. Logout
                openSettingsMenu();
                logout();
            });
        });
    });
});
