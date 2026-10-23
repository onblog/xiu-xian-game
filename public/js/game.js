// Game state.
const gameState = {
    // Random per-page-view id. Used only for log correlation on the Worker,
    // never stored and never used for any decision.
    sessionId: generateRandomId(),
    // Recent exchanges replayed with every request (see recordTurn).
    history: [],
    // Blob URL of the preloaded intro video; null until (or unless) it loads.
    videoUrl: null,
    loaded: false,
    resources: {
        opening: {
            bgImage: 'assets/images/opening-bg.webp'
        },
        game: {
            bgImage: 'assets/images/game-bg.webp'
        }
    }
};

// The intro video is fetched during the loading screen with real byte progress,
// then played from a blob URL so the first frame is instant.
const VIDEO_URL = 'assets/video/open-video.mp4?v=2';
const VIDEO_ESTIMATED_BYTES = 959153;

// DOM element references
const elements = {
    gameContainer: document.getElementById('game-container'),
    loadingContainer: document.getElementById('loading-container'),
    loadingProgress: document.getElementById('loading-progress'),
    loadingText: document.getElementById('loading-text'),
    musicPrompt: document.getElementById('music-prompt'),
    enableMusicBtn: document.getElementById('enable-music'),
    disableMusicBtn: document.getElementById('disable-music'),
    background: document.getElementById('background'),
    openingText: document.getElementById('opening-text'),
    storyText: document.getElementById('story-text'),
    optionsContainer: document.getElementById('options-container'),
    bgm: document.getElementById('bgm'),
    btnSound: document.getElementById('btn-sound'),
    settingsIcon: document.getElementById('settings-icon'),
    settingsModal: document.getElementById('settings-modal'),
    musicVolume: document.getElementById('music-volume'),
    volumeValue: document.getElementById('volume-value'),
    closeSettings: document.getElementById('close-settings')
};

// Create the API loading indicator
// Loading mask for the next round: a translucent scrim plus a spinner. It
// deliberately has no "loading" copy and no progress bar, so the previous
// scene stays readable underneath while the model composes the next one.
const apiLoadingContainer = document.createElement('div');
apiLoadingContainer.className = 'api-loading-container';
const apiLoadingSpinner = document.createElement('div');
apiLoadingSpinner.className = 'api-loading-spinner';
apiLoadingSpinner.setAttribute('role', 'status');
apiLoadingSpinner.setAttribute('aria-label', '正在生成下一轮');
apiLoadingContainer.appendChild(apiLoadingSpinner);
elements.gameContainer.appendChild(apiLoadingContainer);

// Initialize the game
function initGame() {
    loadResources(); // Load the real assets
    elements.background.src = gameState.resources.opening.bgImage;
    elements.bgm.loop = true;
}

