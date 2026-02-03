export const openPortalEditor = () => {
    cy.log('Opening Portal Editor');
    // Click on the "Portal Editor" tab using data-testid
    cy.get('[data-testid="project-overview-tab-portal-editor"]')
        .scrollIntoView()
        .should('be.visible')
        .click({ force: true });
    cy.wait(1000);
};

export const selectTutorial = (tutorialName = 'Basic') => {
    cy.log(`Selecting Tutorial: ${tutorialName}`);
    // The tutorial selector uses data-testid
    cy.get('[data-testid="portal-editor-tutorial-select"]')
        .scrollIntoView()
        .should('be.visible')
        .select(tutorialName.toLowerCase());
};

export const addTag = (tagName) => {
    cy.log(`Adding Tag: ${tagName}`);
    // 1. Find Tag Input using data-testid
    cy.get('[data-testid="portal-editor-tags-input"]')
        .scrollIntoView()
        .should('be.visible')
        .type(tagName);

    // 2. Add the Tag using data-testid
    cy.get('[data-testid="portal-editor-add-tag-button"]').should('be.visible').click();

    // 3. Verify Tag Added
    cy.contains(tagName).should('be.visible');
};

export const updatePortalContent = (title, content, thankYouContent) => {
    cy.log('Updating Portal Content');

    // Page Title using data-testid
    if (title) {
        cy.get('[data-testid="portal-editor-page-title-input"]')
            .scrollIntoView()
            .should('be.visible')
            .clear()
            .type(title);
    }

    // Page Content - MDX Editor using data-testid
    if (content) {
        cy.get('[data-testid="portal-editor-page-content-editor"]')
            .find('[data-lexical-editor="true"]')
            .scrollIntoView()
            .should('be.visible')
            .click()
            .clear()
            .type(content);
    }

    // Thank You Page Content - MDX Editor using data-testid
    if (thankYouContent) {
        cy.get('[data-testid="portal-editor-thank-you-content-editor"]')
            .find('[data-lexical-editor="true"]')
            .scrollIntoView()
            .should('be.visible')
            .click()
            .clear()
            .type(thankYouContent);
    }

    // Auto-save is in effect, just wait for it
    cy.wait(3000);
    cy.contains(/saved/i).should('exist');
};

export const changePortalLanguage = (langCode) => {
    cy.log(`Changing Portal Language to: ${langCode}`);
    // The language selector uses data-testid
    cy.get('[data-testid="portal-editor-language-select"]')
        .scrollIntoView()
        .should('be.visible')
        .select(langCode);

    // Wait for auto-save
    cy.wait(2000);
};

// Toggle "Ask for Name" checkbox
export const toggleAskForName = (enable = true) => {
    cy.log(`Toggling Ask for Name: ${enable}`);
    cy.get('[data-testid="portal-editor-ask-name-checkbox"]').then(($checkbox) => {
        const isChecked = $checkbox.is(':checked');
        if ((enable && !isChecked) || (!enable && isChecked)) {
            cy.wrap($checkbox).click({ force: true });
        }
    });
};



// Toggle "Make it Concrete" feature
export const toggleMakeItConcrete = (enable = true) => {
    cy.log(`Toggling Make it Concrete: ${enable}`);

    // 1. Get input (it might be hidden due to Mantine styling)
    cy.get('[data-testid="portal-editor-make-concrete-switch"]')
        .should('exist')
        .then(($input) => {
            // Find the visible label/wrapper
            const $label = $input.closest('label');
            cy.wrap($label).scrollIntoView().should('be.visible');

            const isChecked = $input.is(':checked');
            if ((enable && !isChecked) || (!enable && isChecked)) {
                // Click the label for robust interaction
                cy.wrap($label).click({ force: true });

                // Wait for potential auto-save or UI update
                cy.wait(1000);
            }
        });

    // 2. Hard check as requested
    if (enable) {
        cy.get('[data-testid="portal-editor-make-concrete-switch"]').should('be.checked');
    } else {
        cy.get('[data-testid="portal-editor-make-concrete-switch"]').should('not.be.checked');
    }

    // 3. Verify 'Saved' state to ensure persistence
    cy.contains(/saved/i).should('exist');
};


export const toggleGoDeeper = (enable = true) => {
    cy.log(`Toggling Go Deeper: ${enable}`);

    // 1. Get input (it might be hidden due to Mantine styling)
    cy.get('[data-testid="portal-editor-go-deeper-switch"]')
        .should('exist')
        .then(($input) => {
            // Find the visible label/wrapper
            const $label = $input.closest('label');
            cy.wrap($label).scrollIntoView().should('be.visible');

            const isChecked = $input.is(':checked');
            if ((enable && !isChecked) || (!enable && isChecked)) {
                // Click the label for robust interaction
                cy.wrap($label).click({ force: true });

                // Wait for potential auto-save or UI update
                cy.wait(1000);
            }
        });

    // 2. Hard check as requested
    if (enable) {
        cy.get('[data-testid="portal-editor-go-deeper-switch"]').should('be.checked');
    } else {
        cy.get('[data-testid="portal-editor-go-deeper-switch"]').should('not.be.checked');
    }

    // 3. Verify 'Saved' state to ensure persistence
    cy.contains(/saved/i).should('exist');
};

