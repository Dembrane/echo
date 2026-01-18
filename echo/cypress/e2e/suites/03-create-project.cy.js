import { loginToApp, logout } from '../../support/functions/login';
import { createProject, verifyProjectPage, navigateToHome } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';

describe('Project Creation Flow', () => {
    beforeEach(() => {
        loginToApp();
    });

    it('should create a new project, verify details, and navigate home', () => {
        // 1. Create Project
        createProject();

        // 2. Verify Project Details (Name: "New Project")
        verifyProjectPage('New Project');

        // 3. Navigate Back to Home
        navigateToHome();

        // 4. Logout (Ensure settings menu is open first)
        openSettingsMenu();
        logout();
    });
});
