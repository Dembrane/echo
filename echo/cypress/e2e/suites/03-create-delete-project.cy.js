import { loginToApp, logout } from '../../support/functions/login';
import { createProject, verifyProjectPage, deleteProject } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';

describe('Project Creation and Deletion Flow', () => {
    beforeEach(() => {
        loginToApp();
    });

    it('should create a project and then immediately delete it', () => {
        let createdProjectId;

        // 1. Create Project
        createProject();

        // Capture the ID from the current URL to pass to delete function
        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                createdProjectId = parts[projectIndex + 1];
                cy.log(`Captured ID for deletion: ${createdProjectId}`);

                // 2. Verify Project Page (Optional here, but good practice)
                verifyProjectPage('New Project');

                // 3. Delete Project
                // This function handles navigation to settings, deletion, and verification
                deleteProject(createdProjectId);
            } else {
                throw new Error('Could not capture Project ID from URL');
            }
        });

        // 4. Logout (from the Projects Dashboard)
        // Ensure settings menu is open first
        openSettingsMenu();
        logout();
    });
});
