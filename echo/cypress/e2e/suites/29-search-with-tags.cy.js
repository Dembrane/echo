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
    navigateToProjectOverview,
    searchConversation,
    toggleFilterOptions
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
        navigateToProjectOverview();

        // 3. Upload Conversation (Manual Flow)
        cy.log('Step 9: Uploading audio file');
        openUploadModal();
        uploadAudioFile('assets/sampleaudio.mp3');
        clickUploadFilesButton();

        // Wait for processing
        cy.log('Step 10: Waiting 15 seconds for file processing');
        cy.wait(15000);
        closeUploadModal();

        cy.log('Step 11: Navigating to Project Overview');
        navigateToProjectOverview();

        // 5. Search by auto-formatted conversation name and verify exactly one result
        cy.log('Step 12: Searching for auto-formatted "- videoplayback.mp3"');
        searchConversation('- videoplayback.mp3');

        cy.log('Step 13: Verifying only one search result is returned');
        cy.get('[data-testid^="conversation-item-"]').filter(':visible').should('have.length', 1);
        cy.get('[data-testid^="conversation-item-"]').filter(':visible').first()
            .should('contain.text', '- videoplayback.mp3');
        cy.log('Search test successful: exactly one conversation found for "- videoplayback.mp3"');

        // Clear search so tag-filter validation is independent
        cy.get('[data-testid="conversation-search-input"]').filter(':visible').first().clear();

        // 6. Open tags filter, select both created tags, then close menu
        cy.log('Step 14: Opening filter options and tags filter');
        cy.get('body').then(($body) => {
            if ($body.find('[data-testid="conversation-filter-tags-button"]:visible').length === 0) {
                toggleFilterOptions();
            }
        });
        cy.get('[data-testid="conversation-filter-tags-button"]').filter(':visible').first().click();

        cy.log('Step 15: Selecting both created tags in dropdown');
        cy.get('[data-menu-dropdown="true"]').filter(':visible').last().within(() => {
            cy.contains('label', tag1).click();
            cy.contains('label', tag2).click();
        });

        // Re-click tags button to close dropdown
        cy.get('[data-testid="conversation-filter-tags-button"]').filter(':visible').first().click();

        // 7. Verify tag filter returns exactly one conversation: - videoplayback.mp3
        cy.log('Step 16: Verifying tag-filtered result count and conversation name');
        cy.get('[data-testid^="conversation-item-"]').filter(':visible').should('have.length', 1);
        cy.get('[data-testid^="conversation-item-"]').filter(':visible').first()
            .should('contain.text', '- videoplayback.mp3');
        cy.log('Tag filter test successful: only "- videoplayback.mp3" is shown');



        // 5. Cleanup
        cy.log('Step 17: Cleanup - Deleting Project');
        navigateToProjectOverview();
        cy.then(() => {
            if (projectId) {
                deleteProject(projectId);
            }
        });

        // Logout
        cy.log('Step 18: Logging out');
        openSettingsMenu();
        logout();
    });
});
