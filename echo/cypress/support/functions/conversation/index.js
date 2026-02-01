/**
 * Conversation Functions
 * Helper functions for managing conversations in the Echo application.
 * Updated to use data-testid selectors for robust testing.
 */

// ============= Upload Functions =============

/**
 * Opens the upload conversation modal
 */
export const openUploadModal = () => {
    cy.log('Opening Upload Conversation Modal');
    cy.get('[data-testid="conversation-upload-button"]')
        .filter(':visible')
        .first()
        .should('be.visible')
        .click();
    cy.wait(1000);
};

/**
 * Uploads an audio file using Cypress selectFile
 * @param {string} filePath - Path to the file relative to cypress folder
 */
export const uploadAudioFile = (filePath) => {
    cy.log('Uploading Audio File:', filePath);
    cy.get('[data-testid="conversation-upload-modal"]').should('be.visible');
    cy.get('[data-testid="conversation-upload-dropzone"]')
        .find('input[type="file"]')
        .selectFile(filePath, { force: true });
    cy.wait(1000);
};

/**
 * Clicks the "Upload Files" button after file selection
 */
export const clickUploadFilesButton = () => {
    cy.log('Clicking Upload Files Button');
    cy.get('[data-testid="conversation-upload-files-button"]')
        .should('be.visible')
        .click();
};

/**
 * Closes the upload modal
 */
export const closeUploadModal = () => {
    cy.log('Closing Upload Modal');
    cy.get('[data-testid="conversation-upload-close-button"]').should('be.visible').click();
    cy.wait(500);
};

/**
 * Cancels the upload before it starts
 */
export const cancelUpload = () => {
    cy.log('Canceling Upload');
    cy.get('[data-testid="conversation-upload-cancel-button"]').should('be.visible').click();
};

/**
 * Retries a failed upload
 */
export const retryUpload = () => {
    cy.log('Retrying Upload');
    cy.get('[data-testid="conversation-upload-retry-button"]').should('be.visible').click();
};

/**
 * Goes back to file selection
 */
export const backToFileSelection = () => {
    cy.log('Going back to file selection');
    cy.get('[data-testid="conversation-upload-back-button"]').should('be.visible').click();
};

// ============= Conversation Selection & Navigation =============

/**
 * Clicks on a conversation by ID in the sidebar list
 * @param {string} conversationId - ID of the conversation
 */
export const selectConversationById = (conversationId) => {
    cy.log('Selecting Conversation by ID:', conversationId);
    cy.get(`[data-testid="conversation-item-${conversationId}"]`)
        .filter(':visible')
        .first()
        .should('be.visible')
        .click();
    cy.wait(2000);
};

/**
 * Clicks on a conversation by name in the sidebar list
 * Handles cases where the name has a prefix like " - filename"
 * @param {string} name - Name/filename of the conversation
 */
export const selectConversation = (name) => {
    cy.log('Selecting Conversation:', name);

    // Try data-testid first, then fallback to XPath for robustness
    cy.get('body').then(($body) => {
        // Check if data-testid conversation items exist
        const hasDataTestid = $body.find('[data-testid^="conversation-item-"]').length > 0;

        if (hasDataTestid) {
            // Use data-testid - the name may have a prefix like " - "
            cy.get('[data-testid^="conversation-item-"]')
                .filter(':visible')
                .contains(name)
                .first()
                .closest('[data-testid^="conversation-item-"]')
                .click();
        } else {
            // Fallback to XPath for links containing conversation href
            cy.xpath(`//a[contains(@href, "/conversation/") and .//*[contains(text(), "${name}")]]`)
                .filter(':visible')
                .first()
                .click();
        }
    });

    cy.wait(2000);
};

// ============= Conversation Overview Functions =============

/**
 * Verifies the conversation name in the Edit Conversation section
 */
export const verifyConversationName = (expectedName) => {
    cy.log('Verifying Conversation Name:', expectedName);
    cy.get('[data-testid="conversation-edit-name-input"]')
        .should('be.visible')
        .invoke('val')
        .then((value) => {
            const expectedWithoutExt = expectedName.replace(/\.[^/.]+$/, '');
            expect(value).to.satisfy((v) =>
                v.includes(expectedName) || v.includes(expectedWithoutExt)
            );
        });
};

/**
 * Updates the conversation name
 */
export const updateConversationName = (newName) => {
    cy.log('Updating Conversation Name to:', newName);
    cy.get('[data-testid="conversation-edit-name-input"]')
        .should('be.visible')
        .clear()
        .type(newName);
    cy.wait(2000); // Wait for auto-save
};

/**
 * Selects tags for the conversation
 */
export const selectConversationTags = (tags) => {
    cy.log('Selecting tags:', tags);
    cy.get('[data-testid="conversation-edit-tags-select"]').should('be.visible').click();
    tags.forEach(tag => {
        cy.contains(tag).click();
    });
};

// ============= Summary Functions =============

/**
 * Generates a summary for the conversation
 */
export const generateSummary = () => {
    cy.log('Generating Summary');
    cy.get('[data-testid="conversation-overview-generate-summary-button"]')
        .should('be.visible')
        .click();
    cy.wait(10000); // Wait for AI generation
};

/**
 * Regenerates the summary
 */
export const regenerateSummary = () => {
    cy.log('Regenerating Summary');
    cy.get('[data-testid="conversation-overview-regenerate-summary-button"]')
        .should('be.visible')
        .click();
    cy.wait(10000);
};

/**
 * Copies the summary to clipboard
 */