// Toggle "Report Notifications" feature
export const toggleReportNotifications = (enable = true) => {
    cy.log(`Toggling Report Notifications: ${enable}`);
    cy.get('[data-testid="portal-editor-report-notifications-switch"]').then(($switch) => {
        const isChecked = $switch.is(':checked');
        if ((enable && !isChecked) || (!enable && isChecked)) {
            cy.wrap($switch).click({ force: true });
        }
    });
};

// Toggle Preview mode
export const togglePreview = () => {
    cy.log('Toggling Portal Editor Preview');
    cy.get('[data-testid="portal-editor-preview-toggle"]').should('be.visible').click();
};

// Verify QR Code is visible
export const verifyQrCodeVisible = () => {
    cy.log('Verifying QR Code is visible');
    cy.get('[data-testid="project-qr-code"]').should('be.visible');
};

// Click Share button
export const clickShareButton = () => {
    cy.log('Clicking Share button');
    cy.get('[data-testid="project-share-button"]').should('be.visible').click();
};

// Click Copy Link button
export const clickCopyLinkButton = () => {
    cy.log('Clicking Copy Link button');
    cy.get('[data-testid="project-copy-link-button"]').should('be.visible').click();
};

// Toggle Open for Participation
export const toggleOpenForParticipation = (enable = true) => {
    cy.log(`Toggling Open for Participation: ${enable}`);
    cy.get('[data-testid="dashboard-open-for-participation-toggle"]').then(($toggle) => {
        const isChecked = $toggle.is(':checked');
        if ((enable && !isChecked) || (!enable && isChecked)) {
            cy.wrap($toggle).click();
        }
    });
};

// Select Reply Mode (default, brainstorm, custom)
export const selectReplyMode = (mode = 'default') => {
    cy.log(`Selecting Reply Mode: ${mode}`);
    const testId = `portal-editor-reply-mode-${mode}`;
    cy.get(`[data-testid="${testId}"]`).scrollIntoView().should('be.visible').click();
};

// Set custom reply prompt (only works when reply mode is custom)
export const setReplyPrompt = (promptText) => {
    cy.log('Setting custom reply prompt');
    cy.get('[data-testid="portal-editor-reply-prompt-textarea"]')
        .scrollIntoView()
        .should('be.visible')
        .clear()
        .type(promptText);
};

// Set specific context
export const setSpecificContext = (contextText) => {
    cy.log('Setting specific context');
    cy.get('[data-testid="portal-editor-specific-context-input"]')
        .scrollIntoView()
        .should('be.visible')
        .clear()
        .type(contextText);
};

// ============= Project Search Functions =============

export const searchProject = (searchTerm) => {
    cy.log(`Searching for project: ${searchTerm}`);
    cy.get('[data-testid="project-search-input"]')
        .should('be.visible')
        .clear()
        .type(searchTerm);
};

export const clearProjectSearch = () => {
    cy.log('Clearing project search');
    cy.get('[data-testid="project-search-clear-button"]').should('be.visible').click();
};

// ============= Project Clone Functions =============

export const cloneProject = (newName) => {
    cy.log(`Cloning project with name: ${newName}`);

    // Click clone button
    cy.get('[data-testid="project-actions-clone-button"]').scrollIntoView().should('be.visible').click();
    cy.wait(1000);

    // Fill in new name in modal
    cy.get('[data-testid="project-clone-modal"]').should('be.visible');
    cy.get('[data-testid="project-clone-name-input"]').clear().type(newName);

    // Confirm clone
    cy.get('[data-testid="project-clone-confirm-button"]').click();
    cy.wait(5000); // Wait for clone operation
};

// ============= Announcement Functions =============

export const openAnnouncementDrawer = () => {
    cy.log('Opening announcement drawer');
    cy.get('[data-testid="announcement-icon-button"]').filter(':visible').first().click();
    cy.get('[data-testid="announcement-drawer"]').should('be.visible');
};

export const closeAnnouncementDrawer = () => {
    cy.log('Closing announcement drawer');
    cy.get('[data-testid="announcement-close-drawer-button"]').should('be.visible').click();
};

export const verifyNoAnnouncements = () => {
    cy.log('Verifying no announcements available');
    cy.get('[data-testid="announcement-empty-state"]').should('be.visible');
};

export const markAllAnnouncementsRead = () => {
    cy.log('Marking all announcements as read');
    cy.get('[data-testid="announcement-mark-all-read-button"]').should('be.visible').click();
};

export const getUnreadAnnouncementCount = () => {
    cy.log('Getting unread announcement count');
    return cy.get('[data-testid="announcement-unread-count"]').invoke('text');
};