// Play the opening video, then run the callback.
//
// Mobile autoplay policy is the dangerous part here. iOS and Android block
// audible autoplay; if play() is rejected and nothing else happens, the
// full-screen video layer (z-index 9999) would stay on top forever — which
// looks exactly like "the site does not open". Therefore:
//   - always ask for inline playback, never fullscreen;
//   - try audible playback first, fall back to muted, then skip entirely;
//   - a watchdog removes the layer even when no media event ever fires.
function playOpeningVideo(callback) {
    console.log('Playing the opening video…');

    let finished = false;
    let watchdog = null;

    // Create the video element.
    //
    // Append it to <body>, not #game-container: that element has transform,
    // will-change and contain: strict, and on iOS Safari a position: fixed
    // descendant of a transformed container can composite as a black frame
    // while playback itself continues. The container rect keeps the video
    // aligned with the game area instead of covering the whole desktop window.
    const rect = elements.gameContainer.getBoundingClientRect();
    const video = document.createElement('video');
    video.style.position = 'fixed';
    video.style.top = `${rect.top}px`;
    video.style.left = `${rect.left}px`;
    video.style.width = `${rect.width}px`;
    video.style.height = `${rect.height}px`;
    video.style.objectFit = 'cover';
    video.style.zIndex = '9999';
    video.style.backgroundColor = '#000'; // black so the swap is invisible
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.disablePictureInPicture = true;
    // Show the title art while the first frame is being fetched, so a slow
    // mobile connection never presents a pure black screen.
    video.poster = 'assets/images/opening-bg.webp';

    // The only source we ship. Do not over-specify the codec: the file is
    // H.264 High 4.1, and the old "avc1.42E01E" (Baseline 3.0) claim made
    // Safari pick the wrong decoder. "video/mp4" lets the browser probe it.
    const source = document.createElement('source');
    // Bump ?v when the file changes: /assets is cached for a day.
    source.src = gameState.videoUrl || VIDEO_URL;
    source.type = 'video/mp4';
    video.appendChild(source);

    video.preload = 'auto';

    document.body.appendChild(video);
    console.log('Video element attached to the DOM');

    const finish = () => {
        if (finished) return;
        finished = true;
        if (watchdog !== null) clearTimeout(watchdog);
        video.pause();
        if (video.parentNode) video.parentNode.removeChild(video);
        if (gameState.videoUrl !== null) {
            URL.revokeObjectURL(gameState.videoUrl);
            gameState.videoUrl = null;
        }
        if (callback) callback();
        createPetalEffect();
    };

    const startPlayback = () => {
        video.play().then(() => {
            console.log('Video: playing');
        }).catch(() => {
            // Audible playback was blocked (mobile). Muted playback is always
            // allowed; losing the intro audio beats a permanently stuck page.
            video.muted = true;
            video.play().then(() => {
                console.log('Video: playing muted');
            }).catch((error) => {
                console.error('Video playback failed, skipping:', error);
                finish();
            });
        });
    };

    video.addEventListener('canplay', startPlayback, { once: true });
    video.addEventListener('ended', finish);
    video.addEventListener('error', () => {
        console.error('Video failed to load, skipping');
        finish();
    });

    // Hard stop for a stalled network or a browser that never fires `ended`.
    watchdog = setTimeout(() => {
        console.warn('Video watchdog fired, skipping');
        finish();
    }, 10000);
}

// Show the music prompt
function showMusicPrompt() {
    elements.musicPrompt.style.display = 'flex';

    const enableHandler = () => {
        playButtonSound();
        elements.musicPrompt.style.display = 'none';
        startBackgroundMusic();

        // Play the video, then continue the original flow
        playOpeningVideo(() => {
            elements.openingText.style.display = 'flex'; // Make sure the opening text is visible
            showOpeningScene();
        });

        elements.enableMusicBtn.removeEventListener('click', enableHandler);
        elements.disableMusicBtn.removeEventListener('click', disableHandler);
        // Show the settings icon
        elements.settingsIcon.style.display = 'block';
        // Sync the music toggle with the current state
        musicEnabled = true;
        document.querySelector('input[name="music-toggle"][value="on"]').checked = true;
    };

    const disableHandler = () => {
        playButtonSound();
        elements.musicPrompt.style.display = 'none';

        // Play the video, then continue the original flow
        playOpeningVideo(() => {
            elements.openingText.style.display = 'flex'; // Make sure the opening text is visible
            showOpeningScene();
        });

        elements.enableMusicBtn.removeEventListener('click', enableHandler);
        elements.disableMusicBtn.removeEventListener('click', disableHandler);
        // Show the settings icon
        elements.settingsIcon.style.display = 'block';
        // Sync the music toggle with the current state
        musicEnabled = false;
        document.querySelector('input[name="music-toggle"][value="off"]').checked = !musicEnabled;
    };

    elements.enableMusicBtn.addEventListener('click', enableHandler);
    elements.disableMusicBtn.addEventListener('click', disableHandler);
}

// Start the background music
function startBackgroundMusic() {
    // The BGM is ~970KB. It is deliberately not preloaded: players who decline
    // music should not pay for it on a mobile connection.
    if (!elements.bgm.src) {
        elements.bgm.src = 'assets/audio/bgm.mp3';
        elements.bgm.load();
    }

    // Pause first so the state is fully reset
    elements.bgm.pause();
    elements.bgm.currentTime = 0;

    // Try to play right away
    elements.bgm.play()
        .then(() => console.log('Background music started'))
        .catch(e => {
            console.log('Autoplay blocked:', e);
        });
}

