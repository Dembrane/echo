/**
 * Participant Portal Functions
 * Helper functions for the participant recording flow in the Echo portal.
 * Updated to use data-testid selectors for robust testing.
 */

// ============= Loading & Error States =============

/**
 * Verifies portal is loading
 */
export const verifyPortalLoading = () => {
    cy.log('Verifying Portal Loading');
    cy.get('[data-testid="portal-loading-spinner"]').should('be.visible');
};

/**
 * Verifies portal loading error
 */
export const verifyPortalError = () => {
    cy.log('Verifying Portal Error');
    cy.get('[data-testid="portal-error-alert"]').should('be.visible');
};

// ============= Onboarding Flow =============

/**
 * Skips the onboarding entirely
 */
export const skipOnboarding = () => {
    cy.log('Skipping Onboarding');
    cy.get('[data-testid="portal-onboarding-skip"]').should('be.visible').click();
};

/**
 * Agrees to the privacy policy by checking the checkbox and clicking I understand
 */
export const agreeToPrivacyPolicy = () => {
    cy.log('Agreeing to Privacy Policy');
    // Check the checkbox
    cy.get('[data-testid="portal-onboarding-checkbox"]').check({ force: true });
    cy.wait(500);
    // Click the "I understand" / Next button
    cy.get('[data-testid="portal-onboarding-next-button"]').should('be.visible').click();
    cy.wait(1000);
};

/**
 * Clicks the Next button on onboarding slides
 */
export const clickOnboardingNext = () => {
    cy.log('Clicking Onboarding Next');
    cy.get('[data-testid="portal-onboarding-next-button"]').should('be.visible').click();
    cy.wait(1000);
};

/**
 * Clicks the Back button on onboarding slides
 */
export const clickOnboardingBack = () => {
    cy.log('Clicking Onboarding Back');
    cy.get('[data-testid="portal-onboarding-back-button"]').should('be.visible').click();
};

/**
 * Skips the microphone check step
 */
export const skipMicrophoneCheck = () => {
    cy.log('Skipping Microphone Check');
    cy.get('[data-testid="portal-onboarding-mic-skip-button"]').should('be.visible').click();
    cy.wait(1000);
};

/**
 * Continues from microphone check
 * @param {Object} options - Options object
 * @param {boolean} options.allowSkip - If true, will skip if Continue button not found
 */
export const continueMicrophoneCheck = ({ allowSkip = false } = {}) => {
    cy.log('Continuing from Microphone Check');
    // Wait for mic check page to stabilize
    cy.wait(2000);

    // Click the Continue button directly using data-testid
    cy.get('[data-testid="portal-onboarding-mic-continue-button"]', { timeout: 10000 })
        .should('be.visible')
        .click();
    cy.wait(1000);
};

/**
 * Goes back from microphone check
 */
export const backFromMicrophoneCheck = () => {
    cy.log('Going back from Microphone Check');
    cy.get('[data-testid="portal-onboarding-mic-back-button"]').should('be.visible').click();
};

// ============= Conversation Initiation =============

/**
 * Enters session/conversation name and clicks Next
 * @param {string} name - Session name to enter
 */
export const enterSessionName = (name) => {
    cy.log('Entering Session Name:', name);
    cy.get('[data-testid="portal-initiate-name-input"]', { timeout: 15000 })
        .should('be.visible')
        .clear()
        .type(name);
    cy.get('[data-testid="portal-initiate-next-button"]')
        .should('be.visible')
        .should('not.be.disabled')
        .click({ force: true });
    cy.wait(2000);
};

/**
 * Selects tags for the conversation
 */
export const selectTags = () => {
    cy.log('Opening Tags Select');
    cy.get('[data-testid="portal-initiate-tags-select"]').should('be.visible').click();
};

/**
 * Verifies initiation error message
 */
export const verifyInitiationError = () => {
    cy.log('Verifying Initiation Error');
    cy.get('[data-testid="portal-initiate-error-alert"]').should('be.visible');
};

// ============= Audio Recording Mode =============

/**
 * Starts the recording by clicking the Record button
 * Includes retry mechanism if microphone access is denied
 */
export const startRecording = () => {
    cy.log('Starting Recording');

    // Ensure media APIs are still patched before starting
    cy.window().then((win) => {
        if (win.__cypressApplyMediaStubs) {
            win.__cypressApplyMediaStubs();
        }
        if (win.__cypressEnsureMp3Playback) {
            win.__cypressEnsureMp3Playback();
        }
    });

    // Click the Record button
    cy.get('[data-testid="portal-audio-record-button"]', { timeout: 15000 })
        .should('be.visible')
        .should('not.be.disabled')
        .click({ force: true });

    // If the permission modal appears, re-apply stubs and retry
    cy.wait(1000);
    cy.get('body').then(($body) => {
        if ($body.text().includes('microphone access was denied')) {
            cy.contains('button', 'Check microphone access').click({ force: true });
            cy.wait(2000);
            cy.window().then((win) => {
                if (win.__cypressApplyMediaStubs) {
                    win.__cypressApplyMediaStubs();
                }
                if (win.__cypressEnsureMp3Playback) {
                    win.__cypressEnsureMp3Playback();
                }
            });
            // Retry clicking Record
            cy.get('[data-testid="portal-audio-record-button"]', { timeout: 15000 })
                .should('be.visible')
                .click({ force: true });
        }
    });

    // Ensure recording UI is active
    cy.contains('button', 'Stop', { timeout: 20000 }).should('be.visible');
};

