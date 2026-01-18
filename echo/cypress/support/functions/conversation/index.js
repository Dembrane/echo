/**
 * Conversation Functions
 * Helper functions for managing conversations in the Echo application.
 */

/**
 * Starts a new conversation (placeholder for future implementation)
 */
export const startConversation = () => {
    cy.log('Starting conversation');
};

/**
 * Opens the upload conversation modal
 * Clicks the "Upload" button next to "Conversations" heading in the sidebar
 */
export const openUploadModal = () => {
    cy.log('Opening Upload Conversation Modal');
    // The Upload button is inside the Accordion label next to "Conversations" heading
    // Target the specific button following the h3 containing "Conversations"
    // Use filter(':visible') to get only the visible one (desktop vs mobile)
    cy.xpath('//h3[contains(text(), "Conversations")]/following-sibling::div//button[.//span[text()="Upload"]]')
        .filter(':visible')
        .first()
        .should('be.visible')
        .click();
    cy.wait(1000); // Wait for modal animation
};

/**
 * Uploads an audio file using Cypress selectFile
 * @param {string} filePath - Path to the file relative to cypress folder
 */
export const uploadAudioFile = (filePath) => {
    cy.log('Uploading Audio File:', filePath);
    // The file input is hidden inside the Mantine Dropzone
    // Using force: true because the input is typically hidden
    cy.get('input[type="file"]').selectFile(filePath, { force: true });
    cy.wait(1000); // Wait for file to be processed by the UI
};

/**
 * Clicks the "Upload Files" button after file selection
 * This button appears in the modal after a file has been selected
 */
export const clickUploadFilesButton = () => {
    cy.log('Clicking Upload Files Button');
    // Using XPath to find the button containing "Upload Files" text
    cy.xpath('//button[contains(text(), "Upload Files") or descendant::*[contains(text(), "Upload Files")]]')
        .should('be.visible')
        .click();
};

/**
 * Closes the upload modal using the X button
 */
export const closeUploadModal = () => {
    cy.log('Closing Upload Modal');
    // The close button has the Mantine modal close class
    cy.get('button.mantine-Modal-close').should('be.visible').click();
    cy.wait(500); // Brief wait for modal to close
};

/**
 * Clicks on a conversation by name in the sidebar list
 * @param {string} name - Name/filename of the conversation
 */
export const selectConversation = (name) => {
    cy.log('Selecting Conversation:', name);
    // The conversation is inside a link with href containing "/conversation/"
    // Target the link that contains the filename text
    // Use filter(':visible').first() to handle mobile/desktop duplicates
    cy.xpath(`//a[contains(@href, "/conversation/") and .//p[contains(text(), "${name}")]]`)
        .filter(':visible')
        .first()
        .should('be.visible')
        .click();
    cy.wait(2000); // Wait for right panel/page to load
};

/**
 * Verifies the conversation name in the Edit Conversation section
 * @param {string} expectedName - Expected name value (can be with or without extension)
 */
export const verifyConversationName = (expectedName) => {
    cy.log('Verifying Conversation Name:', expectedName);
    // The Edit Conversation section should have a Name input field
    // Find the input following the "Name" label
    cy.xpath('//*[contains(text(), "Name") and not(self::input) and not(self::script)]/following::input[1]')
        .should('be.visible')
        .invoke('val')
        .then((value) => {
            // The name might be the filename without extension or with extension
            const expectedWithoutExt = expectedName.replace(/\.[^/.]+$/, '');
            expect(value).to.satisfy((v) =>
                v.includes(expectedName) || v.includes(expectedWithoutExt),
                `Expected name to contain "${expectedName}" or "${expectedWithoutExt}", but got "${value}"`
            );
        });
};

/**
 * Clicks on the Transcript tab in the conversation view
 */
export const clickTranscriptTab = () => {
    cy.log('Clicking Transcript Tab');
    // Target the Transcript tab button
    cy.xpath('//button[@role="tab" and .//span[contains(text(), "Transcript")]]')
        .should('be.visible')
        .click();
    cy.wait(2000); // Wait for transcript content to load
};

/**
 * Verifies that the transcript text has at least the specified minimum length
 * @param {number} minLength - Minimum number of characters expected (default 100)
 */
export const verifyTranscriptText = (minLength = 100) => {
    cy.log(`Verifying Transcript has at least ${minLength} characters`);
    // The transcript is inside a Paper component with gray background
    // Target the p element inside the div that follows the timestamp
    // The transcript paragraph is the longer text content
    cy.xpath('//div[contains(@class, "mantine-Paper-root")]//div[contains(@style, "flex")]//div/p[contains(@class, "mantine-Text-root")]')
        .filter(':visible')
        .then(($elements) => {
            // Find the element with the longest text (the actual transcript)
            let longestText = '';
            $elements.each((index, el) => {
                const text = Cypress.$(el).text();
                if (text.length > longestText.length) {
                    longestText = text;
                }
            });
            cy.log(`Transcript text length: ${longestText.length} characters`);
            expect(longestText.length).to.be.at.least(minLength,
                `Expected transcript to have at least ${minLength} characters, but got ${longestText.length}`);
        });
};

/**
 * Clicks on the project name breadcrumb to navigate back to project overview
 * Used when you're in a conversation view and need to return to project settings
 */
export const navigateToProjectOverview = () => {
    cy.log('Navigating to Project Overview via breadcrumb');
    // Click on the "New Project" (or project name) link in the breadcrumb
    // It's the second breadcrumb item after the home icon
    cy.xpath('//a[contains(@href, "/projects/") and contains(@href, "/portal-editor")]//span[contains(@class, "mantine-Title-root")]')
        .filter(':visible')
        .first()
        .should('be.visible')
        .click();
    cy.wait(2000); // Wait for navigation
};

