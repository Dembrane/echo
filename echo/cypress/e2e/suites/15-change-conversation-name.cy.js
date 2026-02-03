/**
 * Change Conversation Name Flow Test Suite
 * 
 * This test verifies the flow of:
 * 1. Login and create a new project
 * 2. Upload an audio file via the upload conversation modal
 * 3. Select the conversation
 * 4. Update the conversation name
 * 5. Verify the name update in the list
 * 6. DELETE project and Logout
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
    updateConversationName,
    navigateToProjectOverview,
    verifyConversationInList
} from '../../support/functions/conversation';

describe('Change Conversation Name Flow', () => {
    let projectId;
    const randomName = `Updated Name ${Math.floor(Math.random() * 10000)}`;

    beforeEach(() => {
        loginToApp();
    });

    it('should upload audio, change conversation name, verify in list, delete project, and logout', () => {
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

        // 8. Update conversation name using the random name
        cy.log('Step 8: Updating conversation name');
        updateConversationName(randomName);

        // 9. Wait 10 seconds for auto-save
        cy.log('Step 9: Waiting 10 seconds for auto-save');
        cy.wait(10000);

        // 10. Verify name in the input field
        cy.log('Step 10: Verifying updated name in input');
        verifyConversationName(randomName);

        // 11. Navigate back to project overview via breadcrumb
        cy.log('Step 11: Navigating to Project Overview');
        navigateToProjectOverview();

        // 12. Verify the updated name appears in the list
        cy.log('Step 12: Verifying updated name in conversation list');
        verifyConversationInList(randomName);

        // 13. Delete the project (includes clicking Project Settings tab)
        cy.log('Step 13: Deleting project');
        cy.then(() => {
            if (projectId) {
                deleteProject(projectId);
            }
        });

        // 14. Open Settings menu and Logout
        cy.log('Step 14: Opening settings and logging out');
        openSettingsMenu();
        logout();
    });
});
