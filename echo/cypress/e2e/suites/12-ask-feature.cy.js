/**
 * Ask Feature Flow Test Suite
 * 
 * This test verifies the complete flow of using the Ask feature:
 * 1. Login and create a new project
 * 2. Upload an audio file (replicating Suite 08/10 flow)
 * 3. Use Ask feature with context selection
 * 4. Verify AI response
 * 5. Navigate to Home, delete project, and logout
 */

import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';
import {
    openUploadModal,
    uploadAudioFile,
    clickUploadFilesButton,
    closeUploadModal,
    navigateToProjectOverview
} from '../../support/functions/conversation';
import { askWithContext } from '../../support/functions/chat';

describe('Ask Feature Flow', () => {
    let projectId;

    beforeEach(() => {
        loginToApp();
    });

    it('should upload audio, use Ask feature with Specific Details, verify response, delete project and logout', () => {
        // 1. Create new project
        cy.log('Step 1: Creating new project');
        createProject();

        // Capture project ID for deletion
        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                projectId = parts[projectIndex + 1];
                cy.log('Captured Project ID:', projectId);
            }
        });

        // 2. Open Upload Conversation modal
        cy.log('Step 2: Opening upload modal');
        openUploadModal();

        // 3. Upload the audio file from cypress assets
        cy.log('Step 3: Uploading audio file');
        uploadAudioFile('assets/videoplayback.mp3');

        // 4. Click Upload Files button to start the upload
        cy.log('Step 4: Clicking Upload Files button');
        clickUploadFilesButton();

        // 5. Wait 15 seconds for processing
        cy.log('Step 5: Waiting 15 seconds for file processing');
        cy.wait(15000);

        // 6. Close the upload modal
        cy.log('Step 6: Closing upload modal');
        closeUploadModal();

        // 7. Use Ask feature with context selection
        cy.log('Step 7: Using Ask feature with context');
        askWithContext('hello');

        // 8. Navigate to Project Overview
        cy.log('Step 8: Navigating to Project Overview');
        navigateToProjectOverview();

        // 9. Delete the project
        cy.log('Step 9: Deleting project');
        cy.then(() => {
            deleteProject(projectId);
        });

        // 10. Open Settings menu and Logout
        cy.log('Step 10: Opening settings and logging out');
        openSettingsMenu();
        logout();
    });
});