/**
 * Stops the recording by clicking the Stop button
 * Handles the case where recording is interrupted and needs reconnection
 */
export const stopRecording = () => {
    cy.log('Stopping Recording');

    // First check if Stop button appears within 30 seconds
    cy.get('body', { timeout: 30000 }).then(($body) => {
        // Check if Stop button is visible
        if ($body.find('[data-testid="portal-audio-stop-button"]:visible').length > 0) {
            // Stop button found - click it
            cy.get('[data-testid="portal-audio-stop-button"]')
                .should('be.visible')
                .click({ force: true });
        } else if ($body.find('[data-testid="portal-audio-interruption-reconnect-button"]:visible').length > 0) {
            // Recording was interrupted - handle reconnection
            cy.log('Recording interrupted - clicking Reconnect');
            handleRecordingInterruption();
            // After reconnecting, wait and try to stop again
            cy.wait(60000); // Wait for recording again
            cy.get('[data-testid="portal-audio-stop-button"]', { timeout: 30000 })
                .should('be.visible')
                .click({ force: true });
        } else {
            // Try waiting a bit longer for stop button
            cy.get('[data-testid="portal-audio-stop-button"]', { timeout: 15000 })
                .should('be.visible')
                .click({ force: true });
        }
    });
    cy.wait(1000);
};

/**
 * Handles the recording interruption modal by clicking Reconnect
 * and waiting for recording to resume
 */
export const handleRecordingInterruption = () => {
    cy.log('Handling Recording Interruption');

    cy.get('body').then(($body) => {
        if ($body.find('[data-testid="portal-audio-interruption-reconnect-button"]').length > 0) {
            cy.get('[data-testid="portal-audio-interruption-reconnect-button"]')
                .should('be.visible')
                .click();
            cy.wait(3000); // Wait for reconnection

            // Check if recording resumed (Record button should appear or recording continues)
            cy.get('body').then(($bodyAfter) => {
                if ($bodyAfter.find('[data-testid="portal-audio-record-button"]:visible').length > 0) {
                    // Need to click Record again
                    cy.get('[data-testid="portal-audio-record-button"]')
                        .should('be.visible')
                        .click({ force: true });
                }
            });
        }
    });
};

/**
 * Resumes recording from pause
 */
export const resumeRecording = () => {
    cy.log('Resuming Recording');
    cy.get('[data-testid="portal-audio-stop-resume-button"]').should('be.visible').click();
};

/**
 * Finishes the recording from pause modal
 */
export const finishFromPause = () => {
    cy.log('Finishing from Pause');
    cy.get('[data-testid="portal-audio-stop-finish-button"]').should('be.visible').click();
    cy.wait(2000);
};

/**
 * Finishes the recording session
 */
export const finishRecording = () => {
    cy.log('Finishing Recording');
    cy.get('[data-testid="portal-audio-finish-button"]', { timeout: 15000 })
        .should('be.visible')
        .click({ force: true });
    cy.wait(2000);
};

/**
 * Clicks the Refine/Echo button
 */
export const clickEchoButton = () => {
    cy.log('Clicking Echo/Refine Button');
    cy.get('[data-testid="portal-audio-echo-button"]').should('be.visible').click();
};

/**
 * Switches to text mode
 */
export const switchToTextMode = () => {
    cy.log('Switching to Text Mode');
    cy.get('[data-testid="portal-audio-switch-to-text-button"]').should('be.visible').click();
};

/**
 * Closes the echo info modal
 */
export const closeEchoInfoModal = () => {
    cy.log('Closing Echo Info Modal');
    cy.get('[data-testid="portal-audio-echo-info-close-button"]').should('be.visible').click();
};

/**
 * Reconnects after interruption
 */
export const reconnectAfterInterruption = () => {
    cy.log('Reconnecting after Interruption');
    cy.get('[data-testid="portal-audio-interruption-reconnect-button"]').should('be.visible').click();
};

/**
 * Verifies recording timer is visible
 */
export const verifyRecordingTimer = () => {
    cy.log('Verifying Recording Timer');
    cy.get('[data-testid="portal-audio-recording-timer"]').should('be.visible');
};

// ============= Text Input Mode =============

/**
 * Types text in the text mode textarea
 * @param {string} text - Text to type
 */
export const typePortalText = (text) => {
    cy.log('Typing Portal Text:', text);
    cy.get('[data-testid="portal-text-input-textarea"]')
        .should('be.visible')
        .type(text);
};

/**
 * Submits the text
 */
export const submitText = () => {
    cy.log('Submitting Text');
    cy.get('[data-testid="portal-text-submit-button"]').should('be.visible').click();
};

/**
 * Switches to audio mode from text mode
 */
