/**
 * Chat/Ask Feature Functions
 * Helper functions for the Ask/Chat feature in the Echo application.
 * Updated to use data-testid selectors for robust testing.
 */

// ============= Navigation Functions =============

/**
 * Clicks the Ask button in the project sidebar
 */
export const clickAskButton = () => {
    cy.log('Clicking Ask button');
    cy.get('[data-testid="sidebar-ask-button"]').filter(':visible').first().click();
};

/**
 * Clicks the Library button in the sidebar
 */
export const clickLibraryButton = () => {
    cy.log('Clicking Library button');
    cy.get('[data-testid="sidebar-library-button"]').filter(':visible').first().click();
};

/**
 * Clicks the Report button in the sidebar
 */
export const clickReportButton = () => {
    cy.log('Clicking Report button');
    cy.get('[data-testid="sidebar-report-button"]').filter(':visible').first().click();
};

// ============= Mode Selection =============

/**
 * Selects Specific Details (Deep Dive) mode
 */
export const clickSpecificDetails = () => {
    cy.log('Clicking Specific Details mode');
    cy.get('[data-testid="chat-mode-card-deep_dive"]').filter(':visible').click();
};

/**
 * Selects Overview mode
 */
export const clickOverviewMode = () => {
    cy.log('Clicking Overview mode');
    cy.get('[data-testid="chat-mode-card-overview"]').filter(':visible').click();
};

// ============= Conversation Context Selection =============

/**
 * Selects a conversation for context by ID
 */
export const selectConversationContextById = (conversationId) => {
    cy.log('Selecting conversation context:', conversationId);
    cy.get(`[data-testid="conversation-chat-selection-checkbox-${conversationId}"]`)
        .filter(':visible')
        .first()
        .click({ force: true });
    cy.wait(3000);
};

/**
 * Selects a conversation from the sidebar checkbox for context (first available)
 */
export const selectConversationContext = () => {
    cy.log('Selecting first conversation for context');
    cy.get('[data-testid^="conversation-chat-selection-checkbox-"]')
        .filter(':visible')
        .first()
        .click({ force: true });
    cy.wait(3000);
};

/**
 * Selects all conversations for context
 */
export const selectAllConversationsForContext = () => {
    cy.log('Selecting all conversations for context');
    cy.get('[data-testid="conversation-select-all-button"]').filter(':visible').click();
    cy.get('[data-testid="select-all-confirmation-modal"]').should('be.visible');
    cy.get('[data-testid="select-all-proceed-button"]').click();
    cy.wait(5000);
};

// ============= Chat Interface =============

/**
 * Types a message in the chat message box
 * @param {string} message - The message to type
 */
export const typeMessage = (message) => {
    cy.log('Typing message:', message);
    cy.get('[data-testid="chat-input-textarea"]')
        .should('be.visible')
        .type(message);
};

/**
 * Clicks the Send button to send the message
 */
export const clickSendButton = () => {
    cy.log('Clicking Send button');
    cy.get('[data-testid="chat-send-button"]')
        .filter(':visible')
        .click();
};

/**
 * Stops the AI generation
 */
export const stopGeneration = () => {
    cy.log('Stopping AI generation');
    cy.get('[data-testid="chat-stop-button"]').should('be.visible').click();
};

/**
 * Retries after an error
 */
export const retryChat = () => {
    cy.log('Retrying chat');
    cy.get('[data-testid="chat-retry-button"]').should('be.visible').click();
};

/**
 * Waits for and verifies that an AI response has been received
 */
export const verifyAIResponse = () => {
    cy.log('Waiting for AI response');
    // Wait for thinking text to disappear
    cy.get('[data-testid="chat-thinking-text"]', { timeout: 60000 }).should('not.exist');

    cy.log('Verifying AI response received');
    cy.get('[data-testid="chat-interface"]')
        .should('be.visible')
        .invoke('text')
        .should('have.length.greaterThan', 50);
};

/**
 * Waits for AI to finish typing
 */
export const waitForAITyping = (timeout = 60000) => {
    cy.log('Waiting for AI to finish typing');
    cy.get('[data-testid="chat-thinking-text"]', { timeout }).should('not.exist');
};

// ============= Chat Templates =============

/**
 * Clicks the more templates button
 */
export const clickMoreTemplates = () => {
    cy.log('Clicking more templates');
    cy.get('[data-testid="chat-templates-more-button"]').should('be.visible').click();
};

/**
 * Clicks a static template by name
 */
export const clickStaticTemplate = (templateName) => {
    cy.log('Clicking static template:', templateName);
    cy.get(`[data-testid="chat-template-static-${templateName}"]`).should('be.visible').click();
};

/**
 * Clicks an AI suggestion template
 */
export const clickSuggestionTemplate = (suggestionName) => {
    cy.log('Clicking suggestion template:', suggestionName);
    cy.get(`[data-testid="chat-template-suggestion-${suggestionName}"]`).should('be.visible').click();
};

// ============= Chat Item Management =============

/**
 * Clicks on a specific chat item by ID
 */
export const selectChatById = (chatId) => {
    cy.log('Selecting chat:', chatId);
    cy.get(`[data-testid="chat-item-${chatId}"]`).filter(':visible').click();
};

/**
 * Opens the chat item menu (3 dots)
 */
export const openChatItemMenu = () => {
    cy.log('Opening chat item menu');
    cy.get('[data-testid="chat-item-menu-button"]').filter(':visible').first().click();
};

/**
 * Renames a chat
 */
export const renameChat = () => {
    cy.log('Renaming chat');
    cy.get('[data-testid="chat-item-menu-rename"]').should('be.visible').click();
};

/**
 * Deletes a chat
 */
export const deleteChat = () => {
    cy.log('Deleting chat');
    cy.get('[data-testid="chat-item-menu-delete"]').should('be.visible').click();
};

// ============= Complete Ask Flows =============

/**
 * Complete Ask flow with context selection
 */
export const askWithContext = (message = 'hello') => {
    clickAskButton();
    cy.wait(4000);

    clickSpecificDetails();
    cy.wait(10000);

    selectConversationContext();

    typeMessage(message);
    clickSendButton();

    cy.wait(30000);
    verifyAIResponse();
};

/**
 * Complete Ask flow without context selection (Overview mode)
 */
export const askWithoutContext = (message = 'hello') => {
    clickAskButton();
    cy.wait(4000);

    clickOverviewMode();
    cy.wait(10000);

    typeMessage(message);
    clickSendButton();

    cy.wait(50000);
    verifyAIResponse();
};

/**
 * Ask with specific details but no conversation selected
 */
export const askSpecificNoContext = (message = 'hello') => {
    clickAskButton();
    cy.wait(4000);

    clickSpecificDetails();
    cy.wait(10000);

    // Verify the no conversations alert shows
    cy.get('[data-testid="chat-no-conversations-alert"]').should('be.visible');

    typeMessage(message);
    clickSendButton();

    cy.wait(50000);
    verifyAIResponse();
};
