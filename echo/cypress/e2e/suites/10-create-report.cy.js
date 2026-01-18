/**
 * Report Creation Flow Test Suite
 * 
 * This test verifies the flow of creating a report from an uploaded conversation:
 * 1. Login and create a new project
 * 2. Upload an audio file (replicating Suite 08 flow)
 * 3. Click Report button and Create Report in the modal
 * 4. Wait for processing (40s)
 * 5. Re-open Report to verify generation
 * 6. Cleanup (delete project and logout)
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

describe('Report Creation Flow', () => {
    let projectId;

    beforeEach(() => {
        loginToApp();
    });

    it('should upload audio, create report, and verify report existence', () => {
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

        // 7. Click on the Report button
        cy.log('Step 7: Clicking Report button');
        cy.xpath("//button[contains(., 'Report')]").filter(':visible').click();

        // 8. Click Create Report in the modal
        cy.log('Step 8: Clicking Create Report in modal');
        // Wait for modal and click the "Create Report" button (filled variant)
        cy.get('section[role="dialog"]').should('be.visible');
        cy.xpath("//button[contains(., 'Create Report')]").filter(':visible').click();

        // 9. Wait 20 seconds for processing
        cy.log('Step 9: Waiting 20 seconds for report processing');
        cy.wait(20000);

        // 10. Click on the Report button again to view report
        cy.log('Step 10: Clicking Report button again');
        cy.xpath("//button[contains(., 'Report')]").filter(':visible').click();
        cy.wait(5000); // Wait for report content to load

        // 11. Verify report existence
        cy.log('Step 11: Verifying report existence');
        // Check for Dembrane logo and Report text as per user request
        cy.xpath("//img[@alt='Dembrane Logo']").filter(':visible').should('be.visible');
        cy.xpath("//h1[contains(., 'Dembrane')]").filter(':visible').should('be.visible');
        cy.xpath("//p[contains(., 'Report')]").filter(':visible').should('be.visible');
        cy.log('Report successfully verified');

        // 12. Navigate back to Project Overview
        cy.log('Step 12: Navigating to Project Overview');
        navigateToProjectOverview();

        // 13. Delete the project
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