// Wait until the audio file is ready
if (elements.bgm.readyState > 3) {
    // Ready: wait for the player to choose
} else {
    elements.bgm.addEventListener('canplaythrough', () => {
        // Audio is ready: wait for the player to choose
    }, { once: true });
    elements.bgm.load();
}

// Real asset loading.
//
// The intro video is part of this screen. It is fetched as a byte stream so the
// progress bar reflects the real download; the fetched Blob becomes an object
// URL that playOpeningVideo() reuses, so the video starts with no second
// network round trip. A 15s timeout (or a failed fetch) releases the screen and
// lets the video stream on demand instead of trapping the player.
function loadResources() {
    const resources = [
        { type: 'image', url: 'assets/images/opening-bg.webp' },
        { type: 'image', url: 'assets/images/game-bg.webp' },
        { type: 'audio', url: 'assets/audio/button.mp3' },
        { type: 'font', url: 'assets/font/LXGWWenKai-Regular.woff2' }
    ];

    let assetsDone = false;
    let videoDone = false;
    let finished = false;
    let videoPercent = 0;
    let videoBytes = 0;
    let videoTotal = VIDEO_ESTIMATED_BYTES;
    let checkCount = 0;
    const maxChecks = 5;

    const resourceElements = resources.map(resource => createResourceElement(resource));

    function renderProgress() {
        const percent = videoDone ? 100 : Math.min(99, videoPercent);
        elements.loadingProgress.style.width = `${percent}%`;
        if (elements.loadingText) {
            elements.loadingText.textContent = finished
                ? '资源加载完成'
                : videoDone
                  ? '资源加载中...'
                  : `正在加载开场视频 ${percent}%`;
        }
    }

    function maybeComplete() {
        if (finished || !assetsDone || !videoDone) return;
        finished = true;
        renderProgress();
        gameState.loaded = true;
        elements.loadingContainer.style.display = 'none';
        showMusicPrompt();
    }

    function markAssetsDone() {
        if (assetsDone) return;
        assetsDone = true;
        renderProgress();
        maybeComplete();
    }

    // Real byte-level video preload.
    const controller = new AbortController();
    fetch(VIDEO_URL, { signal: controller.signal })
        .then(response => {
            if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
            const length = Number(response.headers.get('content-length'));
            if (Number.isFinite(length) && length > 0) videoTotal = length;

            const reader = response.body.getReader();
            const chunks = [];
            const pump = () => reader.read().then(({ done, value }) => {
                if (done) {
                    gameState.videoUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
                    videoPercent = 100;
                    videoDone = true;
                    renderProgress();
                    maybeComplete();
                    return;
                }
                chunks.push(value);
                videoBytes += value.length;
                videoPercent = Math.min(99, Math.round((videoBytes / videoTotal) * 100));
                renderProgress();
                return pump();
            });
            return pump();
        })
        .catch(error => {
            if (error.name !== 'AbortError') {
                console.warn('Video preload failed, will stream on demand:', error);
            }
            videoDone = true;
            maybeComplete();
        });

    // Never hold the game hostage for the video.
    setTimeout(() => {
        if (videoDone) return;
        console.warn('Video preload timeout; continuing with on-demand playback');
        controller.abort();
        videoDone = true;
        maybeComplete();
    }, 15000);

    function checkResources() {
        checkCount++;
        console.log(`Asset check #${checkCount}`);

        // Only images gate the loader; audio and font must not hold the screen.
        const currentLoaded = resourceElements.filter(el => !(el instanceof Image) || el.complete).length;
        if (currentLoaded >= resources.length) {
            console.log('All assets loaded');
            markAssetsDone();
        } else if (checkCount < maxChecks) {
            setTimeout(checkResources, 1000);
        } else {
            console.log('Asset polling budget spent; continuing');
            markAssetsDone();
        }
    }

    renderProgress();
    checkResources();
}

