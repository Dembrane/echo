/**
 * Project Tags & Conversation Flow
 * 
 * This test verifies the flow of:
 * 1. Login and create a new project
 * 2. Add tags to the project in Portal Editor
 * 3. Upload an audio file via the upload conversation modal (Dashboard)
 * 4. Verify tags are selectable in the conversation overview
 * 5. Verify selected tags are visible
 * 6. DELETE project and Logout
 */

import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';
import { openPortalEditor, addTag } from '../../support/functions/portal';
import {
    openUploadModal,
    uploadAudioFile,
    clickUploadFilesButton,
    closeUploadModal,
    selectConversation,
    selectConversationTags,
    verifySelectedTags,
    navigateToProjectOverview
} from '../../support/functions/conversation';

describe('Project Tags & Conversation Flow', () => {
    let projectId;
    const tag1 = 'TagOne';
    const tag2 = 'TagTwo';

    beforeEach(() => {
        loginToApp();
    });

    it('should create project with tags, upload audio, and verify tags in conversation', () => {
        // 1. Create new project
        cy.log('Step 1: Creating new project');
        createProject();

        // Capture project ID
        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                projectId = parts[projectIndex + 1];
                cy.log('Captured Project ID:', projectId);
            }
        });

        // 2. Add Tags in Portal Editor
        cy.log('Step 2: Adding tags in Portal Editor');
        openPortalEditor();
        addTag(tag1);
        addTag(tag2);

        // Return to Project Overview to upload file
        cy.log('Step 3: Returning to Project Overview');
        navigateToProjectOverview();

        // 3. Upload Conversation (Manual Flow)
        cy.log('Step 4: Uploading audio file');
        openUploadModal();
        uploadAudioFile('assets/videoplayback.mp3');
        clickUploadFilesButton();

        // Wait for processing
        cy.log('Step 5: Waiting 15 seconds for file processing');
        cy.wait(15000);
        closeUploadModal();

        // 4. Select Conversation & Verify Tags
        cy.log('Step 6: Selecting uploaded conversation');
        selectConversation('videoplayback.mp3');

        // Verify tags input and select tags
        cy.log('Step 7: Selecting and verifying tags');
        selectConversationTags([tag1, tag2]);

        // Verify they are shown as selected
        cy.log('Step 8: Verifying selected tags visibility');
        verifySelectedTags([tag1, tag2]);

        // 5. Cleanup
        cy.log('Step 9: Cleanup - Deleting Project');
        navigateToProjectOverview();
        cy.then(() => {
            if (projectId) {
                deleteProject(projectId);
            }
        });

        // Logout
        cy.log('Step 10: Logging out');
        openSettingsMenu();
        logout();
    });
});
