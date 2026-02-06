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
import { createProject, deleteProjectInsideProjectSettings, openProjectSettings, exportProjectTranscripts } from '../../support/functions/project';
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

    it('should upload audio file and download single transcript', () => {
        // 1. Create new project
        cy.log('Step 1: Creating new project');
        createProject();

        // Capture project ID for deletion and next test
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

        // New Step: Download Single Transcript
        cy.log('Step 11b: Downloading single transcript');
        cy.get('[data-testid="transcript-download-button"]').should('be.visible').click();
        const singleTranscriptFile = `transcript-${Date.now()}`;
        cy.get('[data-testid="transcript-download-filename-input"]').should('be.visible').clear().type(singleTranscriptFile);
        cy.get('[data-testid="transcript-download-confirm-button"]').should('be.visible').click();

        // Wait and Verify Single Download
        cy.wait(5000);
        cy.task('findFile', { dir: 'cypress/downloads', ext: '.md' }).then((filePath) => { // Assuming MD or similar
            // Robust check: ensure it matches our random name if possible, or just latest
            cy.log('Found downloaded transcript:', filePath);
            if (filePath) cy.task('deleteFile', filePath);
        });
    });

    it('should download all transcripts (export project) and clean up', () => {
        // Ensure we have a project ID from the previous test
        expect(projectId).to.not.be.undefined;

        // Navigate to the project overview
        cy.log('Navigating to Project Overview for Export');
        // Simple navigation assuming finding the link works, or direct visit
        // Using verifyLogin-style navigation or direct URL
        cy.visit(`/en-US/projects/${projectId}/overview`);

        // Export Transcripts and Verify Zip
        cy.log('Step 12: Exporting project transcripts');
        // Ensure we are on the Project Settings tab where the export button is located
        openProjectSettings();

        exportProjectTranscripts();

        // Wait for download to complete (arbitrary wait or until file exists)
        cy.wait(5000);

        // Find and verify the downloaded zip file
        cy.task('findFile', { dir: 'cypress/downloads', ext: '.zip' }).then((filePath) => {
            expect(filePath).to.not.be.null;
            cy.log('Found downloaded file:', filePath);

            // Cleanup: Delete the downloaded zip file
            cy.task('deleteFile', filePath);
        });

        // 13. Delete the project (includes clicking Project Settings tab)
        cy.log('Step 13: Deleting project');
        cy.then(() => {
            // We are already on settings tab mostly, but helper handles scrolling
            deleteProjectInsideProjectSettings(projectId);
        });

        // 14. Open Settings menu and Logout
        cy.log('Step 14: Opening settings and logging out');
        openSettingsMenu();
        logout();
    });
});