function createResourceElement(resource) {
    switch (resource.type) {
        case 'image':
            const img = new Image();
            img.src = resource.url;
            return img;
        case 'audio':
            const audio = new Audio();
            audio.src = resource.url;
            return audio;
        case 'font':
            const link = document.createElement('link');
            link.rel = 'preload';
            link.href = resource.url;
            link.as = 'font';
            link.type = 'font/woff2';
            link.crossOrigin = 'anonymous';
            document.head.appendChild(link);
            return link;
        default:
            return document.createElement('div');
    }
}

function updateProgress(loaded, total) {
    const progress = Math.round((loaded / total) * 100);
    elements.loadingProgress.style.width = `${progress}%`;

    if (loaded === total) {
        gameState.loaded = true;
        elements.loadingContainer.style.display = 'none';
        showMusicPrompt();
    }
}

// Show the opening scene
function showOpeningScene() {
    elements.storyText.style.display = 'none';
    elements.openingText.style.display = 'none';
    elements.optionsContainer.innerHTML = '';

    // 1. Background image
    elements.background.style.opacity = '1';

    // 2. Type the opening line
    elements.openingText.style.display = 'block';
    const fullText = '苍莽神州，大道三千，唯有修仙者可破凡胎桎梏，逆天改命。当你睁眼，已不再是局外看客 —— 而是厉飞雨！是否立马夺舍厉飞雨，和韩立一起开启新的旅程？';
    let charIndex = 0;
    const charsPerTick = Math.max(
        1,
        Math.ceil(fullText.length / (TYPEWRITER_BUDGET_MS / TYPEWRITER_TICK_MS))
    );

    const typingInterval = setInterval(() => {
        if (charIndex < fullText.length) {
            const nextChunk = fullText.slice(charIndex, charIndex + charsPerTick);
            elements.openingText.textContent += nextChunk;
            charIndex += nextChunk.length;
            elements.openingText.scrollTop = elements.openingText.scrollHeight;
        } else {
            clearInterval(typingInterval);

            // 3. Then show the button
            const btn = document.createElement('button');
            btn.className = 'btn btn-option pulse-animation';
            btn.textContent = '是';

            // Button click handler
            setupPulseButton(btn);

            elements.optionsContainer.appendChild(btn);
            elements.optionsContainer.style.display = 'flex';
        }
    }, TYPEWRITER_TICK_MS);
}

function setupPulseButton(btn) {
    // Hover affordance
    const handleMouseEnter = () => {
        btn.style.transform = 'scale(1.15)';
    };
    const handleMouseLeave = () => {
        btn.style.transform = 'scale(1)';
    };

    btn.addEventListener('mouseenter', handleMouseEnter);
    btn.addEventListener('mouseleave', handleMouseLeave);

    btn.addEventListener('click', () => {
        // Disable immediately to prevent double submits
        btn.disabled = true;
        btn.classList.remove('pulse-animation');
        btn.style.transform = 'scale(1)';
        btn.removeEventListener('mouseenter', handleMouseEnter);
        btn.removeEventListener('mouseleave', handleMouseLeave);
        playButtonSound();

        // Remove the button right away (no fade-out)
        elements.optionsContainer.removeChild(btn);

        // Keep the prologue visible under the mask until the first scene
        // arrives; processMessageData hides it right before typing starts.
        apiLoadingContainer.style.display = 'flex';

        // Switch to the in-game background
        elements.background.src = gameState.resources.game.bgImage;

        APIService.sendChoice('是')
            .then(response => {
                // The typewriter handles the payload
            })
            .catch(error => {
                console.error('Request failed:', error);
                showRetry(error);
            })
            .finally(() => {
                btn.disabled = false;
                btn.classList.remove('btn-disabled');
                apiLoadingContainer.style.display = 'none';
            });
    });

}

/**
 * Error fallback.
 *
 * ⚠️ This is the only functional addition to the original frontend. The
 * original page talked to a hosted agent and had no concept of a budget, so a
 * failure could only be the network — one hard-coded "please retry" was enough.
 * Now the daily experience budget is a real thing players hit, so the Worker's
 * message must be shown; otherwise the game just looks broken.
 *
 * It also adds a restart button: the original left the options area empty and
 * expected a manual page refresh.
 */