export const switchToAudioMode = () => {
    cy.log('Switching to Audio Mode');
    cy.get('[data-testid="portal-text-switch-to-audio-button"]').should('be.visible').click();
};

/**
 * Finishes from text mode
 */
export const finishTextMode = () => {
    cy.log('Finishing Text Mode');
    cy.get('[data-testid="portal-text-finish-button"]').should('be.visible').click();
};

/**
 * Confirms finishing from text mode modal
 */
export const confirmFinishText = () => {
    cy.log('Confirming Finish Text');
    cy.get('[data-testid="portal-text-finish-confirm-button"]').should('be.visible').click();
};

/**
 * Cancels finishing from text mode modal
 */
export const cancelFinishText = () => {
    cy.log('Canceling Finish Text');
    cy.get('[data-testid="portal-text-finish-cancel-button"]').should('be.visible').click();
};

// ============= Refine Flow - Selection =============

/**
 * Selects "Make it concrete" (verify) card
 */
export const selectMakeItConcrete = () => {
    cy.log('Selecting Make it Concrete');
    cy.get('[data-testid="portal-echo-verify-card"]').should('be.visible').click();
};

/**
 * Selects "Go deeper" (explore) card
 */
export const selectGoDeeper = () => {
    cy.log('Selecting Go Deeper');
    cy.get('[data-testid="portal-echo-explore-card"]').should('be.visible').click();
};

// ============= Refine Flow - Go Deeper (Explore) =============

/**
 * Waits for explore response
 */
export const waitForExploreResponse = (timeout = 30000) => {
    cy.log('Waiting for Explore Response');
    cy.get('[data-testid="portal-explore-thinking"]', { timeout }).should('not.exist');
    cy.get('[data-testid^="portal-explore-message-"]').should('exist');
};

// ============= Make it Concrete (Verify) - Topic Selection =============

/**
 * Selects a topic for verification
 * @param {string} topicKey - gems, actions, agreements, etc.
 */
export const selectVerifyTopic = (topicKey) => {
    cy.log('Selecting Verify Topic:', topicKey);
    cy.get(`[data-testid="portal-verify-topic-${topicKey}"]`).should('be.visible').click();
};

/**
 * Proceeds from topic selection
 */
export const proceedFromTopicSelection = () => {
    cy.log('Proceeding from Topic Selection');
    cy.get('[data-testid="portal-verify-selection-next-button"]').should('be.visible').click();
};

// ============= Make it Concrete (Verify) - Instructions =============

/**
 * Proceeds from instructions
 */
export const proceedFromInstructions = () => {
    cy.log('Proceeding from Instructions');
    cy.get('[data-testid="portal-verify-instructions-next-button"]').should('be.visible').click();
};

// ============= Make it Concrete (Verify) - Artefact Review =============

/**
 * Reads the artefact aloud
 */
export const readArtefactAloud = () => {
    cy.log('Reading Artefact Aloud');
    cy.get('[data-testid="portal-verify-artefact-read-aloud-button"]').should('be.visible').click();
};

/**
 * Revises the artefact (regenerate from conversation)
 */
export const reviseArtefact = () => {
    cy.log('Revising Artefact');
    cy.get('[data-testid="portal-verify-artefact-revise-button"]').should('be.visible').click();
};

/**
 * Enters edit mode for artefact
 */
export const editArtefact = () => {
    cy.log('Editing Artefact');
    cy.get('[data-testid="portal-verify-artefact-edit-button"]').should('be.visible').click();
};

/**
 * Approves the artefact
 */
export const approveArtefact = () => {
    cy.log('Approving Artefact');
    cy.get('[data-testid="portal-verify-artefact-approve-button"]').should('be.visible').click();
};

/**
 * Saves edited artefact content
 */
export const saveArtefactEdit = () => {
    cy.log('Saving Artefact Edit');
    cy.get('[data-testid="portal-verify-artefact-save-edit-button"]').should('be.visible').click();
};

/**
 * Cancels artefact editing
 */
export const cancelArtefactEdit = () => {
    cy.log('Canceling Artefact Edit');
    cy.get('[data-testid="portal-verify-artefact-cancel-edit-button"]').should('be.visible').click();
};

// ============= View Your Responses =============

/**
 * Clicks view your responses button
 */
export const viewResponses = () => {
    cy.log('Viewing Responses');
    cy.get('[data-testid="portal-view-responses-button"]').should('be.visible').click();
};

/**
 * Verifies responses modal is visible
 */
export const verifyResponsesModal = () => {
    cy.log('Verifying Responses Modal');
    cy.get('[data-testid="portal-view-responses-modal"]').should('be.visible');
};

// ============= Header & Navigation =============

/**
 * Clicks back button in portal header
 */
export const clickPortalBack = () => {
    cy.log('Clicking Portal Back');
    cy.get('[data-testid="portal-header-back-button"]').should('be.visible').click();
};

/**
 * Clicks cancel button in portal header
 */
export const clickPortalCancel = () => {
    cy.log('Clicking Portal Cancel');
    cy.get('[data-testid="portal-header-cancel-button"]').should('be.visible').click();
};

/**
 * Opens portal settings
 */