export const copySummary = () => {
    cy.log('Copying Summary');
    cy.get('[data-testid="conversation-overview-copy-summary-button"]')
        .should('be.visible')
        .click();
};

// ============= Danger Zone Functions =============

/**
 * Moves conversation to another project
 */
export const moveConversation = (projectSearchTerm) => {
    cy.log('Moving conversation to:', projectSearchTerm);
    cy.get('[data-testid="conversation-move-button"]').should('be.visible').click();
    cy.get('[data-testid="conversation-move-modal"]').should('be.visible');
    cy.get('[data-testid="conversation-move-search-input"]').type(projectSearchTerm);
    cy.wait(1000);
    // Click on first matching project
    cy.get('[data-testid^="conversation-move-project-radio-"]').first().click();
    cy.get('[data-testid="conversation-move-submit-button"]').click();
    cy.wait(3000);
};

/**
 * Downloads the conversation audio
 */
export const downloadAudio = () => {
    cy.log('Downloading Audio');
    cy.get('[data-testid="conversation-download-audio-button"]').should('be.visible').click();
};

/**
 * Deletes the conversation
 */
export const deleteConversation = () => {
    cy.log('Deleting Conversation');
    cy.get('[data-testid="conversation-delete-button"]').should('be.visible').click();
    cy.wait(2000);
};

// ============= Transcript Functions =============

/**
 * Clicks on the Transcript tab
 */
export const clickTranscriptTab = () => {
    cy.log('Clicking Transcript Tab');
    cy.contains('button[role="tab"]', 'Transcript').should('be.visible').click();
    cy.wait(2000);
};

/**
 * Verifies transcript has content
 */
export const verifyTranscriptText = (minLength = 100) => {
    cy.log(`Verifying Transcript has at least ${minLength} characters`);
    cy.get('[data-testid^="transcript-chunk-"]')
        .should('exist')
        .then(($chunks) => {
            let totalText = '';
            $chunks.each((i, el) => {
                totalText += Cypress.$(el).text();
            });
            expect(totalText.length).to.be.at.least(minLength);
        });
};

/**
 * Downloads the transcript
 */
export const downloadTranscript = (filename) => {
    cy.log('Downloading Transcript');
    cy.get('[data-testid="transcript-download-button"]').should('be.visible').click();
    cy.get('[data-testid="transcript-download-modal"]').should('be.visible');
    if (filename) {
        cy.get('[data-testid="transcript-download-filename-input"]').clear().type(filename);
    }
    cy.get('[data-testid="transcript-download-confirm-button"]').click();
    cy.wait(2000);
};

/**
 * Copies the transcript to clipboard
 */
export const copyTranscript = () => {
    cy.log('Copying Transcript');
    cy.get('[data-testid="transcript-copy-button"]').should('be.visible').click();
};

/**
 * Retranscribes the conversation
 */
export const retranscribeConversation = (newName, enablePII = false) => {
    cy.log('Retranscribing Conversation');
    cy.get('[data-testid="transcript-retranscribe-button"]').should('be.visible').click();
    cy.get('[data-testid="transcript-retranscribe-modal"]').should('be.visible');
    if (newName) {
        cy.get('[data-testid="transcript-retranscribe-name-input"]').clear().type(newName);
    }
    if (enablePII) {
        cy.get('[data-testid="transcript-retranscribe-pii-toggle"]').click();
    }
    cy.get('[data-testid="transcript-retranscribe-confirm-button"]').click();
    cy.wait(5000);
};

/**
 * Toggles the audio player visibility in transcript
 */
export const toggleTranscriptAudioPlayer = () => {
    cy.log('Toggling Audio Player');
    cy.get('[data-testid="transcript-show-audio-player-toggle"]').click();
};

// ============= Filter & Search Functions =============

/**
 * Searches for a conversation
 */
export const searchConversation = (searchTerm) => {
    cy.log('Searching for conversation:', searchTerm);
    cy.get('[data-testid="conversation-search-input"]')
        .should('be.visible')
        .clear()
        .type(searchTerm);
};

/**
 * Clears the conversation search
 */
export const clearConversationSearch = () => {
    cy.log('Clearing conversation search');
    cy.get('[data-testid="conversation-search-clear-button"]').should('be.visible').click();
};

/**
 * Toggles filter options visibility
 */
export const toggleFilterOptions = () => {
    cy.log('Toggling filter options');
    cy.get('[data-testid="conversation-filter-options-toggle"]').click();
};

/**
 * Filters by verified only
 */
export const filterVerifiedOnly = () => {
    cy.log('Filtering verified only');
    cy.get('[data-testid="conversation-filter-verified-button"]').click();
};

/**
 * Resets all filters
 */
export const resetFilters = () => {
    cy.log('Resetting all filters');
    cy.get('[data-testid="conversation-filter-reset-button"]').should('be.visible').click();
};

/**
 * Selects all conversations
 */
export const selectAllConversations = () => {
    cy.log('Selecting all conversations');
    cy.get('[data-testid="conversation-select-all-button"]').should('be.visible').click();
    cy.get('[data-testid="select-all-confirmation-modal"]').should('be.visible');
    cy.get('[data-testid="select-all-proceed-button"]').click();
    cy.wait(3000);
};

// ============= Legacy Functions (for backwards compatibility) =============

export const startConversation = () => {
    cy.log('Starting conversation');
};

export const navigateToProjectOverview = () => {
    cy.log('Navigating to Project Overview via breadcrumb');
    cy.get('[data-testid="project-breadcrumb-name"]')
        .filter(':visible')
        .first()
        .click();
    cy.wait(2000);
};