function showRetry(error) {
    const message = (error && error.message) ? error.message : '请求处理出错，请重试';
    elements.storyText.textContent = message;
    elements.storyText.style.display = 'block';

    elements.optionsContainer.innerHTML = '';
    elements.optionsContainer.style.display = 'flex';
    const btn = document.createElement('button');
    btn.className = 'btn btn-option';
    btn.textContent = '重启';
    btn.addEventListener('click', () => {
        playButtonSound();
        location.reload();
    });
    elements.optionsContainer.appendChild(btn);
}

// Replay window size in messages (15 exchanges). Mirrors
// GAME_HISTORY_MAX_EXCHANGES in server/limits.ts — the server trims again.
const MAX_HISTORY_MESSAGES = 30;

// Both typewriters reveal their whole text within this budget. The character
// count per tick is derived from the remaining time, so a 300-character model
// reply no longer turns into a ten-second wait.
const TYPEWRITER_BUDGET_MS = 1800;
const TYPEWRITER_TICK_MS = 14;

// Append one completed exchange to the in-memory replay window.
//
// Only successful steps are recorded; a failed request is not part of the story
// and must not be replayed to the model. The oldest messages are dropped so the
// request body never grows without bound.
function recordTurn(choice, reply) {
    if (typeof reply !== 'string' || reply.trim() === '') return;
    gameState.history.push(
        { role: 'user', content: choice },
        { role: 'assistant', content: reply }
    );
    if (gameState.history.length > MAX_HISTORY_MESSAGES) {
        gameState.history.splice(0, gameState.history.length - MAX_HISTORY_MESSAGES);
    }
}

// API client.
//
// The Worker answers each step with one Server-Sent Event:
//
//     data: {"text":"…","done":true}
//
// The typewriter turns that payload into the progressive reveal, so the pacing
// matches a token stream. No vendor-specific protocol is involved: switching
// models happens entirely on the server (see server/ai.ts).
const APIService = {
    baseUrl: '/api/chat',

    async sendChoice(choice) {
        // Snapshot the window so a concurrent step cannot mutate what we send.
        const history = gameState.history.slice();
        return new Promise((resolve, reject) => {
            fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    sessionId: gameState.sessionId,
                    choice: choice,
                    history: history
                })
            })
                .then(async response => {
                    if (!response.ok) {
                        // Rejections use a JSON envelope
                        // `{ ok:false, error:{ code, message } }`. Surfacing the
                        // message is what lets the player see a real reason
                        // (the daily experience budget being used up).
                        let message = `请求处理出错，请重试（HTTP ${response.status}）`;
                        try {
                            const body = await response.json();
                            if (body && body.error && body.error.message) {
                                message = body.error.message;
                            }
                        } catch (e) {
                            // Not JSON (gateway error page): keep the fallback.
                        }
                        throw new Error(message);
                    }

                    elements.optionsContainer.innerHTML = '';

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let isFirstMessage = true;
                    let fullResponse = '';
                    let rawResponse = '';
                    let buffer = '';
                    let timeoutId;

                    // The upstream call is non-streaming, so this covers full
                    // generation time rather than time-to-first-token.
                    timeoutId = setTimeout(() => {
                        console.error('API request timed out');
                        reader.cancel('timeout');
                        reject(new Error('API请求超时'));
                    }, 60000);

                    function readStream() {
                        return reader.read().then(({ done, value }) => {
                            if (done) {
                                clearTimeout(timeoutId);
                                // Parse whatever is left in the buffer.
                                if (buffer.trim()) {
                                    try {
                                        const jsonData = JSON.parse(buffer.substring(5));
                                        processMessageData(jsonData);
                                    } catch (e) {
                                        console.warn('Unparsed SSE tail:', buffer);
                                    }
                                }
                                // `readStream()` itself resolves with
                                // undefined, so the outer promise chain can
                                // never see this text. Record the turn here:
                                // this is what keeps the replay window
                                // populated between requests.
                                const finalText = rawResponse || fullResponse;
                                resolve(finalText);
                                recordTurn(choice, finalText);
                                return;
                            }

                            try {
                                const chunk = decoder.decode(value, { stream: true });
                                buffer += chunk;

                                // Process complete lines; keep a partial tail.
                                const lines = buffer.split('\n');
                                buffer = lines.pop() || '';

                                lines.forEach(line => {
                                    if (line.startsWith('data:')) {
                                        try {
                                            const jsonData = JSON.parse(line.substring(5));
                                            processMessageData(jsonData);
                                        } catch (e) {
                                            console.warn('Bad SSE data line:', line);
                                            console.error('SSE parse error:', e);
                                        }
                                    }
                                });

                                return readStream();
                            } catch (error) {
                                clearTimeout(timeoutId);
                                console.error('Stream handling error:', error);
                                reject(error);
                            }
                        }).catch(error => {
                            clearTimeout(timeoutId);
                            console.error('Stream read error:', error);
                            reject(error);
                        });
                    }

                    function processMessageData(jsonData) {
                        if (jsonData && typeof jsonData.text === 'string') {
                            // Start the typewriter on the first payload.
                            if (isFirstMessage) {
                                // The prologue stayed visible under the mask;
                                // replace it with the first scene now.
                                elements.openingText.style.display = 'none';
                                Typewriter.reset();
                                Typewriter.startTyping();
                                isFirstMessage = false;
                            }

                            // Keep the raw text for replay; strip markdown noise
                            // from what the typewriter displays.
                            rawResponse += jsonData.text;
                            const processedText = jsonData.text
                                .replace(/\n\n+/g, '\n').replace(/\*\*/g, '');
                            Typewriter.addText(processedText);
                            fullResponse += processedText;
                        }

                        // End marker: let the typewriter finish before showing
                        // the choice buttons.
                        if (jsonData && jsonData.done) {
                            Typewriter.hasEndTurn = true;
                            Typewriter.finalResponse = fullResponse;
                            Typewriter.finishIfIdle();
                        }
                    }

                    return readStream();
                })
                .catch(error => {
                    console.error('API request failed:', error);
                    reject(error);
                });
        });
    }
};

