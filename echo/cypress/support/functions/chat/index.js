/**
 * Ask Feature Functions
 * Helper functions for the Ask/Chat feature in the Echo application.
 */

/**
 * Clicks the Ask button in the project sidebar
 */
export const clickAskButton = () => {
    cy.log('Clicking Ask button');
    cy.xpath("//button[.//p[text()='Ask']]").filter(':visible').click();
};

/**
 * Clicks the Specific Details option in the Ask modal
 */
export const clickSpecificDetails = () => {
    cy.log('Clicking Specific Details');
    cy.xpath("//button[.//p[text()='Specific Details']]").filter(':visible').click();
};

/**
 * Selects a conversation from the sidebar checkbox for context
 */
export const selectConversationContext = () => {
    cy.log('Selecting conversation for context');
    // Click on the checkbox next to the uploaded conversation in the sidebar
    cy.xpath("//div[contains(@class, 'mantine-Checkbox')]//input[@type='checkbox']")
        .filter(':visible')
        .first()
        .click({ force: true });
    cy.wait(3000); // Wait for context loading
};

/**
 * Types a message in the chat message box
 * @param {string} message - The message to type
 */
export const typeMessage = (message) => {
    cy.log('Typing message:', message);
    cy.xpath("//textarea[@placeholder='Type a message...']")
        .should('be.visible')
        .type(message);
};

/**
 * Clicks the Send button to send the message
 */
export const clickSendButton = () => {
    cy.log('Clicking Send button');
    cy.xpath("//button[contains(@class, 'mantine-Button-root') and .//span[text()='Send']]")
        .filter(':visible')
        .click();
};

/**
 * Waits for and verifies that an AI response has been received
 * Uses the XPath for the AI response message container
 */
export const verifyAIResponse = () => {
    cy.log('Waiting for AI response');
    // Wait for AI response message to appear at div[4] position
    cy.xpath("//main//section//div[2]/div/div[4]/div")
        .filter(':visible')
        .should('exist');

    cy.log('Verifying AI response received');
    cy.xpath("//main//section//div[2]/div/div[4]/div")
        .filter(':visible')
        .invoke('text')
        .should('have.length.greaterThan', 10); // AI response should have text
};

/**
 * Complete Ask flow with context selection
 * Clicks Ask -> Specific Details -> Selects context -> Types message -> Sends -> Verifies response
 * @param {string} message - The message to send (default: 'hello')
 */
export const askWithContext = (message = 'hello') => {
    clickAskButton();
    cy.wait(4000);

    clickSpecificDetails();
    cy.wait(30000);

    selectConversationContext();

    typeMessage(message);
    clickSendButton();

    cy.wait(30000);
    verifyAIResponse();
};

/**
 * Complete Ask flow without context selection
 * Clicks Ask -> Specific Details -> Types message -> Sends -> Verifies response
 * @param {string} message - The message to send (default: 'hello')
 */
export const askWithoutContext = (message = 'hello') => {
    clickAskButton();
    cy.wait(4000);

    clickSpecificDetails();
    cy.wait(30000);

    typeMessage(message);
    clickSendButton();

    cy.wait(50000);
    verifyAIResponse();
};