export const openPortalSettings = () => {
    cy.log('Opening Portal Settings');
    cy.get('[data-testid="portal-header-settings-button"]').should('be.visible').click();
    cy.get('[data-testid="portal-settings-modal"]').should('be.visible');
};

// ============= Portal Settings - Microphone Test =============

/**
 * Selects a microphone from dropdown
 */
export const selectMicrophone = (micName) => {
    cy.log('Selecting Microphone:', micName);
    cy.get('[data-testid="portal-settings-mic-select"]').should('be.visible').select(micName);
};

/**
 * Verifies microphone is working
 */
export const verifyMicrophoneWorking = () => {
    cy.log('Verifying Microphone Working');
    cy.get('[data-testid="portal-settings-mic-success-alert"]').should('be.visible');
};

/**
 * Verifies microphone issue
 */
export const verifyMicrophoneIssue = () => {
    cy.log('Verifying Microphone Issue');
    cy.get('[data-testid="portal-settings-mic-issue-alert"]').should('be.visible');
};

/**
 * Confirms microphone change
 */
export const confirmMicrophoneChange = () => {
    cy.log('Confirming Microphone Change');
    cy.get('[data-testid="portal-settings-mic-change-confirm-button"]').should('be.visible').click();
};

/**
 * Cancels microphone change
 */
export const cancelMicrophoneChange = () => {
    cy.log('Canceling Microphone Change');
    cy.get('[data-testid="portal-settings-mic-change-cancel-button"]').should('be.visible').click();
};

// ============= Email Notification (Finish Screen) =============

/**
 * Enters email for notifications
 */
export const enterNotificationEmail = (email) => {
    cy.log('Entering Notification Email:', email);
    cy.get('[data-testid="portal-finish-email-input"]')
        .should('be.visible')
        .type(email);
    cy.get('[data-testid="portal-finish-email-add-button"]').click();
};

/**
 * Submits email notification subscription
 */
export const submitEmailNotification = () => {
    cy.log('Submitting Email Notification');
    cy.get('[data-testid="portal-finish-email-submit-button"]').should('be.visible').click();
};

/**
 * Verifies email submission success
 */
export const verifyEmailSubmissionSuccess = () => {
    cy.log('Verifying Email Submission Success');
    cy.get('[data-testid="portal-finish-email-success"]').should('be.visible');
};

// ============= Audio Stubs (for testing) =============

/**
 * Installs audio/mic stubs before loading the portal
 * Uses REAL audio injection via MP3 file for proper server upload
 * @param {Object} options - Options object
 * @param {string} options.audioBase64 - Base64 encoded audio file
 * @param {string} options.audioMimeType - MIME type of the audio (default: audio/mpeg)
 */