// Typewriter controller
const Typewriter = {
    textQueue: '',
    isTyping: false,
    tickMs: TYPEWRITER_TICK_MS,
    budgetMs: TYPEWRITER_BUDGET_MS,
    startedAt: 0,
    currentInterval: null,
    fullDisplayedText: '',

    // Append text to the queue
    addText(newText) {
        // Only add new content (avoid duplicates)
        if (newText && !this.fullDisplayedText.includes(newText)) {
            this.textQueue += newText;
            if (!this.isTyping) {
                this.startTyping();
            }
        }
    },

    // Start typing
    startTyping() {
        this.isTyping = true;
        this.hasEndTurn = false;
        this.finalResponse = '';
        this.startedAt = performance.now();
        elements.storyText.style.display = 'block';

        this.currentInterval = setInterval(() => {
            if (this.textQueue.length > 0) {
                // Spread whatever is left over the remaining budget: at the
                // start this is ~N chars per tick, and it accelerates if the
                // queue grew after typing began.
                const elapsed = performance.now() - this.startedAt;
                const remainingMs = Math.max(this.tickMs, this.budgetMs - elapsed);
                const remainingTicks = Math.max(1, Math.ceil(remainingMs / this.tickMs));
                const take = Math.max(1, Math.ceil(this.textQueue.length / remainingTicks));

                const chunk = this.textQueue.slice(0, take);
                this.fullDisplayedText += chunk;
                this.textQueue = this.textQueue.slice(take);
                elements.storyText.innerHTML = this.fullDisplayedText; // innerHTML so <br> renders
                elements.storyText.scrollTop = elements.storyText.scrollHeight;

                // Hide the loader once there is content
                if (this.fullDisplayedText.length > 0) {
                    apiLoadingContainer.style.display = 'none';
                }
            } else {
                this.stopTyping();
                this.finishIfIdle();
            }
        }, this.tickMs);
    },

    // Render the choices when the end marker arrives after typing stopped.
    finishIfIdle() {
        if (this.isTyping || this.textQueue.length > 0) return;
        if (this.hasEndTurn && !this.hasHandledFinalResponse) {
            this.hasHandledFinalResponse = true;
            handleFinalResponse(this.finalResponse || this.fullDisplayedText);
        }
    },

    // Stop typing
    stopTyping() {
        if (this.currentInterval) {
            clearInterval(this.currentInterval);
            this.currentInterval = null;
        }
        this.isTyping = false;
    },

    // Reset
    reset() {
        this.stopTyping();
        this.textQueue = '';
        this.fullDisplayedText = '';
        this.hasEndTurn = false;
        this.finalResponse = '';
        this.startedAt = 0;
        this.hasHandledFinalResponse = false;
        elements.storyText.textContent = '';
        elements.storyText.style.display = 'none';
    }
};

