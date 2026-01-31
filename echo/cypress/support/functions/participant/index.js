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
    cy.get('button')
        .contains('I understand')
        .should('be.visible')
        .should('not.be.disabled')
        .click();
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
    cy.get('input[placeholder="Group 1, John Doe, etc."]', { timeout: 15000 })
        .should('be.visible')
        .clear()
        .type(name);
    cy.get('button')
        .contains('Next', { timeout: 15000 })
        .should('be.visible')
        .should('not.be.disabled')
        .click({ force: true });
    cy.wait(2000);
};

/**
 * Starts the recording by clicking the Record button
 */
export const startRecording = () => {
    cy.log('Starting Recording');
    cy.contains('button', 'Record', { timeout: 15000 })
        .should('be.visible')
        .click({ force: true });
};

/**
 * Stops the recording by clicking the Stop button
 */
export const stopRecording = () => {
    cy.log('Stopping Recording');
    cy.contains('button', 'Stop', { timeout: 15000 })
        .should('be.visible')
        .click({ force: true });
    cy.wait(1000);
};

/**
 * Finishes the recording session by clicking the Finish button
 */
export const finishRecording = () => {
    cy.log('Finishing Recording');
    cy.contains('button', 'Finish', { timeout: 15000 })
        .should('be.visible')
        .click({ force: true });
    cy.wait(2000);
};

/**
 * Installs audio/mic stubs before loading the portal so WebKit/Firefox/Chromium
 * can all use a consistent fake microphone stream.
 * @param {Object} options
 * @param {string} options.audioBase64 - Base64-encoded audio payload.
 * @param {string} [options.audioMimeType="audio/mpeg"] - MIME type for the audio payload.
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
                } catch (_error) {}
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
                } catch (_error) {}
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
                    return { connect() {}, disconnect() {} };
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
                        stop() {},
                    };
                    return { stream: new win.MediaStream([track]) };
                };
            }

            if (typeof win.AudioContext.prototype.createMediaElementSource !== 'function') {
                win.AudioContext.prototype.createMediaElementSource = function () {
                    return { connect() {}, disconnect() {} };
                };
            }

            if (typeof win.AudioContext.prototype.createOscillator !== 'function') {
                win.AudioContext.prototype.createOscillator = function () {
                    return {
                        connect() {},
                        disconnect() {},
                        start() {},
                        stop() {},
                        frequency: { value: 440 },
                        type: 'sine',
                    };
                };
            }

            if (typeof win.AudioContext.prototype.createScriptProcessor !== 'function') {
                win.AudioContext.prototype.createScriptProcessor = function () {
                    return {
                        onaudioprocess: null,
                        connect() {},
                        disconnect() {},
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
                    } catch (_error) {}
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
                            connect() {},
                            disconnect() {},
                        };
                    }
                };
            } else {
                AudioContextCtor.prototype.createMediaStreamSource = function () {
                    return {
                        connect() {},
                        disconnect() {},
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
        const hasWavPayload = Boolean(audioBase64 && audioMimeType && audioMimeType.includes('wav'));

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

            if (hasWavPayload) {
                try {
                    const bytes = base64ToUint8Array(audioBase64);
                    win.__cypressAudioBlob = new Blob([bytes], { type: 'audio/wav' });
                    return win.__cypressAudioBlob;
                } catch (_error) {}
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
                        stop() {},
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
                        stop() {},
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
                            audioCtx.resume().catch(() => {});
                        }
                        audioEl.play().catch(() => {});
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
                    audioCtx.resume().catch(() => {});
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
                    stop() {},
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
                    stop() {},
                };
                return new win.MediaStream([track]);
            }
        };

        const ensurePlayback = () => {
            if (win.__cypressAudioElement) {
                try {
                    win.__cypressAudioElement.play().catch(() => {});
                } catch (_error) {}
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
                                this.requestData();
                            }
                        }, timeslice);
                    }
                }

                stop() {
                    if (this.state === 'inactive') {
                        return;
                    }
                    this.requestData();
                    this.state = 'inactive';
                    if (this._slicing) {
                        win.clearInterval(this._slicing);
                        this._slicing = null;
                    }
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
                    const blob = getRecordingBlob();
                    emit(this, 'dataavailable', blob);
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

            CypressMediaRecorder.isTypeSupported = (mimeType) => mimeType === 'audio/wav';
            CypressMediaRecorder.prototype.mimeType = 'audio/wav';

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
                addEventListener() {},
                removeEventListener() {},
                dispatchEvent() {},
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
        };

        win.__cypressBuildAudioStream = buildAudioStream;
        win.__cypressApplyMediaStubs = applyMediaStubs;
        win.__cypressEnsureAudioPlayback = ensurePlayback;
        win.__cypressGetAudioBlob = getRecordingBlob;

        applyMediaStubs();
        installMediaRecorderStub();
    });
};

/**
 * Re-applies the media stubs after navigation or user interactions.
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
 * Actively request mic access to unblock UI state in WebKit.
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
                    } catch (_error) {}
                }
                return stream;
            }).catch(() => {});
        }
    });
};

/**
 * Handles the "microphone access was denied" modal if it appears.
 */