export const installParticipantAudioStubs = ({ audioBase64, audioMimeType = 'audio/mpeg' } = {}) => {
    cy.on('window:before:load', (win) => {
        const ensureMediaStreamCtor = () => {
            if (!win.MediaStream) {
                win.MediaStream = class MediaStreamPolyfill {
                    constructor(tracks = []) {
                        this._tracks = tracks;
                    }

                    getTracks() {
                        return this._tracks;
                    }

                    getAudioTracks() {
                        return this._tracks;
                    }

                    addTrack(track) {
                        this._tracks.push(track);
                    }

                    removeTrack(track) {
                        this._tracks = this._tracks.filter((t) => t !== track);
                    }
                };
            }
        };

        const safeDefine = (obj, key, value) => {
            if (!obj) {
                return;
            }
            try {
                Object.defineProperty(obj, key, {
                    configurable: true,
                    writable: true,
                    value,
                });
            } catch (error) {
                try {
                    obj[key] = value;
                } catch (_error) { }
            }
        };

        const safeDefineGetter = (obj, key, getter) => {
            if (!obj) {
                return;
            }
            try {
                Object.defineProperty(obj, key, {
                    configurable: true,
                    get: getter,
                });
            } catch (error) {
                try {
                    obj[key] = getter();
                } catch (_error) { }
            }
        };

        const createAnalyserStub = () => {
            const analyser = {
                _fftSize: 1024,
                smoothingTimeConstant: 0.8,
            };

            Object.defineProperty(analyser, 'fftSize', {
                configurable: true,
                get() {
                    return this._fftSize || 1024;
                },
                set(value) {
                    const normalized = Number(value) || 1024;
                    this._fftSize = normalized;
                    this.frequencyBinCount = Math.max(1, Math.floor(normalized / 2));
                },
            });

            analyser.frequencyBinCount = Math.max(1, Math.floor(analyser._fftSize / 2));

            analyser.getByteTimeDomainData = (array) => {
                for (let i = 0; i < array.length; i++) {
                    array[i] = 200;
                }
            };

            analyser.getFloatTimeDomainData = (array) => {
                for (let i = 0; i < array.length; i++) {
                    array[i] = 0.8;
                }
            };

            analyser.getByteFrequencyData = (array) => {
                for (let i = 0; i < array.length; i++) {
                    array[i] = 180;
                }
            };

            analyser.getFloatFrequencyData = (array) => {
                for (let i = 0; i < array.length; i++) {
                    array[i] = 0.7;
                }
            };

            return analyser;
        };

        const ensureAudioContextCtor = () => {
            if (!win.AudioContext) {
                win.AudioContext = win.webkitAudioContext;
            }
            if (!win.AudioContext) {
                win.AudioContext = function AudioContextFallback() {
                    this.sampleRate = 44100;
                    this.state = 'running';
                    this.destination = {};
                };
            }

            if (typeof win.AudioContext.prototype.createAnalyser !== 'function') {
                win.AudioContext.prototype.createAnalyser = function () {
                    return createAnalyserStub();
                };
            }

            if (typeof win.AudioContext.prototype.createMediaStreamSource !== 'function') {
                win.AudioContext.prototype.createMediaStreamSource = function () {
                    return { connect() { }, disconnect() { } };
                };
            }

            if (typeof win.AudioContext.prototype.createMediaStreamDestination !== 'function') {
                win.AudioContext.prototype.createMediaStreamDestination = function () {
                    ensureMediaStreamCtor();
                    const track = {
                        kind: 'audio',
                        enabled: true,
                        muted: false,
                        readyState: 'live',
                        stop() { },
                    };
                    return { stream: new win.MediaStream([track]) };
                };
            }

            if (typeof win.AudioContext.prototype.createMediaElementSource !== 'function') {
                win.AudioContext.prototype.createMediaElementSource = function () {
                    return { connect() { }, disconnect() { } };
                };
            }

            if (typeof win.AudioContext.prototype.createOscillator !== 'function') {
                win.AudioContext.prototype.createOscillator = function () {
                    return {
                        connect() { },
                        disconnect() { },
                        start() { },
                        stop() { },
                        frequency: { value: 440 },
                        type: 'sine',
                    };
                };
            }

            if (typeof win.AudioContext.prototype.createScriptProcessor !== 'function') {
                win.AudioContext.prototype.createScriptProcessor = function () {
                    return {
                        onaudioprocess: null,
                        connect() { },
                        disconnect() { },
                    };
                };
            }

            if (typeof win.AudioContext.prototype.close !== 'function') {
                win.AudioContext.prototype.close = function () {
                    return Promise.resolve();
                };
            }

            if (typeof win.AudioContext.prototype.resume !== 'function') {
                win.AudioContext.prototype.resume = function () {
                    return Promise.resolve();
                };
            }

            if (typeof win.AudioContext.prototype.suspend !== 'function') {
                win.AudioContext.prototype.suspend = function () {
                    return Promise.resolve();
                };
            }
        };

        const patchAudioContext = (AudioContextCtor) => {
            if (!AudioContextCtor || AudioContextCtor.__cypressPatched) {
                return;
            }

            AudioContextCtor.__cypressPatched = true;
            const originalCreateAnalyser = AudioContextCtor.prototype.createAnalyser;
            if (typeof originalCreateAnalyser !== 'function') {
                AudioContextCtor.prototype.createAnalyser = function () {
                    return createAnalyserStub();
                };
                return;
            }

            AudioContextCtor.prototype.createAnalyser = function () {
                const analyser = originalCreateAnalyser.call(this);
                const originalGetByteTimeDomainData =
                    typeof analyser.getByteTimeDomainData === 'function'
                        ? analyser.getByteTimeDomainData.bind(analyser)
                        : null;
                const originalGetFloatTimeDomainData =
                    typeof analyser.getFloatTimeDomainData === 'function'
                        ? analyser.getFloatTimeDomainData.bind(analyser)
                        : null;
                const originalGetByteFrequencyData =
                    typeof analyser.getByteFrequencyData === 'function'
                        ? analyser.getByteFrequencyData.bind(analyser)
                        : null;
                const originalGetFloatFrequencyData =
                    typeof analyser.getFloatFrequencyData === 'function'
                        ? analyser.getFloatFrequencyData.bind(analyser)
                        : null;

                analyser.getByteTimeDomainData = (array) => {
                    if (originalGetByteTimeDomainData) {
                        originalGetByteTimeDomainData(array);
                    }

                    for (let i = 0; i < array.length; i++) {
                        array[i] = 200;
                    }
                };

                analyser.getFloatTimeDomainData = (array) => {
                    if (originalGetFloatTimeDomainData) {
                        originalGetFloatTimeDomainData(array);
                    }

                    for (let i = 0; i < array.length; i++) {
                        array[i] = 0.8;
                    }
                };

                analyser.getByteFrequencyData = (array) => {
                    if (originalGetByteFrequencyData) {
                        originalGetByteFrequencyData(array);
                    }

                    for (let i = 0; i < array.length; i++) {
                        array[i] = 180;
                    }
                };

                analyser.getFloatFrequencyData = (array) => {
                    if (originalGetFloatFrequencyData) {
                        originalGetFloatFrequencyData(array);
                    }

                    for (let i = 0; i < array.length; i++) {
                        array[i] = 0.7;
                    }
                };

                if (
                    typeof analyser.frequencyBinCount !== 'number' ||
                    analyser.frequencyBinCount <= 0
                ) {
                    const fftSize = analyser.fftSize || 1024;
                    try {
                        analyser.frequencyBinCount = Math.max(1, Math.floor(fftSize / 2));
                    } catch (_error) { }
                }

                return analyser;
            };

            const originalCreateMediaStreamSource = AudioContextCtor.prototype.createMediaStreamSource;
            if (typeof originalCreateMediaStreamSource === 'function') {
                AudioContextCtor.prototype.createMediaStreamSource = function (stream) {
                    try {
                        return originalCreateMediaStreamSource.call(this, stream);
                    } catch (error) {
                        return {
                            connect() { },
                            disconnect() { },
                        };
                    }
                };
            } else {
                AudioContextCtor.prototype.createMediaStreamSource = function () {
                    return {
                        connect() { },
                        disconnect() { },
                    };
                };
            }

            if (typeof AudioContextCtor.prototype.createMediaStreamDestination !== 'function') {
                AudioContextCtor.prototype.createMediaStreamDestination = function () {
                    ensureMediaStreamCtor();
                    return { stream: new win.MediaStream() };
                };
            }
        };

        patchAudioContext(win.AudioContext);
        patchAudioContext(win.webkitAudioContext);
        ensureAudioContextCtor();

        const audioDataUrl = audioBase64 ? `data:${audioMimeType};base64,${audioBase64}` : null;
        win.__cypressForceMimeType = audioMimeType || 'audio/mpeg';


        const base64ToUint8Array = (base64) => {
            const binary = win.atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        };

        const buildToneWavBlob = () => {
            const sampleRate = 16000;
            const durationSeconds = 2;
            const numSamples = sampleRate * durationSeconds;
            const buffer = new ArrayBuffer(44 + numSamples * 2);
            const view = new DataView(buffer);

            const writeString = (offset, value) => {
                for (let i = 0; i < value.length; i++) {
                    view.setUint8(offset + i, value.charCodeAt(i));
                }
            };

            writeString(0, 'RIFF');
            view.setUint32(4, 36 + numSamples * 2, true);
            writeString(8, 'WAVE');
            writeString(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, 1, true);
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            writeString(36, 'data');
            view.setUint32(40, numSamples * 2, true);

            const amplitude = 0.2;
            const frequency = 440;
            let offset = 44;
            for (let i = 0; i < numSamples; i++) {
                const t = i / sampleRate;
                const sample = Math.sin(2 * Math.PI * frequency * t);
                const value = Math.max(-1, Math.min(1, sample * amplitude));
                view.setInt16(offset, value * 0x7fff, true);
                offset += 2;
            }

            return new Blob([buffer], { type: 'audio/wav' });
        };

        const getRecordingBlob = () => {
            if (win.__cypressAudioBlob) {
                return win.__cypressAudioBlob;
            }

            if (audioBase64) {
                try {
                    const bytes = base64ToUint8Array(audioBase64);
                    // Use the provided MIME type, or default to wav if not specified, 
                    // but allow any type (e.g. audio/mpeg) to pass through.
                    win.__cypressAudioBlob = new Blob([bytes], { type: audioMimeType || 'audio/wav' });
                    return win.__cypressAudioBlob;
                } catch (_error) { }
            }

            win.__cypressAudioBlob = buildToneWavBlob();
            return win.__cypressAudioBlob;
        };

        const buildAudioStream = () => {
            if (win.__cypressAudioStream) {
                return win.__cypressAudioStream;
            }

            try {
                const AudioContextCtor = win.AudioContext || win.webkitAudioContext;
                if (!AudioContextCtor) {
                    ensureMediaStreamCtor();
                    const track = {
                        kind: 'audio',
                        enabled: true,
                        muted: false,
                        readyState: 'live',
                        stop() { },
                    };
                    win.__cypressAudioStream = new win.MediaStream([track]);
                    return win.__cypressAudioStream;
                }

                const audioCtx = new AudioContextCtor();
                let destination;
                try {
                    destination = audioCtx.createMediaStreamDestination();
                } catch (error) {
                    ensureMediaStreamCtor();
                    const track = {
                        kind: 'audio',
                        enabled: true,
                        muted: false,
                        readyState: 'live',
                        stop() { },
                    };
                    destination = { stream: new win.MediaStream([track]) };
                }

                if (audioDataUrl) {
                    const audioEl = new win.Audio();
                    audioEl.src = audioDataUrl;
                    audioEl.loop = true;
                    audioEl.preload = 'auto';
                    audioEl.crossOrigin = 'anonymous';

                    const source = audioCtx.createMediaElementSource(audioEl);
                    source.connect(destination);

                    const startPlayback = () => {
                        if (audioCtx.state === 'suspended') {
                            audioCtx.resume().catch(() => { });
                        }
                        audioEl.play().catch(() => { });
                    };

                    audioEl.addEventListener('canplay', startPlayback);
                    startPlayback();

                    win.__cypressAudioElement = audioEl;
                } else {
                    const oscillator = audioCtx.createOscillator();
                    oscillator.connect(destination);
                    oscillator.start();
                }

                if (audioCtx.state === 'suspended') {
                    audioCtx.resume().catch(() => { });
                }

                win.__cypressAudioContext = audioCtx;
                win.__cypressAudioStream = destination.stream;
                return win.__cypressAudioStream;
            } catch (error) {
                ensureMediaStreamCtor();
                const track = {
                    kind: 'audio',
                    enabled: true,
                    muted: false,
                    readyState: 'live',
                    stop() { },
                };
                win.__cypressAudioStream = new win.MediaStream([track]);
                return win.__cypressAudioStream;
            }
        };

        const getForcedStream = () => {
            try {
                return buildAudioStream();
            } catch (_error) {
                ensureMediaStreamCtor();
                const track = {
                    kind: 'audio',
                    enabled: true,
                    muted: false,
                    readyState: 'live',
                    stop() { },
                };
                return new win.MediaStream([track]);
            }
        };

        const ensurePlayback = () => {
            if (win.__cypressAudioElement) {
                try {
                    win.__cypressAudioElement.play().catch(() => { });
                } catch (_error) { }
            }
        };

        const installMediaRecorderStub = () => {
            if (!(Cypress.browser && Cypress.browser.name === 'webkit')) {
                return;
            }

            const emit = (target, type, data) => {
                const event = new win.Event(type);
                if (typeof data !== 'undefined') {
                    event.data = data;
                }
                target.dispatchEvent(event);
                const handler = target[`on${type}`];
                if (typeof handler === 'function') {
                    handler.call(target, event);
                }
            };

            class CypressMediaRecorder {
                constructor(stream, options = {}) {
                    this.stream = stream;
                    this.mimeType = options.mimeType || 'audio/wav';
                    this.state = 'inactive';
                    this._em = win.document.createDocumentFragment();
                }

                start(timeslice) {
                    if (this.state !== 'inactive') {
                        return;
                    }
                    this.state = 'recording';
                    emit(this, 'start');

                    if (timeslice) {
                        this._slicing = win.setInterval(() => {
                            if (this.state === 'recording') {
                                const emptyBlob = new Blob([], { type: this.mimeType });
                                emit(this, 'dataavailable', emptyBlob);
                            }
                        }, timeslice);
                    }
                }

                stop() {
                    if (this.state === 'inactive') {
                        return;
                    }
                    if (this._slicing) {
                        win.clearInterval(this._slicing);
                        this._slicing = null;
                    }
                    const blob = getRecordingBlob();
                    emit(this, 'dataavailable', blob);
                    this.state = 'inactive';
                    emit(this, 'stop');
                }

                pause() {
                    if (this.state !== 'recording') {
                        return;
                    }
                    this.state = 'paused';
                    emit(this, 'pause');
                }

                resume() {
                    if (this.state !== 'paused') {
                        return;
                    }
                    this.state = 'recording';
                    emit(this, 'resume');
                }

                requestData() {
                    if (this.state === 'inactive') {
                        return;
                    }
                    const emptyBlob = new Blob([], { type: this.mimeType });
                    emit(this, 'dataavailable', emptyBlob);
                }

                addEventListener(...args) {
                    this._em.addEventListener(...args);
                }

                removeEventListener(...args) {
                    this._em.removeEventListener(...args);
                }

                dispatchEvent(...args) {
                    this._em.dispatchEvent(...args);
                }
            }

            CypressMediaRecorder.isTypeSupported = (mimeType) => mimeType === 'audio/wav' || mimeType === audioMimeType;
            CypressMediaRecorder.prototype.mimeType = audioMimeType || 'audio/wav';

            win.MediaRecorder = CypressMediaRecorder;
        };

        const applyMediaStubs = () => {
            if (!win.navigator.permissions) {
                safeDefine(win.navigator, 'permissions', {});
            }

            if (win.navigator.permissions) {
                const permissionsQuery = (desc) => {
                    if (!desc || desc.name === 'microphone' || desc.name === 'camera') {
                        win.__cypressMicPermissionGranted = true;
                        return Promise.resolve({
                            state: 'granted',
                            onchange: null,
                        });
                    }
                    return Promise.resolve({
                        state: 'prompt',
                        onchange: null,
                    });
                };

                safeDefine(
                    win.navigator.permissions,
                    'query',
                    permissionsQuery,
                );

                const permissionsProto =
                    (win.Permissions && win.Permissions.prototype) ||
                    Object.getPrototypeOf(win.navigator.permissions);

                safeDefine(permissionsProto, 'query', permissionsQuery);
            }

            const stubMediaDevices = {
                getUserMedia: () => {
                    win.__cypressMicPermissionGranted = true;
                    return Promise.resolve(getForcedStream());
                },
                enumerateDevices: () => Promise.resolve(fallbackDevices),
                addEventListener() { },
                removeEventListener() { },
                dispatchEvent() { },
            };

            if (win.Navigator && win.Navigator.prototype) {
                safeDefineGetter(win.Navigator.prototype, 'mediaDevices', () => stubMediaDevices);
            }

            safeDefineGetter(win.navigator, 'mediaDevices', () => stubMediaDevices);

            if (!win.navigator.mediaDevices) {
                return;
            }

            const fallbackDevices = [
                {
                    deviceId: 'default',
                    kind: 'audioinput',
                    label: 'Default Microphone',
                    groupId: 'default_group_id',
                },
                {
                    deviceId: 'communications',
                    kind: 'audioinput',
                    label: 'Communications Microphone',
                    groupId: 'communications_group_id',
                },
            ];

            const patchMediaDevices = (target) => {
                if (!target) {
                    return;
                }

                safeDefine(
                    target,
                    'enumerateDevices',
                    () => Promise.resolve(fallbackDevices),
                );

                safeDefine(
                    target,
                    'getUserMedia',
                    () => {
                        win.__cypressMicPermissionGranted = true;
                        return Promise.resolve(getForcedStream());
                    },
                );
            };

            patchMediaDevices(win.navigator.mediaDevices);
            patchMediaDevices(Object.getPrototypeOf(win.navigator.mediaDevices));

            if (win.MediaDevices && win.MediaDevices.prototype) {
                patchMediaDevices(win.MediaDevices.prototype);
            }

            safeDefine(
                win.navigator,
                'getUserMedia',
                (..._args) => {
                    win.__cypressMicPermissionGranted = true;
                    return Promise.resolve(getForcedStream());
                },
            );

            safeDefine(
                win.navigator,
                'webkitGetUserMedia',
                (..._args) => {
                    win.__cypressMicPermissionGranted = true;
                    return Promise.resolve(getForcedStream());
                },
            );

            installMediaRecorderStub();
        };

        win.__cypressBuildAudioStream = buildAudioStream;
        win.__cypressApplyMediaStubs = applyMediaStubs;
        win.__cypressEnsureAudioPlayback = ensurePlayback;
        win.__cypressGetAudioBlob = getRecordingBlob;

        applyMediaStubs();
        installMediaRecorderStub();
    });
};