// Render the finished response (after typing completes)
function handleFinalResponse(displayText) {
    console.log('Final response:', displayText); // debug
    try {
        // Choice scene
        if (typeof displayText === 'string' && displayText.includes('📌')) {
            const parts = displayText.split('📌');
            const optionsText = parts[1] || '';
            const options = optionsText.trim().split('\n')
                .filter(line => line.match(/^[A-C]\./))
                .map(line => line.trim());

            // Reset and show the options container
            elements.optionsContainer.innerHTML = '';
            elements.optionsContainer.style.display = 'flex'; // make sure it is visible

            options.forEach(option => {
                const btn = document.createElement('button');
                btn.className = 'btn btn-option';
                btn.textContent = '选择' + option.charAt(0);
                btn.addEventListener('click', () => {
                    playButtonSound();
                    btn.disabled = true;
                    btn.classList.add('btn-disabled');

                    // Keep the previous scene on screen under the mask. The
                    // typewriter is reset only when the new payload arrives
                    // (processMessageData), so the player can still re-read it
                    // while waiting.
                    apiLoadingContainer.style.display = 'flex';

                    APIService.sendChoice(option.charAt(0))
                        .then(() => {
                            // The typewriter handles the payload
                        })
                        .catch(error => {
                            // Unlike the original, show the reason the Worker gave (the daily budget)
                            // and offer a restart button. See showRetry.
                            showRetry(error);
                        })
                        .finally(() => {
                            apiLoadingContainer.style.display = 'none';
                            btn.disabled = false;
                            btn.classList.remove('btn-disabled');
                        });
                });
                elements.optionsContainer.appendChild(btn);
            });
        } else if (Typewriter.textQueue.length === 0 && !Typewriter.isTyping) {
            // Offer restart only after typing has finished
            const btn = document.createElement('button');
            btn.className = 'btn btn-option';
            btn.textContent = '重启';
            btn.addEventListener('click', () => {
                playButtonSound();
                location.reload();
            });
            elements.optionsContainer.innerHTML = '';
            elements.optionsContainer.style.display = 'flex';
            elements.optionsContainer.appendChild(btn);
        }
    } catch (error) {
        console.error('Failed to render the final response:', error);
        if (Typewriter.textQueue.length === 0 && !Typewriter.isTyping) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-option';
            btn.textContent = '重启';
            btn.addEventListener('click', () => {
                playButtonSound();
                location.reload();
            });
            elements.optionsContainer.innerHTML = '';
            elements.optionsContainer.style.display = 'flex';
            elements.optionsContainer.appendChild(btn);
        }
    }
}


