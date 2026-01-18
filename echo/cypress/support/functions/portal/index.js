export const openPortalEditor = () => {
    cy.log('Opening Portal Editor');
    // Click on the "Portal Editor" tab
    cy.xpath('//button[contains(descendant-or-self::text(), "Portal Editor")]')
        .first()
        .scrollIntoView()
        .should('be.visible')
        .click({ force: true }); // Force click in case of minor overlapping/clipping
    cy.wait(1000); // Wait for editor to load
};

export const selectTutorial = (tutorialName = 'Basic') => {
    cy.log(`Selecting Tutorial: ${tutorialName}`);
    // The tutorial selector is a native <select> element, not a Mantine input
    // Target the select following the "Select tutorial" text
    cy.xpath('//*[contains(text(), "Select tutorial")]/following::select[1]')
        .first()
        .scrollIntoView()
        .should('be.visible')
        .select(tutorialName.toLowerCase()); // Native select uses value (e.g. 'basic')
};

export const addTag = (tagName) => {
    cy.log(`Adding Tag: ${tagName}`);
    // 1. Find Tag Input - the input follows the "Tags" label (no placeholder)
    // Using robust selector: find "Tags" text and get the following input
    cy.xpath('//*[contains(text(), "Tags")]/following::input[1]')
        .first()
        .scrollIntoView()
        .should('be.visible')
        .type(tagName);

    // 2. Add the Tag - Click "Add Tag" button (text is inside span.mantine-Button-label)
    cy.xpath('//button[contains(., "Add Tag")]').first().should('be.visible').click();

    // 3. Verify Tag Added
    cy.xpath(`//*[contains(text(), "${tagName}")]`).should('be.visible');
};

export const updatePortalContent = (title, content, thankYouContent) => {
    cy.log('Updating Portal Content');

    // Page Title - use the unique name attribute directly
    if (title) {
        cy.xpath('//input[@name="default_conversation_title"]')
            .first()
            .scrollIntoView()
            .should('be.visible')
            .clear()
            .type(title);
    }

    // Page Content - MDX Editor (first contenteditable div after "Page Content" text)
    if (content) {
        cy.xpath('//*[contains(text(), "Page Content")]/following::div[@data-lexical-editor="true"][1]')
            .first()
            .scrollIntoView()
            .should('be.visible')
            .click()
            .clear()
            .type(content);
    }

    // Thank You Page Content - MDX Editor (first contenteditable div after "Thank You" text)
    if (thankYouContent) {
        cy.xpath('//*[contains(text(), "Thank You Page Content")]/following::div[@data-lexical-editor="true"][1]')
            .first()
            .scrollIntoView()
            .should('be.visible')
            .click()
            .clear()
            .type(thankYouContent);
    }

    // Auto-save is in effect, just wait for it
    cy.wait(3000);
    cy.xpath('//*[contains(translate(., "SAVED", "saved"), "saved")]').first().should('exist');
};

export const changePortalLanguage = (langCode) => {
    cy.log(`Changing Portal Language to: ${langCode}`);
    // The language selector is a native select element with name="language"
    cy.xpath('//select[@name="language"]')
        .first()
        .scrollIntoView()
        .should('be.visible')
        .select(langCode);

    // Wait for auto-save
    cy.wait(2000);
};
