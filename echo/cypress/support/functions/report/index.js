/**
 * Report Functions
 * Helper functions for the Report feature in the Echo application.
 * Updated to use data-testid selectors for robust testing.
 */

// ============= Report Creation =============

/**
 * Opens the report create modal
 */
export const openReportCreateModal = () => {
    cy.log('Opening Report Create Modal');
    cy.get('[data-testid="report-create-modal"]').should('be.visible');
};

/**
 * Selects a language for the report
 */
export const selectReportLanguage = (langCode) => {
    cy.log('Selecting report language:', langCode);
    cy.get('[data-testid="report-language-select"]').should('be.visible').select(langCode);
};

/**
 * Creates the report
 */
export const createReport = () => {
    cy.log('Creating Report');
    cy.get('[data-testid="report-create-button"]').should('be.visible').click();
    cy.wait(10000); // Wait for report generation
};

/**
 * Generates a report (complete flow)
 */
export const generateReport = (langCode = 'en') => {
    cy.log('Generating report with language:', langCode);
    selectReportLanguage(langCode);
    createReport();
};

// ============= Report Actions =============

/**
 * Clicks the share button (mobile)
 */
export const shareReport = () => {
    cy.log('Sharing Report');
    cy.get('[data-testid="report-share-button"]').should('be.visible').click();
};

/**
 * Copies the report link
 */
export const copyReportLink = () => {
    cy.log('Copying Report Link');
    cy.get('[data-testid="report-copy-link-button"]').should('be.visible').click();
};

/**
 * Prints the report
 */
export const printReport = () => {
    cy.log('Printing Report');
    cy.get('[data-testid="report-print-button"]').should('be.visible').click();
};

/**
 * Toggles report publish status
 */
export const togglePublishReport = () => {
    cy.log('Toggling Report Publish');
    cy.get('[data-testid="report-publish-toggle"]').click();
};

/**
 * Publishes the report with confirmation
 */
export const publishReportWithConfirmation = () => {
    cy.log('Publishing Report with Confirmation');
    togglePublishReport();
    cy.get('[data-testid="report-publish-confirmation-modal"]').should('be.visible');
    cy.get('[data-testid="report-publish-proceed-button"]').click();
    cy.wait(2000);
};

/**
 * Cancels the publish confirmation
 */
export const cancelPublishReport = () => {
    cy.log('Canceling Report Publish');
    cy.get('[data-testid="report-publish-cancel-button"]').should('be.visible').click();
};

// ============= Report Settings =============

/**
 * Toggles the portal link inclusion in report
 */
export const toggleIncludePortalLink = () => {
    cy.log('Toggling Include Portal Link');
    cy.get('[data-testid="report-include-portal-link-checkbox"]').click();
};

/**
 * Toggles editing mode
 */
export const toggleEditingMode = () => {
    cy.log('Toggling Editing Mode');
    cy.get('[data-testid="report-editing-mode-toggle"]').click();
};

// ============= Report View/Render =============

/**
 * Verifies the report renderer is visible
 */
export const verifyReportRendered = () => {
    cy.log('Verifying Report Rendered');
    cy.get('[data-testid="report-renderer-container"]').should('be.visible');
};

/**
 * Verifies the report is loading
 */
export const verifyReportLoading = () => {
    cy.log('Verifying Report Loading');
    cy.get('[data-testid="report-renderer-loading"]').should('be.visible');
};

/**
 * Waits for report to finish loading
 */
export const waitForReportLoad = (timeout = 30000) => {
    cy.log('Waiting for Report to Load');
    cy.get('[data-testid="report-renderer-loading"]', { timeout }).should('not.exist');
    cy.get('[data-testid="report-renderer-container"]').should('be.visible');
};

/**
 * Verifies no report is available
 */
export const verifyNoReportAvailable = () => {
    cy.log('Verifying No Report Available');
    cy.get('[data-testid="report-renderer-not-found"]').should('be.visible');
};

// ============= Public Report View =============

/**
 * Verifies the public report view is visible
 */
export const verifyPublicReportView = () => {
    cy.log('Verifying Public Report View');
    cy.get('[data-testid="public-report-view"]').should('be.visible');
};

/**
 * Verifies report is not available publicly
 */
export const verifyReportNotPublished = () => {
    cy.log('Verifying Report Not Published');
    cy.get('[data-testid="public-report-not-available"]').should('be.visible');
};

// ============= Conversation Status =============

/**
 * Verifies the conversation status modal
 */
export const verifyConversationStatusModal = () => {
    cy.log('Verifying Conversation Status Modal');
    cy.get('[data-testid="report-conversation-status-modal"]').should('be.visible');
};
