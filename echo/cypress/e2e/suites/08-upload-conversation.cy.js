/**
 * Upload Conversation Flow Test Suite
 * 
 * This test verifies the complete flow of:
 * 1. Login and create a new project
 * 2. Upload an audio file via the upload conversation modal
 * 3. Wait for processing and close the modal
 * 4. Click on the uploaded conversation and verify its name
 * 5. Verify transcript text
 * 6. Navigate to project overview and delete project
 * 7. Logout
 */

import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';
import {
    openUploadModal,
    uploadAudioFile,
    clickUploadFilesButton,
    closeUploadModal,
    selectConversation,
    verifyConversationName,
    clickTranscriptTab,
    verifyTranscriptText,
    navigateToProjectOverview
} from '../../support/functions/conversation';

describe('Upload Conversation Flow', () => {
    let projectId;

    beforeEach(() => {
        loginToApp();
    });

    it('should upload audio file, verify conversation, delete project, and logout', () => {
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

        // 7. Click on the uploaded conversation in the list
        cy.log('Step 7: Selecting uploaded conversation');
        selectConversation('videoplayback.mp3');

        // 8. Verify the conversation name in Edit Conversation section
        cy.log('Step 8: Verifying conversation name');
        verifyConversationName('videoplayback.mp3');

        // 9. Wait 25 seconds for transcript processing
        cy.log('Step 9: Waiting 25 seconds for transcript processing');
        cy.wait(25000);

        // 10. Click on Transcript tab
        cy.log('Step 10: Clicking Transcript tab');
        clickTranscriptTab();

        // 11. Verify transcript text has at least 100 characters
        cy.log('Step 11: Verifying transcript text');
        verifyTranscriptText(100);

        // 12. Navigate back to project overview via breadcrumb
        cy.log('Step 12: Navigating to Project Overview');
        navigateToProjectOverview();

        // 13. Delete the project (includes clicking Project Settings tab)
        cy.log('Step 13: Deleting project');
        cy.then(() => {
            deleteProject(projectId);
        });

        // 14. Open Settings menu and Logout
        cy.log('Step 14: Opening settings and logging out');
        openSettingsMenu();
        logout();
    });
});