export const handleMicrophoneAccessDenied = () => {
    cy.get('body').then(($body) => {
        if ($body.text().includes('microphone access was denied')) {
            cy.contains('button', 'Check microphone access').click({ force: true });
            cy.wait(2000);
        }
    });
};

/**
 * If the mic access denied modal appears after recording starts, retry after reapplying stubs.
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
 * Applies mic stubs and primes access before starting recording.
 */
export const prepareForRecording = () => {
    reapplyParticipantAudioStubs();
    primeMicrophoneAccess();
};

/**
 * Continues past the microphone check once the audio level is detected.
 */
export const continueMicrophoneCheck = ({ allowSkip = false } = {}) => {
    const attemptContinue = (remaining) => {
        return cy.get('body', { timeout: 20000 }).then(($body) => {
            if ($body.text().includes('microphone access was denied')) {
                cy.contains('button', 'Check microphone access').click({ force: true });
                cy.wait(2000);
                reapplyParticipantAudioStubs();
            }

            const continueButton = $body.find('button').filter((_, el) =>
                (el.textContent || '').trim().includes('Continue'),
            );

            if (continueButton.length > 0) {
                const $continue = continueButton.first();
                if ($continue.is(':disabled')) {
                    if (remaining <= 0) {
                        if (allowSkip) {
                            const skipButton = $body.find('button').filter((_, el) =>
                                (el.textContent || '').trim().includes('Skip'),
                            );

                            if (skipButton.length > 0) {
                                cy.wrap(skipButton.first())
                                    .should('be.visible')
                                    .click({ force: true });
                                return;
                            }
                        }

                        throw new Error('Continue button is still disabled after retries.');
                    }
                    cy.wait(2000);
                    primeMicrophoneAccess();
                    return attemptContinue(remaining - 1);
                }

                cy.wrap($continue)
                    .should('be.visible')
                    .click({ force: true });
                return;
            }

            if (allowSkip) {
                const skipButton = $body.find('button').filter((_, el) =>
                    (el.textContent || '').trim().includes('Skip'),
                );

                if (skipButton.length > 0) {
                    cy.wrap(skipButton.first())
                        .should('be.visible')
                        .click({ force: true });
                    return;
                }
            }

            if (remaining <= 0) {
                if (allowSkip) {
                    const skipButton = $body.find('button').filter((_, el) =>
                        (el.textContent || '').trim().includes('Skip'),
                    );

                    if (skipButton.length > 0) {
                        cy.wrap(skipButton.first())
                            .should('be.visible')
                            .click({ force: true });
                        return;
                    }
                }

                throw new Error('Continue button not available on the microphone check step.');
            }

            cy.wait(2000);
            primeMicrophoneAccess();
            return attemptContinue(remaining - 1);
        });
    };

    return attemptContinue(4);
};

/**
 * Confirms the "Finish Conversation" dialog if it appears.
 */
export const confirmFinishConversation = () => {
    cy.get('body').then(($body) => {
        if ($body.text().includes('Finish Conversation')) {
            cy.contains('button', 'Yes').click({ force: true });
        }
    });
};

/**
 * Clicks the Finish button inside the recording modal.
 */
export const finishRecordingFromModal = () => {
    cy.get('[role="dialog"]', { timeout: 15000 })
        .should('be.visible')
        .within(() => {
            cy.contains('button', 'Finish').should('be.visible').click({ force: true });
        });
};