// ============= Legacy Functions =============

export const addParticipant = (details) => {
    cy.log('Adding participant', details);
};

// ============= Functions needed by Test 14 =============

/**
 * Reapply audio stubs after navigation
 */
export const reapplyParticipantAudioStubs = () => {
    cy.window({ log: false }).then((win) => {
        if (win.__cypressApplyMediaStubs) {
            win.__cypressApplyMediaStubs();
        }
        if (win.__cypressEnsureAudioPlayback) {
            win.__cypressEnsureAudioPlayback();
        }
    });
};

/**
 * Prime microphone access
 */
export const primeMicrophoneAccess = () => {
    cy.window({ log: false }).then((win) => {
        if (win.__cypressApplyMediaStubs) {
            win.__cypressApplyMediaStubs();
        }
        if (win.__cypressEnsureAudioPlayback) {
            win.__cypressEnsureAudioPlayback();
        }

        const mediaDevices = win.navigator && win.navigator.mediaDevices;
        if (mediaDevices && typeof mediaDevices.getUserMedia === 'function') {
            return mediaDevices.getUserMedia({ audio: true }).then((stream) => {
                win.__cypressGrantedStream = stream;
                if (mediaDevices.dispatchEvent && win.Event) {
                    try {
                        mediaDevices.dispatchEvent(new win.Event('devicechange'));
                    } catch (_error) { }
                }
                return stream;
            }).catch(() => { });
        }
    });
};

