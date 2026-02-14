import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject, updateProjectName, navigateToHome } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';
import {
    openUploadModal,
    uploadAudioFile,
    clickUploadFilesButton,
    closeUploadModal,
    selectConversation,
    verifyConversationName,
    verifyConversationInList,
    moveConversationToProjectById,
    navigateToProjectOverview
} from '../../support/functions/conversation';

describe('Move Conversation Between Projects Flow', () => {
    let firstProjectId;
    let secondProjectId;
    let movedConversationId;

    const firstProjectName = `Move Target Project ${Date.now()}`;

    beforeEach(() => {
        loginToApp();
    });

    it('should move conversation from second project to first project, verify, delete both projects, and logout', () => {
        // 1. Create first project
        cy.log('Step 1: Creating first project');
        createProject();

        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                firstProjectId = parts[projectIndex + 1];
                cy.log(`Captured first project ID: ${firstProjectId}`);
            }
        });

        // 2. Rename first project with random name (edit flow style)
        cy.log('Step 2: Renaming first project');
        updateProjectName(firstProjectName);
        cy.get('[data-testid="project-breadcrumb-name"]').filter(':visible').first().should('contain.text', firstProjectName);

        // 3. Go to projects home
        cy.log('Step 3: Navigating to projects home');
        navigateToHome();

        // 4. Create second project (source project for upload)
        cy.log('Step 4: Creating second project');
        createProject();

        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                secondProjectId = parts[projectIndex + 1];
                cy.log(`Captured second project ID: ${secondProjectId}`);
            }
        });

        cy.then(() => {
            expect(firstProjectId, 'first project ID').to.be.a('string').and.not.be.empty;
            expect(secondProjectId, 'second project ID').to.be.a('string').and.not.be.empty;
            expect(secondProjectId, 'second project should be different').to.not.equal(firstProjectId);
        });

        // 5. Upload a conversation in second project
        cy.log('Step 5: Opening upload modal');
        openUploadModal();

        cy.log('Step 6: Uploading audio file');
        uploadAudioFile('assets/videoplayback.mp3');

        cy.log('Step 7: Starting upload');
        clickUploadFilesButton();

        cy.log('Step 8: Waiting for upload processing');
        cy.wait(15000);

        cy.log('Step 9: Closing upload modal');
        closeUploadModal();

        // 6. Open uploaded conversation and verify
        cy.log('Step 10: Selecting uploaded conversation');
        selectConversation('videoplayback.mp3');

        cy.log('Step 11: Verifying conversation name before move');
        verifyConversationName('videoplayback.mp3');

        cy.url().then((url) => {
            const parts = url.split('/');
            const conversationIndex = parts.indexOf('conversation');
            if (conversationIndex !== -1 && parts[conversationIndex + 1]) {
                movedConversationId = parts[conversationIndex + 1];
                cy.log(`Captured conversation ID to move: ${movedConversationId}`);
            }
        });

        // 7. Move conversation to first project via modal search + exact project ID radio
        cy.log('Step 12: Moving conversation to first project');
        cy.then(() => {
            expect(firstProjectId, 'first project ID before move').to.be.a('string').and.not.be.empty;
            moveConversationToProjectById(firstProjectName, firstProjectId);
        });

        cy.log('Step 13: Waiting for transfer');
        cy.wait(20000);

        // 8. Verify URL switched to first project
        cy.log('Step 14: Verifying URL changed to first project');
        cy.then(() => {
            expect(firstProjectId, 'first project ID for URL check').to.be.a('string').and.not.be.empty;
            expect(secondProjectId, 'second project ID for URL check').to.be.a('string').and.not.be.empty;
            cy.url().should('include', `/projects/${firstProjectId}/`);
            cy.url().then((currentUrl) => {
                expect(currentUrl).to.not.include(`/projects/${secondProjectId}/`);
                if (movedConversationId) {
                    expect(currentUrl).to.include(`/conversation/${movedConversationId}/`);
                }
                cy.log('Conversation transfer successful: URL now points to first project');
            });
        });

        // 9. Verify conversation is selectable and name is correct in first project
        cy.log('Step 15: Verifying moved conversation in first project list');
        verifyConversationInList('videoplayback.mp3');
        selectConversation('videoplayback.mp3');
        verifyConversationName('videoplayback.mp3');

        cy.log('Step 16: Navigating to Project Overview');
        navigateToProjectOverview();

        // 10. Delete first project
        cy.log('Step 17: Deleting first project');
        cy.then(() => {
            deleteProject(firstProjectId);
        });

        // 11. Open and delete second project
        cy.log('Step 18: Opening and deleting second project');
        cy.then(() => {
            cy.get('main').within(() => {
                cy.get(`a[href*="${secondProjectId}"]`, { timeout: 10000 }).filter(':visible').first().should('be.visible').click();
            });
        });
        cy.wait(3000);
        cy.then(() => {
            deleteProject(secondProjectId);
        });

        // 12. Logout
        cy.log('Step 19: Opening settings and logging out');
        openSettingsMenu();
        logout();
    });
});