// Create the petal effect
function createPetalEffect() {
    const petalCount = 15; // keep the effect light
    const container = elements.gameContainer;
    
    // Remove petals from a previous run
    const existingPetals = container.querySelectorAll('.petal');
    existingPetals.forEach(petal => container.removeChild(petal));
    
    for (let i = 0; i < petalCount; i++) {
        const petal = document.createElement('div');
        
        // Random type, size and colour
        const petalTypes = ['pink', 'white', 'purple'];
        const sizes = ['small', 'medium', 'large'];
        const type = petalTypes[Math.floor(Math.random() * petalTypes.length)];
        const size = sizes[Math.floor(Math.random() * sizes.length)];
        
        petal.className = `petal ${type} ${size}`;
        
        // Start off-screen horizontally
        const startPos = Math.random() * 100;
        petal.style.left = `${startPos}%`;
        petal.style.top = '-30px';
        
        // Random animation parameters
        const duration = Math.random() * 8 + 12; // 12-20s fall time
        const delay = Math.random() * 8; // random start delay
        const xMovement = (Math.random() * 40 - 20); // horizontal drift
        
        // Unique keyframes per petal
        const animationName = `fall-${i}`;
        createPetalAnimation(animationName, xMovement);
        
        petal.style.animation = `
            ${animationName} ${duration}s ease-in-out ${delay}s infinite
        `;
        
        // Random initial rotation
        const startRotation = Math.random() * 360;
        petal.style.transform = `rotate(${startRotation}deg)`;
        
        container.appendChild(petal);
    }
}

// Build the keyframes for one petal
function createPetalAnimation(name, xMovement) {
    const styleElement = document.createElement('style');
    styleElement.type = 'text/css';
    styleElement.innerHTML = `
        @keyframes ${name} {
            0% {
                transform: translate(0, 0) rotate(0deg);
                opacity: 1;
            }
            25% {
                transform: translate(${xMovement / 2}px, 25vh) rotate(90deg);
            }
            50% {
                transform: translate(${xMovement}px, 50vh) rotate(180deg);
                opacity: 0.8;
            }
            75% {
                transform: translate(${xMovement / 2}px, 75vh) rotate(270deg);
                opacity: 0.6;
            }
            100% {
                transform: translate(0, 100vh) rotate(360deg);
                opacity: 0;
            }
        }
    `;
    document.head.appendChild(styleElement);
}

// Button click sound
function playButtonSound() {
    elements.btnSound.currentTime = 0;
    elements.btnSound.play().catch(e => console.log('Button sound failed:', e));
}

// Random id
function generateRandomId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// The original also had a getOpenId() that stitched user agent, screen size,
// timezone and hardware concurrency into a browser fingerprint and sent it along
// as the agent's openId. The Worker needs no client identifier at all, so the
// whole block is gone — one fingerprint less collected.

// In-memory music toggle state
let musicEnabled = true;

// Volume controls
function initVolumeControl() {
    /**
     * Apply one volume step (0-100): update the number next to the slider and
     * both audio elements.
     *
     * ⚠️ The original only bound the slider's `input` event and never applied
     * the initial value — the slider showed 100 while `audio.volume` kept
     * HTMLMediaElement's default of 1 (also 100%). Display and reality only
     * agreed after the first drag. Applying the current value before binding
     * the listener is what makes the HTML default (50) real.
     */
    const applyVolume = (volume) => {
        const volumeDecimal = volume / 100;
        elements.volumeValue.textContent = volume;
        elements.bgm.volume = volumeDecimal;
        elements.btnSound.volume = volumeDecimal;
    };

    // Apply the current slider value (50% by default), then bind events
    applyVolume(elements.musicVolume.value);

    elements.musicVolume.addEventListener('input', (e) => {
        applyVolume(e.target.value);
        // Not persisted: a reload returns to the HTML default, same as the original
        localStorage.setItem('gameVolume', e.target.value);
    });

    // Music toggle
    const musicToggleInputs = document.querySelectorAll('input[name="music-toggle"]');
    musicToggleInputs.forEach(input => {
        input.checked = (input.value === 'on') === musicEnabled;
        input.addEventListener('change', (e) => {
            musicEnabled = e.target.value === 'on';
            musicToggleInputs.forEach(radio => {
                radio.checked = (radio.value === 'on') === musicEnabled;
            });
            if (musicEnabled) {
                startBackgroundMusic();
            } else {
                elements.bgm.pause();
            }
        });
    });

    // Settings icon
    elements.settingsIcon.addEventListener('click', () => {
        playButtonSound();
        elements.settingsModal.style.display = 'flex';
    });

    // Close the settings modal
    elements.closeSettings.addEventListener('click', () => {
        playButtonSound();
        elements.settingsModal.style.display = 'none';
    });
}

// Start the game
window.onload = function () {
    initGame();
    initVolumeControl();
};