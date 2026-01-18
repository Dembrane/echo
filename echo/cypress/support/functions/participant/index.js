/**
 * Participant Portal Functions
 * Helper functions for the participant recording flow in the Echo portal.
 */

/**
 * Placeholder for adding participant details
 */
export const addParticipant = (details) => {
    cy.log('Adding participant', details);
};

/**
 * Agrees to the privacy policy by checking the checkbox and clicking "I understand"
 */
export const agreeToPrivacyPolicy = () => {
    cy.log('Agreeing to Privacy Policy');
    // Check the privacy policy checkbox
    cy.get('#checkbox-0').check({ force: true });
    cy.wait(500);
    // Click "I understand" button
    cy.xpath('//button[contains(text(), "I understand")]').should('be.visible').click();
    cy.wait(1000);
};

/**
 * Skips the microphone check step
 * Uses Skip button since Cypress can't grant real microphone access
 */
export const skipMicrophoneCheck = () => {
    cy.log('Skipping Microphone Check');
    cy.xpath('//button[contains(text(), "Skip")]').should('be.visible').click();
    cy.wait(1000);
};

/**
 * Enters session name and clicks Next to proceed to recording
 * @param {string} name - Session name to enter
 */
export const enterSessionName = (name) => {
    cy.log('Entering Session Name:', name);
    cy.get('input[placeholder="Group 1, John Doe, etc."]').should('be.visible').type(name);
    cy.xpath('//button[contains(text(), "Next")]').should('be.visible').click();
    cy.wait(2000);
};

/**
 * Starts the recording by clicking the Record button
 */
export const startRecording = () => {
    cy.log('Starting Recording');
    cy.xpath('//button[contains(text(), "Record")]').should('be.visible').click();
};

/**
 * Stops the recording by clicking the Stop button
 */
export const stopRecording = () => {
    cy.log('Stopping Recording');
    cy.xpath('//button[contains(text(), "Stop")]').should('be.visible').click();
    cy.wait(1000);
};

/**
 * Finishes the recording session by clicking the Finish button
 */
export const finishRecording = () => {
    cy.log('Finishing Recording');
    cy.xpath('//button[contains(text(), "Finish")]').should('be.visible').click();
    cy.wait(2000);
};