/**
 * Handle microphone access denied modal
 */
export const handleMicrophoneAccessDenied = () => {
    cy.log('Handling microphone access denied');
    cy.get('body').then(($body) => {
        if ($body.text().includes('microphone access was denied')) {
            cy.contains('button', 'Check microphone access').click({ force: true });
            cy.wait(2000);
        }
    });
};

/**
 * Confirm finish conversation in modal
 */
export const confirmFinishConversation = () => {
    cy.log('Confirming finish conversation');
    cy.get('body').then(($body) => {
        if ($body.text().includes('Finish Conversation') || $body.text().includes('Are you sure')) {
            cy.contains('button', 'Yes').click({ force: true });
            cy.wait(2000);
        }
    });
};

/**
 * Finish recording from the pause/stop modal
 */
export const finishRecordingFromModal = () => {
    cy.log('Finishing recording from modal');
    cy.get('body').then(($body) => {
        if ($body.find('button:contains("Finish")').length > 0) {
            cy.contains('button', 'Finish').click({ force: true });
            cy.wait(1000);
        }
    });
};

/**
 * Retry recording if access was denied
 */
export const retryRecordingIfAccessDenied = () => {
    reapplyParticipantAudioStubs();
    primeMicrophoneAccess();
    cy.wait(1000);
    cy.get('body').then(($body) => {
        if ($body.text().includes('microphone access was denied')) {
            cy.contains('button', 'Check microphone access').click({ force: true });
            cy.wait(2000);
            reapplyParticipantAudioStubs();
            primeMicrophoneAccess();
            cy.contains('button', 'Record', { timeout: 15000 })
                .should('be.visible')
                .click({ force: true });
        }
    });
};

/**
 * Prepare for recording - handle any pre-recording states
 */
export const prepareForRecording = () => {
    reapplyParticipantAudioStubs();
    primeMicrophoneAccess();
};

