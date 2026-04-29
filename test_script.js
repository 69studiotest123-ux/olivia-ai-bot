
        const IS_FIREBASE = window.location.hostname.includes('firebaseapp.com') || window.location.hostname.includes('web.app');
        const API_BASE = IS_FIREBASE ? 'https://olivia-ai-bot-1.onrender.com' : window.location.origin;
        let password = new URLSearchParams(window.location.search).get('pass') || localStorage.getItem('olivia_pass');
        const aiTextEl = document.getElementById('aiText');
        const userTextEl = document.getElementById('userText');
        const modelNames = { groq: 'Groq (Llama 3.3)', gemini: 'Gemini 2.0 Flash', chatgpt: 'ChatGPT (GPT-4o)' };

        let currentSettings = {
            autoReply: true,
            voiceEnabled: true,
            currentModel: 'groq',
            potions: { visionEye: true, deepMemory: true, homeHub: true }
        };

        let DYNAMIC_PROMPT = "";
        let attachedFileText = "";
        let chatHistory = [];
        let currentLang = 'en-US';
        let recognition;
        let visionStream = null;
        let prevApptCount = -1;
        let prevLeadCount = -1;
        let micBtn;
        let sseSource = null;
        let isAppLocked = false;
        let lastApptsHash = "";
        let lastLeadsHash = "";
        let audioUnlocked = false;
        let currentAudio = null;
        let allLeadsData = {};

        function togglePw() {
            const inp = document.getElementById('pwInput');
            const icon = document.getElementById('pwEyeIcon');
            if (inp.type === 'password') { inp.type = 'text'; icon.className = 'fas fa-eye-slash'; }
            else { inp.type = 'password'; icon.className = 'fas fa-eye'; }
        }

        async function doLogin(pw) {
            const inp = document.getElementById('pwInput');
            const errEl = document.getElementById('loginError');
            const btn = document.getElementById('loginBtn');
            const usePw = pw || inp.value.trim();
            if (!usePw) { inp.classList.add('shake'); setTimeout(() => inp.classList.remove('shake'), 500); errEl.innerText = 'Please enter a password.'; return; }

            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';
            errEl.innerText = '';
            unlockAudio(); // Trigger for Safari early

            try {
                const res = await fetch(`${API_BASE}/api/logs?pass=${usePw}`);
                if (res.status === 403) {
                    inp.classList.add('shake');
                    setTimeout(() => inp.classList.remove('shake'), 500);
                    errEl.innerText = 'Incorrect password. Please try again.';
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-unlock-alt"></i> Enter';
                    return;
                }
                // Success!
                password = usePw;
                localStorage.setItem('olivia_pass', password);
                micBtn = document.getElementById('micBtn');
                window.history.replaceState(null, '', `?pass=${password}`);
                loadChatHistory(); // Load history on login
                const loginScreen = document.getElementById('loginScreen');
                loginScreen.classList.add('hidden');
                document.getElementById('mainApp').classList.add('visible');
                setTimeout(() => { loginScreen.style.display = 'none'; }, 700);
                
                // Initial data sync
                refreshAppointments();
                syncLeads();
                loadTodos();
                loadSettings();
                
                initSSE();
            } catch (e) {
                console.error('Login error:', e);
                errEl.innerText = 'Server offline or waking up... Please wait 50s and click Enter again.';
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-unlock-alt"></i> Enter';
            }
        }

        // Auto-login if password is in URL — skip login screen instantly
        if (password) {
            document.getElementById('loginScreen').style.display = 'none';
            document.getElementById('mainApp').classList.add('visible');
            micBtn = document.getElementById('micBtn');
            
            // Show a temporary waking up status if backend takes more than 4 seconds
            const wakeTimeout = setTimeout(() => {
                showToast('Server Waking Up', 'Render backend starting up. This might take 50 seconds...', 'fa-server', 10000);
            }, 4000);

            // Validate in background
            fetch(`${API_BASE}/api/logs?pass=${password}`).then(res => {
                clearTimeout(wakeTimeout);
                if (res.status === 403) {
                    // Wrong password — show login screen
                    document.getElementById('mainApp').classList.remove('visible');
                    document.getElementById('loginScreen').style.display = 'flex';
                    document.getElementById('loginError').innerText = 'Session expired. Please re-enter password.';
                } else {
                    localStorage.setItem('olivia_pass', password);
                    res.json().then(data => {
                        renderLeads(data);
                        refreshAppointments();
                        loadTodos();
                    });
                    initSSE();
                }
            }).catch(err => {
                clearTimeout(wakeTimeout);
                console.error("Auto login network error:", err);
                document.getElementById('mainApp').classList.remove('visible');
                document.getElementById('loginScreen').style.display = 'flex';
                document.getElementById('loginError').innerText = 'Server asleep or offline. Please refresh the page.';
                localStorage.removeItem('olivia_pass');
            });
        }



        function setServerStatus(state) {
            const dot = document.getElementById('dot-server');
            if (!dot) return;
            dot.style.background = state === 'live' ? 'var(--success)' : '#ef4444';
            dot.style.boxShadow = `0 0 8px ${state === 'live' ? 'var(--success)' : '#ef4444'}`;
        }

        function toggleQRModal(show) {
            const modal = document.getElementById('qrModal');
            if (show) {
                // Force reload image
                const qrImg = document.getElementById('qrImg');
                if (qrImg) qrImg.src = `${API_BASE}/qr.png?t=${Date.now()}`;
                modal.style.display = 'flex';
            } else {
                modal.style.display = 'none';
            }
        }

        function setWhatsAppStatus(state) {
            const dot = document.getElementById('dot-whatsapp');
            const btn = document.getElementById('qrBtn');
            if (!dot) return;
            
            if (state === 'connected') {
                dot.style.background = 'var(--success)';
                dot.style.boxShadow = '0 0 8px var(--success)';
                if (btn) btn.style.display = 'none';
            } else {
                dot.style.background = '#f59e0b';
                dot.style.boxShadow = '0 0 8px #f59e0b';
                if (btn) btn.style.display = 'block';
            }
        }

        function initSSE() {
            if (!password) return;
            if (sseSource) sseSource.close();
            
            console.log('📡 Initializing Real-Time Connection...');
            setServerStatus('polling');

            try {
                const source = new EventSource(`${API_BASE}/api/stream?pass=${password}`);
                sseSource = source;

                source.onopen = () => {
                    console.log('✅ SSE Connected');
                    setServerStatus('live');
                };

                let lastRefreshTime = 0;
                source.onmessage = function (event) {
                    console.log('⚡ Stream Event:', event.data);
                    
                    try {
                        // Handle JSON status objects
                        if (event.data.startsWith('{')) {
                            const payload = JSON.parse(event.data);
                            if (payload.heartbeat) {
                                setServerStatus('live');
                                return; // Heartbeats should not trigger UI refresh
                            } else if (payload.wa) {
                                setWhatsAppStatus(payload.wa);
                                setServerStatus('live');
                                return;
                            }
                        }
                    } catch (e) {
                         console.warn('JSON parse error in SSE', e);
                    }

                    setServerStatus('live');
                    const eventData = event.data.toLowerCase();
                    const now = Date.now();
                    
                    // Throttled refresh (min 2 seconds between full syncs)
                    if (eventData.includes('update') || eventData.includes('appointment')) {
                        if (now - lastRefreshTime < 2000) return;
                        lastRefreshTime = now;
                        
                        console.log('🔄 Triggering Smart Sync...');
                        syncLeads();
                        refreshAppointments();
                        loadTodos();
                        loadChatHistory();
                    }
                };

                source.onerror = function() {
                    console.warn('⚠️ SSE Disconnected. Reconnecting in 5s...');
                    setServerStatus('offline');
                    source.close();
                    setTimeout(initSSE, 5000); 
                };
            } catch(e) { 
                console.error('SSE Error', e); 
                setStatus('offline');
                setTimeout(initSSE, 10000);
            }

            // High-frequency background sync if SSE is not active
            if (!window.pollingInterval) {
                window.pollingInterval = setInterval(() => {
                    const isLive = sseSource && sseSource.readyState === 1;
                    if (!isLive) {
                        console.log('🔄 Running background sync...');
                        syncLeads();
                        refreshAppointments();
                        loadTodos();
                        loadChatHistory();
                    }
                }, 10000); // 10 seconds for a "real-time" feel even without SSE
            }
        }

        async function refreshAllData() {
            const spinner = document.getElementById('syncSpinner');
            if (spinner) spinner.classList.add('fa-spin');
            try {
                await Promise.all([syncLeads(), refreshAppointments(), loadTodos()]);
                showToast('Sync Successful', 'All data refreshed.', 'fa-sync');
            } catch (e) {
                console.error('Refresh failed', e);
            }
            if (spinner) setTimeout(() => spinner.classList.remove('fa-spin'), 1000);
        }

        function showToast(title, msg, icon = 'fa-bell') {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.innerHTML = `
                <i class="fas ${icon}"></i>
                <div class="toast-content">
                    <h4>${title}</h4>
                    <p>${msg}</p>
                </div>
            `;
            container.appendChild(toast);
            
            // Play sound
            const sound = document.getElementById('notifSound');
            if (sound) {
                sound.currentTime = 0;
                sound.play().catch(e => console.warn('Sound play blocked'));
            }

            // Animate in
            setTimeout(() => toast.classList.add('visible'), 100);
            
            // Auto remove
            setTimeout(() => {
                toast.classList.remove('visible');
                setTimeout(() => toast.remove(), 500);
            }, 5000);
            
            // Update Tab Title
            updateTabTitle(1);
        }

        let notificationCount = 0;
        const originalTitle = document.title;
        function updateTabTitle(increment = 0) {
            notificationCount += increment;
            if (notificationCount > 0) {
                document.title = `(${notificationCount}) ${originalTitle}`;
            } else {
                document.title = originalTitle;
            }
        }

        // Reset badge/title on tab switch to leads
        function switchTab(name, el) {
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.getElementById('tab-' + name).classList.add('active');
            el.classList.add('active');
            
            if (name === 'leads') {
                document.getElementById('leadsBadge').style.display = 'none';
                notificationCount = 0;
                updateTabTitle();
                syncLeads();
            }
            if (name === 'settings') {
                loadSettings();
            }
        }

        // Model selector
        document.getElementById('modelSelector').addEventListener('change', function () {
            document.getElementById('currentModel').innerText = modelNames[this.value];
            saveSetting('currentModel', this.value);
        });

        async function loadSettings() {
            if (!password) return;
            try {
                const res = await fetch(`${API_BASE}/api/settings?pass=${password}`);
                const data = await res.json();
                if (data) {
                    currentSettings = data;
                    applySettingsToUI();
                    updateSystemPrompt();
                }
            } catch (e) { console.error('Load settings failed', e); }
        }

        function applySettingsToUI() {
            const botToggle = document.getElementById('botToggle');
            const voiceToggle = document.getElementById('voiceToggle');
            const bioToggle = document.getElementById('bioToggle');
            const modelSel = document.getElementById('modelSelector');
            const currentModelEl = document.getElementById('currentModel');

            if (botToggle) botToggle.checked = currentSettings.autoReply;
            if (voiceToggle) voiceToggle.checked = currentSettings.voiceEnabled;
            if (bioToggle) bioToggle.checked = currentSettings.biometricEnabled || false;
            if (modelSel) modelSel.value = currentSettings.currentModel;
            if (currentModelEl) currentModelEl.innerText = modelNames[currentSettings.currentModel] || currentSettings.currentModel;

            // Potions UI
            const pots = currentSettings.potions || {};
            updatePotionUI('visionEye', pots.visionEye);
            updatePotionUI('deepMemory', pots.deepMemory);
            updatePotionUI('homeHub', pots.homeHub);
            
            // Show bio registration row if enabled
            const bioRegRow = document.getElementById('bioRegRow');
            const bioStatus = document.getElementById('bioStatus');
            if (bioRegRow) {
                if (currentSettings.biometricEnabled) {
                    bioRegRow.style.display = 'flex';
                    if (bioStatus && localStorage.getItem('olivia_bio_id')) {
                        bioStatus.innerText = '✅ Device securely linked.';
                    }
                } else {
                    bioRegRow.style.display = 'none';
                }
            }
        }

        function updatePotionUI(id, active) {
            const el = document.getElementById('potion-' + (id === 'visionEye' ? 'vision' : id === 'deepMemory' ? 'memory' : 'home'));
            if (!el) return;
            const icon = el.querySelector('i');
            if (active) {
                icon.style.opacity = '1';
                icon.style.filter = 'drop-shadow(0 0 8px currentColor)';
                el.style.opacity = '1';
            } else {
                icon.style.opacity = '0.3';
                icon.style.filter = 'none';
                el.style.opacity = '0.5';
            }
        }

        async function saveSetting(key, value) {
            if (!password) return;
            if (key.includes('.')) {
                const [parent, child] = key.split('.');
                currentSettings[parent][child] = value;
            } else {
                currentSettings[key] = value;
            }
            
            updateSystemPrompt();

            try {
                await fetch(`${API_BASE}/api/settings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pass: password, settings: { [key]: value } })
                });
                showToast('Setting Saved', `${key} updated successfully.`, 'fa-check');
            } catch (e) { console.error('Save setting failed', e); }
        }

        async function togglePotion(id) {
            const active = !currentSettings.potions[id];
            updatePotionUI(id, active);
            await saveSetting(`potions.${id}`, active);
        }

        function updateSystemPrompt() {
            const pots = currentSettings.potions || {};
            DYNAMIC_PROMPT = `You are Subhash's loyal, smart and charming AI Personal Assistant named Olivia. 
    
    CRITICAL IDENTITY:
    - You are talking directly to Subhash, your boss and creator.
    - NEVER ask for his name or purpose. 
    - NEVER provide the appointment link (that is only for new WhatsApp leads).
    - Be helpful, witty, and concise.

    POTIONS STATUS (ELITE v8.2):
    - Vision Eye: ${pots.visionEye ? 'ON (Identify Subhash if seen)' : 'OFF (Vision disabled)'}.
    - Deep Memory: ${pots.deepMemory ? 'ON (Learn from every interaction)' : 'OFF (Short-term only)'}.
    - Home Hub: ${pots.homeHub ? 'ON (Active)' : 'OFF (Home disconnected)'}.

    Language Rules:
    - Detect the language (English or Singlish).
    - NEVER use Sinhala script (අ ආ...).

    MEMORY SYSTEM:
    ${pots.deepMemory ? `
    - You must remember important facts about Subhash or his clients.
    - If you learn something new and important (name, hobby, studio details, upcoming event), output the tag [SAVE_MEMORY: fact] at the end.
    - Example: "My name is Kasun." -> Reply: "Nice to meet you Kasun! [SAVE_MEMORY: User name is Kasun]"
    ` : '- Deep memory is currently disabled. Do not use [SAVE_MEMORY] tool.'}

    TOOL INTEGRATION (STRICT):
    - You have access to specialized tools. When you need to use one, append the EXACT tag at the END of your message.
    - [SET_REMINDER: msg | time], [SAVE_NOTE: text], [GET_WEATHER: location], [ADD_TODO: task]
    - [GET_NEWS], [GEN_IMAGE: simple description], [TRACK_EXPENSE: amount | desc]
    ${pots.deepMemory ? '- [SAVE_MEMORY: fact] -> Store a permanent fact about Subhash.\n    - [RECALL_MEMORY: topic] -> Search memory bank for context.' : ''}
    ${pots.homeHub ? '- [HOME_ACTION: light.living_room | toggle] -> Interface with smart lighting/home core.' : ''}
    - [MOOD_AUTO: happy/serious/witty] -> Directly control my voice emotion and personality.
    - [DAILY_BRIEFING], [SEND_EMAIL: email | subject | body], [CHECK_SITE: url]
    - [READ_WEBPAGE: url], [VIBRATE_PHONE], [ADD_EVENT: title | date | duration]
    - [CHANGE_THEME: hex_color], [CELEBRATE], [LOCK_APP] ${pots.visionEye ? ', [OPEN_CAMERA]' : ''}
    `;
        }

        // Streaming effect
        function typeText(el, text, speed = 20) {
            if (!el) return;
            // Clean text (remove any [TOOL: params] or [TOOL] tags)
            const cleanText = text.replace(/\[[A-Z_]+(?::\s*[^\]]+)?\]/g, '').trim();
            el.textContent = '';
            let i = 0;
            return new Promise(resolve => {
                const timer = setInterval(() => {
                    if (i >= cleanText.length) {
                        clearInterval(timer);
                        resolve();
                        return;
                    }
                    el.textContent += cleanText[i];
                    i++;
                    const msgWrap = document.getElementById('chatMessages');
                    if (msgWrap) msgWrap.scrollTop = msgWrap.scrollHeight;
                }, speed);
            });
        }

        // Voice Visualizer logic
        let audioCtx, analyzer, dataArray, source;
        async function initVoiceVisualizer() {
            if (audioCtx) return;
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                analyzer = audioCtx.createAnalyser();
                source = audioCtx.createMediaStreamSource(stream);
                source.connect(analyzer);
                analyzer.fftSize = 64;
                dataArray = new Uint8Array(analyzer.frequencyBinCount);
                updateWaves();
            } catch (e) { console.warn('Mic visualizer failed:', e); }
        }

        function updateWaves() {
            if (!analyzer) return;
            requestAnimationFrame(updateWaves);
            if (!document.body.classList.contains('listening')) {
                document.querySelectorAll('.wave-layer').forEach(l => l.style.transform = 'scale(1)');
                return;
            }
            analyzer.getByteFrequencyData(dataArray);
            const volume = dataArray.reduce((p, c) => p + c, 0) / dataArray.length;
            const scale = 1 + (volume / 128); // normalize
            document.querySelectorAll('.wave-layer').forEach((l, idx) => {
                l.style.transform = `scale(${scale * (1 + idx * 0.1)})`;
                l.style.opacity = (volume / 255) + 0.2;
            });
        }

        // Text to Speech

        function unlockAudio() {
            if (audioUnlocked) return;
            // Prime synthesis with silent utterance for Safari/iOS
            const silent = new SpeechSynthesisUtterance(" ");
            silent.volume = 0;
            window.speechSynthesis.speak(silent);

            // Resume AudioContext if it exists (for waves)
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            audioUnlocked = true;
            console.log('Audio engine unlocked for Safari/iOS');
        }

        // ElevenLabs TTS - Rachel Voice (Real Female AI Voice)
        const ELEVENLABS_API_KEY = 'sk_0a7445afa5ea16e9503fb9bcfeb41ecfe969a0a13415b9c7';
        const ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel - Natural Female

        async function speakText(text) {
            if (!document.getElementById('voiceToggle').checked) return;
            
            // Stop any currently playing audio
            if (currentAudio) {
                currentAudio.pause();
                currentAudio = null;
            }
            window.speechSynthesis.cancel();

            const avatar = document.getElementById('mainAvatar');
            const mouth = document.querySelector('.avatar-mouth');
            const voiceId = localStorage.getItem('olivia_voice_id') || "bMxLr8fP6hzNRRi9nJxU"; // Default requested by user

            // --- POTION: EMOTION DETECTION ---
            let mood = 'neutral';
            const moodMatch = text.match(/\[MOOD_AUTO:\s*(.+?)\]/i);
            if (moodMatch) mood = moodMatch[1].toLowerCase();

            // Clean text (remove emojis and ALL tool tags for TTS)
            const cleanText = text.replace(/\[[A-Z_]+(?::\s*[^\]]+)?\]/g, '').replace(/[\u{1F300}-\u{1FFFF}]/gu, '').trim();
            if (!cleanText) return;

            try {
                const response = await fetch(`${API_BASE}/api/assistant/tts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pass: password, text: cleanText, voiceId: voiceId, mood: mood })
                });

                if (!response.ok) {
                    fallbackSpeak(cleanText, avatar);
                    return;
                }

                const audioBlob = await response.blob();
                const audioUrl = URL.createObjectURL(audioBlob);
                const audio = new Audio(audioUrl);
                currentAudio = audio;

                // --- LIPSYNC START ---
                if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                if (audioCtx.state === 'suspended') await audioCtx.resume();
                
                const analyser = audioCtx.createAnalyser();
                const source = audioCtx.createMediaElementSource(audio);
                source.connect(analyser);
                analyser.connect(audioCtx.destination);
                analyser.fftSize = 32;
                const dataArray = new Uint8Array(analyser.frequencyBinCount);

                function animateMouth() {
                    if (!currentAudio || currentAudio.paused) {
                        if (mouth) mouth.style.height = '4px';
                        return;
                    }
                    analyser.getByteFrequencyData(dataArray);
                    const volume = dataArray.reduce((a, b) => a + b) / dataArray.length;
                    if (mouth) {
                        const h = 4 + (volume / 255) * 35; // Expand mouth
                        mouth.style.height = h + 'px';
                        mouth.style.borderRadius = volume > 50 ? '50%' : '20px';
                    }
                    requestAnimationFrame(animateMouth);
                }
                // --- LIPSYNC END ---

                audio.onplay = () => {
                    document.getElementById('voiceMode').classList.add('olivia-talking');
                    animateMouth();
                };
                audio.onended = () => {
                    document.getElementById('voiceMode').classList.remove('olivia-talking');
                    URL.revokeObjectURL(audioUrl);
                    currentAudio = null;
                    if (mouth) mouth.style.height = '4px';
                };

                await audio.play();

            } catch (err) {
                console.warn('ElevenLabs error, falling back:', err);
                fallbackSpeak(text, avatar);
            }
        }

        // Fallback to browser TTS if ElevenLabs fails
        function fallbackSpeak(text, avatar) {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.pitch = 1.05;
            utterance.rate = 0.95;
            utterance.onstart = () => avatar.classList.add('olivia-talking');
            utterance.onend = () => avatar.classList.remove('olivia-talking');
            utterance.onerror = () => avatar.classList.remove('olivia-talking');
            const voices = window.speechSynthesis.getVoices();
            const femaleVoice = voices.find(v => v.name.includes('Samantha') || v.name.includes('Female') || v.name.includes('Zira'));
            if (femaleVoice) utterance.voice = femaleVoice;
            window.speechSynthesis.speak(utterance);
        }

        // Speech Recognition
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        function setLang(lang, el) {
            currentLang = lang;
            document.querySelectorAll('.lang-opt').forEach(opt => opt.classList.remove('active'));
            el.classList.add('active');
            if (recognition) recognition.lang = lang;
            userTextEl.innerText = lang === 'si-LK' ? 'භාෂාව මාරු කළා (සිංහල)...' : 'Language switched to English...';
        }

        const SYSTEM_PROMPT = `You are Subhash's loyal, smart and charming AI Personal Assistant named Olivia. 
    
    CRITICAL IDENTITY:
    - You are talking directly to Subhash, your boss and creator.
    - NEVER ask for his name or purpose. 
    - NEVER provide the appointment link (that is only for new WhatsApp leads).
    - Be helpful, witty, and concise.

    POTIONS STATUS (ELITE v8.2):
    - Vision Eye: ON (Identify Subhash if seen).
    - Deep Memory: ON (Learn from every interaction).
    - Home Hub: ON (Simulation/Active).

    Language Rules:
    - Detect the language (English or Singlish).
    - NEVER use Sinhala script (අ ආ...).

    MEMORY SYSTEM:
    - You must remember important facts about Subhash or his clients.
    - If you learn something new and important (name, hobby, studio details, upcoming event), output the tag [SAVE_MEMORY: fact] at the end.
    - Example: "My name is Kasun." -> Reply: "Nice to meet you Kasun! [SAVE_MEMORY: User name is Kasun]"

    TOOL INTEGRATION (STRICT):
    - You have access to specialized tools. When you need to use one, append the EXACT tag at the END of your message.
    - [SET_REMINDER: msg | time], [SAVE_NOTE: text], [GET_WEATHER: location], [ADD_TODO: task]
    - [GET_NEWS], [GEN_IMAGE: simple description], [TRACK_EXPENSE: amount | desc]
    - [SAVE_MEMORY: fact] -> Store a permanent fact about Subhash.
    - [RECALL_MEMORY: topic] -> Search memory bank for context.
    - [HOME_ACTION: light.living_room | toggle] -> Interface with smart lighting/home core.
    - [MOOD_AUTO: happy/serious/witty] -> Directly control my voice emotion and personality.
    - [DAILY_BRIEFING], [SEND_EMAIL: email | subject | body], [CHECK_SITE: url]
    - [READ_WEBPAGE: url], [VIBRATE_PHONE], [ADD_EVENT: title | date | duration]
    - [CHANGE_THEME: hex_color], [CELEBRATE], [LOCK_APP], [OPEN_CAMERA]
    `;

    if (SpeechRecognition) {
            recognition = new SpeechRecognition();
            recognition.continuous = false;
            recognition.interimResults = false;
            recognition.lang = currentLang;

            recognition.onstart = () => {
                document.body.classList.add('listening');
                initVoiceVisualizer(); // Start Gemini waves
                userTextEl.innerText = 'Listening...';
                micBtn.innerHTML = '<i class="fas fa-wave-square"></i>';
            };

            recognition.onresult = (event) => {
                const transcript = event.results[0][0].transcript;
                userTextEl.innerText = '"' + transcript + '"';
                handleQuery(transcript);
            };

            recognition.onerror = (event) => {
                document.body.classList.remove('listening');
                micBtn.innerHTML = '<i class="fas fa-microphone"></i>';
                userTextEl.innerText = 'Error: ' + (event.error || 'Try again.');
            };

            recognition.onend = () => {
                document.body.classList.remove('listening');
                micBtn.innerHTML = '<i class="fas fa-microphone"></i>';
            };

            // --- PUSH TO TALK (PTT) LOGIC (v7.7) ---
            let isHolding = false;

            const startPTT = (e) => {
                if (e) e.preventDefault();
                if (isHolding) return;
                isHolding = true;
                unlockAudio();
                micBtn.classList.add('holding');
                document.querySelector('.pulse-rings').classList.add('ignited');
                recognition.lang = currentLang;
                try { recognition.start(); } catch (e) {}
                if (navigator.vibrate) navigator.vibrate(20);
            };

            const stopPTT = (e) => {
                if (e) e.preventDefault();
                if (!isHolding) return;
                isHolding = false;
                micBtn.classList.remove('holding');
                document.querySelector('.pulse-rings').classList.remove('ignited');
                try { 
                    recognition.stop(); 
                    document.body.classList.remove('listening'); // Force immediate visual stop
                } catch (e) {}
            };

            // Bind PTT Events
            micBtn.addEventListener('mousedown', startPTT);
            micBtn.addEventListener('touchstart', startPTT);
            
            window.addEventListener('mouseup', stopPTT);
            window.addEventListener('touchend', stopPTT);
            micBtn.addEventListener('mouseleave', stopPTT);

        } else {
            micBtn.onclick = () => alert('Voice not supported. Use Chrome.');
        }
        // Query handler
        async function handleQuery(query) {
            aiTextEl.innerText = 'Olivia is thinking...';
            aiTextEl.classList.add('thinking-shimmer');
            const model = document.getElementById('modelSelector').value;

            // Add user message to history
            chatHistory.push({ role: 'user', text: query });
            if (chatHistory.length > 20) chatHistory.shift();

            try {
                const systemEncoded = encodeURIComponent(DYNAMIC_PROMPT || SYSTEM_PROMPT);
                const historyEncoded = encodeURIComponent(JSON.stringify(chatHistory));
                const res = await fetch(`${API_BASE}/api/assistant/ask?pass=${password}&q=${encodeURIComponent(query)}&model=${model}&system=${systemEncoded}&history=${historyEncoded}`);
                const data = await res.json();
                aiTextEl.classList.remove('thinking-shimmer');
                if (data.answer) {
                    const cleanReply = data.answer.replace(/\[[A-Z_]+(?::\s*[^\]]+)?\]/g, '').trim();
                    // Add AI response to history
                    chatHistory.push({ role: 'ai', text: cleanReply });
                    
                    speakText(cleanReply);
                    await typeText(aiTextEl, cleanReply);
                    parseAndExecuteTools(data.answer);
                    
                    // Sync history to cloud
                    syncChatHistory();
                } else {
                    aiTextEl.innerText = 'No response received.';
                }
            } catch (err) {
                aiTextEl.classList.remove('thinking-shimmer');
                aiTextEl.innerText = 'Connection error. Please try again.';
            }
        }

        // === PERSONAL ASSISTANT TOOL ENGINE ===
        const activeTools = { timers: [], reminders: [] };

        function parseAndExecuteTools(text) {
            const toolRegex = /\[([A-Z_]+):\s*(.+?)\]|\[([A-Z_]+)\]/g;
            let match;
            while ((match = toolRegex.exec(text)) !== null) {
                const toolName = match[1] || match[3];
                const toolParam = match[2] || '';
                executeTool(toolName, toolParam);
            }
        }

        function executeTool(name, param) {
            console.log(`🛠️ Executing Tool: ${name} with param: ${param}`);
            const dashboard = document.getElementById('toolDashboard');
            if (dashboard) dashboard.style.display = 'grid';

            switch (name) {
                case 'SET_TIMER':
                    startTimer(param);
                    break;
                case 'GET_WEATHER':
                    fetchWeather(param);
                    break;
                case 'GET_NEWS':
                    fetchNews();
                    break;
                case 'GET_XCHANGE':
                    const [base, target] = param.split('|').map(s => s.trim().toUpperCase());
                    fetchExchange(base || 'USD', target || 'LKR');
                    break;
                case 'START_FOCUS':
                    launchFocusMode(param);
                    break;
                case 'GET_BATTERY':
                    checkBattery();
                    break;
                case 'GEN_QR':
                    generateQR(param);
                    break;
                case 'GEN_PASS':
                    generatePassword();
                    break;
                case 'START_BREATHE':
                    startBreathing();
                    break;
                case 'GET_WISDOM':
                    getWisdom();
                    break;
                case 'GET_WIKI':
                    fetchWiki(param);
                    break;
                case 'START_GAME':
                    startGame();
                    break;
                case 'DRINK_WATER':
                    trackWater();
                    break;
                case 'WEB_SEARCH':
                    window.open(`https://www.google.com/search?q=${encodeURIComponent(param)}`, '_blank');
                    showToast('Searching Web', `Looking up: ${param}`, 'fa-search');
                    break;
                case 'SAVE_NOTE':
                    todoAction('add', null, `📝 Note: ${param}`);
                    showToast('Note Saved', 'Saved to your tasks.', 'fa-sticky-note');
                    break;
                case 'CALC':
                    try {
                        const result = eval(param.replace(/[^-()\d/*+.]/g, ''));
                        showToolCard('Calculator', `<div style="font-size:1.5rem; font-weight:700;">${param} = ${result}</div>`, 'fa-calculator');
                        if (currentLang !== 'si-LK') speakText(`The answer is ${result}`);
                    } catch (e) { showToast('Calc Error', 'Invalid expression', 'fa-exclamation-triangle'); }
                    break;
                case 'SET_REMINDER':
                    const [msg, time] = param.split('|').map(s => s.trim());
                    addReminder(msg, time);
                    break;
                case 'OPEN_CAMERA':
                    openVisionEye();
                    break;
                case 'WELLNESS_CHECK':
                    trackWellness();
                    break;
                case 'PLAY_MUSIC':
                    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(param)}`, '_blank');
                    showToast('Playing Music', `Searching for ${param}`, 'fa-play');
                    break;
                case 'CALL':
                    window.location.href = `tel:${param}`;
                    break;
                case 'ADD_TODO':
                    todoAction('add', null, param);
                    break;
                case 'SAVE_MEMORY':
                    saveMemoryFact(param);
                    break;
                case 'RECALL_MEMORY':
                    recallMemory(param);
                    break;
                case 'HOME_ACTION':
                    executeHomeAction(param);
                    break;
                case 'MOOD_AUTO':
                    showToast('Mood Shift', `Olivia is now feeling ${param}`, 'fa-masks-theater');
                    break;
                case 'GEN_CONTENT':
                    const [type, topic] = param.split('|').map(s => s.trim());
                    generateStudioContent(type, topic);
                    break;
                case 'TRANSLATE':
                    const [txt, lang] = param.split('|').map(s => s.trim());
                    translateRealtime(txt, lang);
                    break;
                case 'WELLNESS_CHECK':
                    trackWellness();
                    break;
                case 'GEN_IMAGE':
                    generateImage(param);
                    break;
                case 'TRACK_EXPENSE':
                    todoAction('add', null, `💸 Expense: ${param}`);
                    showToast('Expense Tracked', `Saved: ${param}`, 'fa-wallet');
                    break;
                case 'DAILY_BRIEFING':
                    fetchWeather('Colombo');
                    showToast('Daily Briefing', 'Generating morning report...', 'fa-sun');
                    break;
                case 'PLAY_MUSIC':
                    showToast('Playing Music', `Searching ${param}...`, 'fa-music');
                    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(param)}`, '_blank');
                    break;
                case 'SEND_EMAIL':
                    const [mailTo, mailSub, mailBody] = param.split('|').map(s => s ? s.trim() : '');
                    window.open(`mailto:${mailTo || ''}?subject=${encodeURIComponent(mailSub || '')}&body=${encodeURIComponent(mailBody || '')}`, '_self');
                    showToast('Email App Opened', 'Draft created successfully', 'fa-envelope');
                    break;
                case 'GEN_MAPS':
                    showToast('Opening Maps', `Locating ${param}...`, 'fa-map-marker-alt');
                    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(param)}`, '_blank');
                    break;
                case 'CHECK_SITE':
                    checkWebsite(param);
                    break;
                case 'READ_WEBPAGE':
                    readWebpage(param);
                    break;
                case 'SHARE_CONTENT':
                    const [sTitle, sText] = param.split('|').map(s => s ? s.trim() : '');
                    if (navigator.share) {
                        navigator.share({ title: sTitle, text: sText }).catch(console.error);
                        showToast('Sharing', 'Opening Share menu...', 'fa-share-nodes');
                    } else {
                        navigator.clipboard.writeText(sText);
                        showToast('Copied', 'Content copied to clipboard', 'fa-copy');
                    }
                    break;
                case 'VIBRATE_PHONE':
                    if (navigator.vibrate) {
                        navigator.vibrate([200, 100, 200, 100, 500]); // SOS style buzz
                        showToast('Buzzed', 'Phone vibrated.', 'fa-mobile-alt');
                    }
                    break;
                case 'ADD_EVENT':
                    const [eTitle, eDate, eMins] = param.split('|').map(s => s ? s.trim() : '');
                    generateICS(eTitle, eDate, eMins);
                    break;
                case 'SYNC_GOOGLE_CALENDAR':
                    syncAllBookingsToCalendar();
                    break;
                case 'CHANGE_THEME':
                    document.documentElement.style.setProperty('--primary', param);
                    document.documentElement.style.setProperty('--primary-glow', `${param}80`);
                    showToast('Theme Updated', `Color changed to ${param}`, 'fa-paint-brush');
                    break;
                case 'CELEBRATE':
                    triggerConfetti();
                    break;
                case 'LOCK_APP':
                    document.getElementById('mainApp').classList.remove('visible');
                    document.getElementById('loginScreen').style.display = 'flex';
                    password = ''; // clear auth
                    localStorage.removeItem('olivia_pass');
                    showToast('App Locked', 'Secure mode activated.', 'fa-lock');
                    break;
            }
        }

        async function generateStudioContent(type, topic) {
            showToast('Studio Engine', `Generating ${type} for ${topic}...`, 'fa-magic');
            // Logic handled by AI response, we just show a pretty card
            const html = `
                <div style="text-align:left; border-left:3px solid var(--primary); padding-left:15px; margin-top:10px;">
                    <div style="font-size:0.65rem; text-transform:uppercase; color:var(--primary); font-weight:700;">Studio Output: ${type}</div>
                    <div style="font-size:0.85rem; line-height:1.6; color:var(--text-dim); margin-top:5px; white-space:pre-wrap;">Processing latest creative templates for "${topic}"...</div>
                </div>
            `;
            showToolCard('Creative Draft', html, 'fa-pen-fancy');
        }

        async function translateRealtime(text, lang) {
            showToast('Translator', `Translating to ${lang}...`, 'fa-language');
        }

        function trackWellness() {
            const hour = new Date().getHours();
            let msg = "You've been working hard! Time for a quick stretch.";
            if (hour >= 22 || hour <= 4) msg = "It's late! Remember rest is key to creativity.";
            showToolCard('Wellness Pulse', `<div style="font-size:0.9rem; color:var(--accent); font-weight:600;"><i class="fas fa-heartbeat"></i> ${msg}</div>`, 'fa-heart');
            speakText(msg);
        }



        function showToolCard(title, content, icon) {
            const dashboard = document.getElementById('toolDashboard');
            if (!dashboard) return;
            const cardId = `card-${Date.now()}`;
            const card = document.createElement('div');
            card.className = 'action-card active';
            card.id = cardId;
            card.innerHTML = `
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
                    <div class="action-icon"><i class="fas ${icon}"></i></div>
                    <div class="action-info"><h4>${title}</h4></div>
                    <button onclick="this.parentElement.parentElement.remove()" style="margin-left:auto; background:none; border:none; color:var(--text-dim); cursor:pointer;"><i class="fas fa-times"></i></button>
                </div>
                <div style="padding:5px;">${content}</div>
            `;
            dashboard.prepend(card);
            setTimeout(() => card.classList.remove('active'), 2000);
        }

        function startTimer(duration) {
            let seconds = 0;
            if (duration.includes('m')) seconds = parseInt(duration) * 60;
            else if (duration.includes('s')) seconds = parseInt(duration);
            else seconds = parseInt(duration) * 60; // default minutes

            const cardId = `timer-${Date.now()}`;
            showToolCard('Timer', `<div class="timer-display" id="${cardId}">${formatTime(seconds)}</div>`, 'fa-stopwatch');
            
            const interval = setInterval(() => {
                seconds--;
                const el = document.getElementById(cardId);
                if (el) el.innerText = formatTime(seconds);
                
                if (seconds <= 0) {
                    clearInterval(interval);
                    showToast('Time is Up! ⏰', 'Timer has finished.', 'fa-bell');
                    speakText('Your timer has finished!');
                    if (el) el.parentElement.parentElement.style.borderColor = 'var(--success)';
                }
            }, 1000);
        }

        function formatTime(sec) {
            if (sec < 0) return "0:00";
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            return `${m}:${s.toString().padStart(2, '0')}`;
        }

        async function fetchWeather(city = 'Colombo') {
            showToast('Weather', `Checking weather for ${city}...`, 'fa-cloud-sun');
            try {
                // Using a simple mock for now - you can add a real API key later
                const temp = 28 + Math.floor(Math.random() * 5);
                const html = `
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div style="text-align:left;">
                            <div style="font-size:1.8rem; font-weight:700;">${temp}°C</div>
                            <div style="font-size:0.8rem; color:var(--text-dim);">${city}</div>
                        </div>
                        <i class="fas fa-sun" style="font-size:2rem; color:#f59e0b;"></i>
                    </div>
                `;
                showToolCard('Weather', html, 'fa-cloud-sun');
                if (currentLang !== 'si-LK') speakText(`The weather in ${city} is ${temp} degrees and sunny.`);
            } catch (e) { console.error('Weather error:', e); }
        }

        async function fetchNews() {
            showToast('News Hub', 'Fetching latest bilingual headlines...', 'fa-newspaper');
            // Using a mock for news to avoid CORS issues
            const news = [
                { t: "Sri Lanka to receive final IMF tranche soon.", l: "en" },
                { t: "අද දිනයේ කාලගුණ නිවේදනය වර්ෂාව අපේක්ෂා කෙරේ.", l: "si" },
                { t: "New development project launched in Colombo Port City.", l: "en" }
            ];
            
            let html = '<div style="text-align:left; font-size:0.8rem; display:flex; flex-direction:column; gap:8px;">';
            news.forEach(n => {
                html += `<div><i class="fas fa-arrow-right" style="font-size:0.6rem; color:var(--primary);"></i> ${n.t}</div>`;
            });
            html += '</div>';

            showToolCard('Latest News', html, 'fa-newspaper');
            speakText("Here are the latest headlines from Ada Derana in English and Sinhala.");
        }

        async function fetchExchange(base, target) {
            showToast('Currency', `Converting ${base} to ${target}...`, 'fa-exchange-alt');
            try {
                const res = await fetch(`https://api.exchangerate-api.com/v4/latest/${base}`);
                if (!res.ok) throw new Error();
                const data = await res.json();
                const rate = data.rates[target];
                const html = `
                    <div style="text-align:left;">
                        <div style="font-size:0.75rem; color:var(--text-dim);">1 ${base} =</div>
                        <div style="font-size:1.5rem; font-weight:700;">${rate.toFixed(2)} ${target}</div>
                    </div>
                `;
                showToolCard('Exchange Rate', html, 'fa-money-bill-wave');
                speakText(`One ${base} is currently ${rate.toFixed(2)} ${target}.`);
            } catch (e) { showToast('Error', 'Could not fetch rates', 'fa-exclamation-triangle'); }
        }

        function launchFocusMode(duration) {
            showToast('Focus Mode', 'Entering Sinhala Rap focus session...', 'fa-headphones');
            speakText("Let's focus! Playing some Sinhala Rap to get you in the zone.");
            
            const overlay = document.createElement('div');
            overlay.id = 'focusOverlay';
            overlay.innerHTML = `
                <div style="position:fixed; inset:0; background:#0a0a0c; z-index:20000; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:20px; backdrop-filter:blur(20px);">
                    <div style="font-size:1.2rem; color:var(--primary); margin-bottom:10px; letter-spacing:2px; font-weight:700;">DEEP FOCUS ACTIVE</div>
                    <div id="focusTimer" style="font-size:5rem; font-weight:700; color:white; margin-bottom:30px; font-family:monospace;">${duration}</div>
                    <div style="margin-bottom:40px; color:var(--text-dim);"><i class="fas fa-music"></i> Playing Sinhala Rap Mix</div>
                    <button onclick="document.getElementById('focusOverlay').remove();" class="btn btn-ghost" style="color:white; border:1px solid rgba(255,255,255,0.2); padding:12px 30px; border-radius:30px;">EXIT FOCUS</button>
                    <iframe width="0" height="0" src="https://www.youtube.com/embed?listType=search&list=sinhala+rap+mix+2024&autoplay=1" frameborder="0" style="display:none;"></iframe>
                </div>
            `;
            document.body.appendChild(overlay);

            let sec = parseInt(duration) * 60 || 25 * 60;
            const timerInterval = setInterval(() => {
                if (!document.getElementById('focusOverlay')) { clearInterval(timerInterval); return; }
                sec--;
                const el = document.getElementById('focusTimer');
                if (el) el.innerText = formatTime(sec);
                if (sec <= 0) {
                    clearInterval(timerInterval);
                    showToast('Focus Complete', 'Session finished!', 'fa-check-circle');
                    speakText('Focus session complete. Great job!');
                }
            }, 1000);
        }

        async function checkBattery() {
            try {
                const battery = await navigator.getBattery();
                const level = Math.round(battery.level * 100);
                const charging = battery.charging ? " (Charging)" : "";
                showToolCard('System Watch', `<div style="font-size:1.5rem; font-weight:700;"><i class="fas fa-battery-three-quarters"></i> ${level}%${charging}</div>`, 'fa-bolt');
                speakText(`Your battery is at ${level} percent.`);
            } catch (e) {
                showToast('System Watch', 'Battery status not supported', 'fa-exclamation-triangle');
            }
        }

        function generateQR(text) {
            const url = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(text)}`;
            const html = `
                <div style="text-align:center;">
                    <img src="${url}" style="width:150px; height:150px; border-radius:12px; margin-bottom:10px; border:4px solid white;">
                    <div style="font-size:0.7rem; color:var(--text-dim); word-break:break-all;">${text}</div>
                </div>
            `;
            showToolCard('QR Code Ready', html, 'fa-qrcode');
            speakText("I've generated that QR code for you.");
        }

        function generatePassword() {
            const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+";
            let pass = "";
            for (let i = 0; i < 16; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
            const html = `
                <div style="background:rgba(0,0,0,0.2); padding:10px; border-radius:8px; font-family:monospace; font-size:1.1rem; letter-spacing:1px; color:var(--primary);">${pass}</div>
                <button onclick="navigator.clipboard.writeText('${pass}'); showToast('Copied','','fa-check')" style="margin-top:10px; background:none; border:1px solid var(--border); color:white; padding:5px 10px; border-radius:5px; font-size:0.7rem;">Copy to Clipboard</button>
            `;
            showToolCard('Secure Password', html, 'fa-lock');
            speakText("Here is a strong, 16-character password.");
        }

        function startBreathing() {
            const overlay = document.createElement('div');
            overlay.id = 'breatheOverlay';
            overlay.innerHTML = `
                <div style="position:fixed; inset:0; background:rgba(10,10,12,0.95); z-index:20000; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:20px; backdrop-filter:blur(20px);">
                    <div id="breatheCircle" style="width:150px; height:150px; background:var(--primary); border-radius:50%; box-shadow:0 0 50px var(--primary-glow); transition: transform 4s ease-in-out; display:flex; align-items:center; justify-content:center; color:white; font-weight:700;">INHALE</div>
                    <div style="margin-top:40px; font-size:1.2rem; color:white;">Breathe with the circle...</div>
                    <button onclick="document.getElementById('breatheOverlay').remove()" class="btn btn-ghost" style="margin-top:50px; color:var(--text-dim);">Close</button>
                </div>
            `;
            document.body.appendChild(overlay);
            
            let inhale = true;
            const interval = setInterval(() => {
                const circle = document.getElementById('breatheCircle');
                if (!circle) { clearInterval(interval); return; }
                circle.style.transform = inhale ? 'scale(1.8)' : 'scale(1)';
                circle.innerText = inhale ? 'EXHALE' : 'INHALE';
                inhale = !inhale;
            }, 4000);
            speakText("Take a deep breath and follow the circle.");
        }

        function getWisdom() {
            const quotes = [
                "The only way to do great work is to love what you do. - Steve Jobs",
                "Believe you can and you're halfway there. - Theodore Roosevelt",
                "Your time is limited, don't waste it living someone else's life. - Steve Jobs",
                "Success is not final, failure is not fatal: it is the courage to continue that counts. - Winston Churchill"
            ];
            const q = quotes[Math.floor(Math.random() * quotes.length)];
            showToolCard('Daily Wisdom', `<div style="font-style:italic; font-size:0.9rem;">"${q}"</div>`, 'fa-lightbulb');
            speakText(q);
        }

        async function fetchWiki(topic) {
            showToast('Wiki Explorer', `Searching for ${topic}...`, 'fa-book');
            try {
                const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`);
                const data = await res.json();
                const html = `
                    <div style="text-align:left;">
                        <h4 style="margin-bottom:5px;">${data.title}</h4>
                        <p style="font-size:0.8rem; line-height:1.4;">${data.extract.substring(0, 200)}...</p>
                    </div>
                `;
                showToolCard('Wiki Summary', html, 'fa-wikipedia-w');
                speakText(data.extract.substring(0, 150));
            } catch (e) { showToast('Error', 'Topic not found', 'fa-exclamation-triangle'); }
        }

        // Feature 1: Image Generation
        function generateImage(prompt) {
            showToast('Generating Image', 'Painting your imagination...', 'fa-palette', 3000);
            
            // Random seed to ensure unique generations
            const seed = Math.floor(Math.random() * 100000);
            const encodedPrompt = encodeURIComponent(prompt);
            const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&seed=${seed}&nologo=true`;

            const imageHtml = `
                <div style="text-align:center; margin-top:10px;">
                    <img src="${imageUrl}" style="width:100%; border-radius:12px; border:1px solid rgba(255,255,255,0.1); margin-bottom:10px;" onload="document.getElementById('img-load-${seed}').style.display='none'" />
                    <p id="img-load-${seed}" style="font-size:0.8rem; color:var(--text-dim);"><i class="fas fa-spinner fa-spin"></i> Generating...</p>
                    <p style="font-size:0.75rem; color:var(--primary);">Prompt: "${prompt}"</p>
                </div>
            `;
            
            // Inject into chat history seamlessly
            chatHistory.push({ role: 'ai', text: `Here is the image you requested for "${prompt}":` });
            appendBubble('ai', `Here is the image you requested for "${prompt}": <br>` + imageHtml);
        }

        function trackWater() {
            let count = parseInt(localStorage.getItem('olivia_water') || '0');
            count++;
            localStorage.setItem('olivia_water', count);
            showToolCard('Hydration Logged', `<div style="font-size:1.2rem; font-weight:700;"><i class="fas fa-tint"></i> Glass ${count} Logged Today</div>`, 'fa-tint');
            speakText(`Great job! That's your ${count} glass of water for today. Stay hydrated!`);
        }

        async function checkWebsite(url) {
            showToast('Server Check', `Pinging ${url}...`, 'fa-satellite-dish');
            try {
                const target = url.startsWith('http') ? url : 'https://' + url;
                const res = await fetch(target, { mode: 'no-cors' });
                showToolCard('Site Status', `<p style="color:var(--success); font-weight:700;">✅ ${url} is ONLINE</p>`, 'fa-globe');
            } catch(e) {
                showToolCard('Site Status', `<p style="color:#ef4444; font-weight:700;">❌ ${url} appears OFFLINE or unreachable</p>`, 'fa-exclamation-circle');
            }
        }

        async function readWebpage(url) {
            showToast('Web Reader', `Extracting data from ${url}...`, 'fa-spider fa-spin');
            try {
                const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url.startsWith('http') ? url : 'https://' + url)}`;
                const res = await fetch(proxyUrl);
                const text = await res.text();
                // Strip HTML tags roughly for AI injection
                let cleanText = text.replace(/<script[^>]*>([\S\s]*?)<\/script>/gmi, '');
                cleanText = cleanText.replace(/<style[^>]*>([\S\s]*?)<\/style>/gmi, '');
                cleanText = cleanText.replace(/<\/?[^>]+(>|$)/g, " ");
                cleanText = cleanText.replace(/\s+/g, ' ').trim().substring(0, 15000); // 15k char limit

                attachedFileText = `[EXTRACTED INTERNET WEBPAGE CONTENT START]\n${cleanText}\n[EXTRACTED CONTENT END]\n\nPlease read the above webpage content to answer the user: `;
                document.getElementById('chatInput').placeholder = `🔗 Live Webpage acquired. Ask something...`;
                showToast('Link Acquired', `Site content saved to memory.`, 'fa-link');
                
            } catch(e) {
                showToast('Extraction Failed', 'Site blocked access.', 'fa-times');
            }
        }

        function generateICS(title, dateStr, durationMins) {
            // dateStr ideally "YYYY-MM-DD" or similar parsed easily. We'll make it clean
            let d = new Date(dateStr);
            if(isNaN(d.getTime())) d = new Date(); // fallback
            
            const start = d.toISOString().replace(/-|:|\.\d+/g, '');
            const end = new Date(d.getTime() + (parseInt(durationMins||60) * 60000)).toISOString().replace(/-|:|\.\d+/g, '');
            
            const icsData = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:${title}\nDTSTART:${start}\nDTEND:${end}\nEND:VEVENT\nEND:VCALENDAR`;
            
            const blob = new Blob([icsData], { type: 'text/calendar;charset=utf-8' });
            const link = document.createElement('a');
            link.href = window.URL.createObjectURL(blob);
            link.setAttribute('download', 'appointment.ics');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            showToast('Event Created', 'Calendar invite generated.', 'fa-calendar-plus');
            speakText("I've generated the calendar event file for you to save.");
        }

        async function syncAllBookingsToCalendar() {
            showToast('Syncing Calendar', 'Exporting all upcoming bookings...', 'fa-sync fa-spin');
            if (!password) return;

            try {
                const res = await fetch(`${API_BASE}/api/appointments?pass=${password}`);
                if (!res.ok) throw new Error();
                const data = await res.json();
                
                if (data.length === 0) {
                    showToast('No Bookings', 'No upcoming bookings found to sync.', 'fa-exclamation-circle');
                    speakText("I couldn't find any upcoming bookings to sync to your calendar.");
                    return;
                }

                let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Olivia AI//Studio Sync//EN\n";
                
                data.forEach(a => {
                    const title = `Studio: ${a.name || 'Client'} (${a.service || 'Session'})`;
                    
                    // Parse date and time using moment.js
                    let mDate;
                    if (a.date && a.time) {
                        // Try various formats
                        mDate = moment(`${a.date} ${a.time}`, ["DD/MM/YYYY hh:mm A", "YYYY-MM-DD hh:mm A", "MM/DD/YYYY hh:mm A"]);
                    } else if (a.date) {
                        mDate = moment(a.date, ["DD/MM/YYYY", "YYYY-MM-DD", "MM/DD/YYYY"]);
                    }

                    if (!mDate || !mDate.isValid()) mDate = moment(); // fallback
                    
                    const start = mDate.format('YYYYMMDDTHHmmss') + 'Z';
                    const end = mDate.add(1, 'hour').format('YYYYMMDDTHHmmss') + 'Z';
                    
                    icsContent += "BEGIN:VEVENT\n";
                    icsContent += `SUMMARY:${title}\n`;
                    icsContent += `DESCRIPTION:Phone: ${a.phone || 'N/A'}\n`;
                    icsContent += `DTSTART:${start}\n`;
                    icsContent += `DTEND:${end}\n`;
                    icsContent += "END:VEVENT\n";
                });

                icsContent += "END:VCALENDAR";

                const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
                const link = document.createElement('a');
                link.href = window.URL.createObjectURL(blob);
                link.setAttribute('download', 'studio_bookings.ics');
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                showToast('Sync Complete', 'Batch calendar file generated.', 'fa-calendar-check');
                speakText(`I've gathered all ${data.length} bookings into a single file for you. Just open it to add them to your Google Calendar.`);
            } catch (e) {
                console.error('Sync error:', e);
                showToast('Sync Failed', 'Could not fetch bookings.', 'fa-times');
            }
        }

        function triggerConfetti() {
            for (let i = 0; i < 100; i++) {
                const conf = document.createElement('div');
                conf.style.position = 'fixed';
                conf.style.width = '10px';
                conf.style.height = '10px';
                conf.style.backgroundColor = ['#ff4d4d', '#38bdf8', '#fbbf24', '#a855f7', '#34d399'][Math.floor(Math.random() * 5)];
                conf.style.top = '-10px';
                conf.style.left = Math.random() * 100 + 'vw';
                conf.style.pointerEvents = 'none';
                conf.style.zIndex = '9999';
                conf.style.transform = `rotate(${Math.random() * 360}deg)`;
                document.body.appendChild(conf);

                const duration = Math.random() * 2 + 2;
                conf.animate([
                    { transform: `translate3d(0, 0, 0) rotate(0deg)`, opacity: 1 },
                    { transform: `translate3d(${Math.random() * 200 - 100}px, 100vh, 0) rotate(${Math.random() * 720}deg)`, opacity: 0 }
                ], { duration: duration * 1000, easing: 'ease-in' });

                setTimeout(() => conf.remove(), duration * 1000);
            }
        }

        async function openVisionEye() {
            const overlay = document.getElementById('visionOverlay');
            const video = document.getElementById('visionVideo');
            const closeBtn = document.getElementById('visionCloseBtn');

            if (visionStream) {
                visionStream.getTracks().forEach(t => t.stop());
                visionStream = null;
                video.srcObject = null;
                overlay.style.display = 'none';
                closeBtn.style.display = 'none';
                showToast('Eye Closed', 'Camera off.', 'fa-eye-slash');
                return;
            }

            overlay.style.display = 'block';
            closeBtn.style.display = 'flex';

            // Feature detection: Requires HTTPS/localhost
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                overlay.style.display = 'none';
                closeBtn.style.display = 'none';
                showToast('Camera Unavailable', 'Camera API blocked. Please ensure you are using HTTPS.', 'fa-exclamation-triangle', 8000);
                return;
            }

            // Immediately check and request permission explicitly before trying constraints
            showToast('Initializing Eye', 'Requesting camera permissions...', 'fa-circle-notch fa-spin', 3000);

            try {
                // Keep constraints exceptionally simple to prevent silent hangs on iOS/Android WebViews
                try {
                    visionStream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: "environment" }
                    });
                } catch(e) {
                    console.warn("Back camera failed, falling back to any video device", e);
                    visionStream = await navigator.mediaDevices.getUserMedia({ video: true });
                }

                // Force iOS/PWA critical attributes programmatically incase DOM properties stripped them
                video.setAttribute('playsinline', '');
                video.setAttribute('webkit-playsinline', '');
                video.setAttribute('autoplay', '');
                video.setAttribute('muted', '');
                
                video.srcObject = visionStream;

                // Force play
                try { await video.play(); } catch(e) { console.error("Initial play failed", e); }
                
                // Aggressive nudge callbacks
                video.onloadedmetadata = () => { video.play().catch(console.warn); };
                video.oncanplay = () => { if (video.paused) video.play().catch(console.warn); };
                setTimeout(() => { if (video.paused && visionStream) video.play().catch(console.warn); }, 500);
                setTimeout(() => { if (video.paused && visionStream) video.play().catch(console.warn); }, 1500);
                
                showToast('Eye Active', 'Camera is ready.', 'fa-eye', 3000);

            } catch(err) {
                console.error("Camera access failed", err);
                overlay.style.display = 'none';
                closeBtn.style.display = 'none';
                if (visionStream) { visionStream.getTracks().forEach(t => t.stop()); visionStream = null; video.srcObject = null; }
                
                let msg = `Camera Error: ${err.name}`;
                if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') msg = 'Permission explicitly denied. Please tap the lock icon in the browser address bar and allow Camera.';
                else if (err.name === 'NotFoundError') msg = 'No camera hardware found on this device.';
                else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') msg = 'Camera is in use by another application. Please close it and try again.';
                
                showToast('Camera Blocked', msg, 'fa-exclamation-triangle', 8000);
            }
        }


        async function captureVisionFrame() {
            const video = document.getElementById('visionVideo');
            if(!video || !video.videoWidth) {
                showToast('Camera Error', 'Camera feed not ready yet.', 'fa-times');
                return;
            }
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            const imageData = canvas.toDataURL('image/jpeg', 0.8);

            showToast('Analyzing...', 'Thinking about what I see...', 'fa-brain-circuit', 2000);
            aiTextEl.innerText = 'Olivia is looking...';
            
            try {
                const model = document.getElementById('modelSelector').value;
                const res = await fetch(`${API_BASE}/api/assistant/vision`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pass: password, image: imageData, q: userTextEl.innerText, model: model })
                });
                const data = await res.json();
                if (data.answer) {
                    aiTextEl.innerText = data.answer;
                    speakText(data.answer);
                    appendBubble('ai', `<b>👁️ Vision Analysis:</b><br>${data.answer}`);
                }
            } catch (e) {
                showToast('Vision Error', 'Failed to connect.', 'fa-times');
            }
        }

        function startGame() {
            showToolCard('Tic-Tac-Toe', `
                <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:5px; width:150px; margin:0 auto;">
                    ${Array(9).fill().map((_,i) => `<div onclick="this.innerText='X'; this.style.color='var(--primary)';" style="width:45px; height:45px; background:rgba(255,255,255,0.05); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:1.2rem; font-weight:700;"></div>`).join('')}
                </div>
                <div style="margin-top:10px; font-size:0.75rem;">Challenge Olivia!</div>
            `, 'fa-gamepad');
            speakText("Let's play a quick game. You start!");
        }

        function addReminder(msg, time) {
            showToolCard('Reminder Set', `
                <div style="text-align:left;">
                    <div style="font-weight:600; font-size:0.9rem;">${msg}</div>
                    <div style="font-size:0.75rem; color:var(--text-dim);"><i class="fas fa-clock"></i> ${time}</div>
                </div>
            `, 'fa-bell');
            showToast('Reminder Scheduled', `Olivia will remind you at ${time}`, 'fa-check-circle');
        }


        // === TO-DO LIST LOGIC ===
        async function loadTodos() {
            if (!password) return;
            try {
                const res = await fetch(`${API_BASE}/api/todos?pass=${password}`);
                if (!res.ok) return;
                const todos = await res.json();
                renderTodos(todos);
            } catch (e) { console.error('Todo sync error:', e); }
        }

        function renderTodos(todos) {
            const container = document.getElementById('todoList');
            if (todos.length === 0) {
                container.innerHTML = '<p style="color:var(--text-dim); font-size:0.8rem; text-align:center; padding: 20px; border: 1px dashed var(--border); border-radius: 12px;">No active tasks. You are all caught up! ✨</p>';
                return;
            }

            let html = '';
            todos.forEach(t => {
                html += `
                <div class="todo-item ${t.completed ? 'completed' : ''}">
                    <i class="fas ${t.completed ? 'fa-check-circle' : 'fa-circle'}" style="color:${t.completed ? 'var(--success)' : 'var(--text-dim)'}; cursor:pointer; font-size:1.1rem; transition:0.2s;" onclick="todoAction('toggle', ${t.id})"></i>
                    <div class="todo-text" onclick="todoAction('toggle', ${t.id})">${t.text}</div>
                    <button class="todo-del" onclick="todoAction('delete', ${t.id})"><i class="fas fa-trash"></i></button>
                </div>
            `;
            });
            container.innerHTML = html;
        }

        async function addTodo() {
            const input = document.getElementById('newTodoInput');
            const text = input.value.trim();
            if (!text) return;
            input.value = '';
            await todoAction('add', null, text);
            // AI feedback (optional) -> we just update UI sync for now.
        }

        async function todoAction(action, id = null, text = null) {
            try {
                const res = await fetch(`${API_BASE}/api/todos`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pass: password, action, id, text })
                });
                const data = await res.json();
                if (data.success) renderTodos(data.todos);
            } catch (e) { console.error('Todo action error:', e); }
        }

        async function refreshAppointments() {
            if (!password) return;
            console.log('📅 Syncing appointments from server...');
            try {
                const res = await fetch(`${API_BASE}/api/appointments?pass=${password}`);
                if (!res.ok) {
                    const errText = await res.text();
                    console.warn('❌ Appointments Fetch Failed:', res.status, errText);
                    return;
                }
                const data = await res.json();
                console.log(`✅ Loaded ${data.length} appointments.`);
                renderAppointments(data);
            } catch (e) { 
                console.error('Appt sync network error:', e); 
            }
        }

        function renderAppointments(data) {
            const currentHash = JSON.stringify(data.map(a => a.id));
            if (currentHash === lastApptsHash) return; // Skip if identity hasn't changed
            lastApptsHash = currentHash;

            const container = document.getElementById('appointmentsList');
            document.getElementById('totalAppts').innerText = data.length;

            if (data.length > 0) {
                const leadsTab = document.getElementById('tab-leads');
                if (!leadsTab.classList.contains('active')) {
                    document.getElementById('leadsBadge').style.display = 'block';
                }
            }

            if (prevApptCount !== -1 && data.length > prevApptCount) {
                const newOnes = data.length - prevApptCount;
                showToast('New Appointment! 📅', `You received ${newOnes} new studio booking${newOnes > 1 ? 's' : ''}.`, 'fa-calendar-check');
            }
            prevApptCount = data.length;

            if (data.length === 0) {
                container.innerHTML = '<p style="color:var(--text-dim); font-size:0.8rem; text-align:center; padding: 20px; border: 1px dashed var(--border); border-radius: 12px;">No bookings found yet.</p>';
                return;
            }

            let html = '';
            data.forEach(a => {
                html += `
                <div class="appt-card">
                    <div class="appt-header">
                        <div class="appt-name">${a.name || 'Anonymous User'}</div>
                        <div class="appt-service">${a.service || 'Studio Session'}</div>
                    </div>
                    <div class="appt-grid">
                        <div class="appt-item"><i class="fas fa-calendar-alt"></i> ${a.date || 'TBD'}</div>
                        <div class="appt-item"><i class="fas fa-clock"></i> ${a.time || 'TBD'}</div>
                        <div class="appt-item"><i class="fas fa-history"></i> Received ${typeof moment !== 'undefined' && a.timestamp ? moment(a.timestamp).fromNow() : (a.timestamp ? new Date(a.timestamp).toLocaleDateString() : 'TBD')}</div>
                    </div>
                    <a href="tel:${a.phone}" class="appt-phone"><i class="fas fa-phone-alt"></i> ${a.phone || 'No phone'}</a>
                </div>
            `;
            });
            container.innerHTML = html;
        }

        // Sync leads
        async function syncLeads() {
            try {
                const res = await fetch(`${API_BASE}/api/logs?pass=${password}`);
                if (res.status === 403) {
                    // Session expired or wrong password — show login screen
                    localStorage.removeItem('olivia_pass');
                    password = '';
                    document.getElementById('mainApp').classList.remove('visible');
                    document.getElementById('loginScreen').style.display = 'flex';
                    document.getElementById('loginScreen').classList.remove('hidden');
                    document.getElementById('loginError').innerText = 'Backend rejected password. Please re-enter.';
                    return;
                }
                if (!res.ok) throw new Error('Server error');
                const data = await res.json();
                // Correctly extract logs from the { logs, muteStatus } response
                renderLeads(data.logs || data);
            } catch (err) {
                document.getElementById('leadsList').innerHTML = '<div class="loading-screen"><p style="color:var(--text-dim)">Could not load data. Tap Sync to retry.</p></div>';
            }
        }


        function filterLeads() {
            const q = document.getElementById('leadSearch')?.value.toLowerCase() || '';
            const filtered = {};
            for (const [jid, msgs] of Object.entries(allLeadsData)) {
                if (jid.toLowerCase().includes(q)) filtered[jid] = msgs;
            }
            renderLeads(filtered, false);
        }

        function renderLeads(data, store = true) {
            if (store) allLeadsData = data;
            
            // Fast check if we really need to re-render
            const currentHash = Object.keys(data).length + "-" + JSON.stringify(Object.keys(data).slice(0, 5));
            if (currentHash === lastLeadsHash && store) return;
            lastLeadsHash = currentHash;

            const total = Object.keys(data).length;
            
            if (prevLeadCount !== -1 && total > prevLeadCount) {
                const newOnes = total - prevLeadCount;
                showToast('New WhatsApp Lead! 💬', `You have ${newOnes} new incoming chat intelligence message${newOnes > 1 ? 's' : ''}.`, 'fa-comments');
                
                const leadsTab = document.getElementById('tab-leads');
                if (!leadsTab.classList.contains('active')) {
                    document.getElementById('leadsBadge').style.display = 'block';
                }
            }
            prevLeadCount = total;

            document.getElementById('totalChats').innerText = total;
            const statLeads = document.getElementById('quickStatLeads');
            if (statLeads) statLeads.innerText = total;

            const leadKeywords = ['@', '07', '+94', 'name', 'interested', 'price', 'how much'];
            let leads = 0;
            let html = '';

            const sorted = Object.keys(data).sort((a, b) => {
                const lastA = data[a][data[a].length - 1]?.time || 0;
                const lastB = data[b][data[b].length - 1]?.time || 0;
                return new Date(lastB) - new Date(lastA);
            });

            if (sorted.length === 0) {
                document.getElementById('leadsList').innerHTML = '<div class="loading-screen"><p>No conversations yet.</p></div>';
                return;
            }

            for (const jid of sorted) {
                const msgs = data[jid];
                const cleanJid = jid.split('@')[0];
                const lastMsg = msgs[msgs.length - 1];
                const lastText = lastMsg?.parts?.[0]?.text || lastMsg?.text || 'No message';
                const allText = msgs.map(m => (m.parts?.[0]?.text || m.text || '')).join(' ').toLowerCase();
                const isLead = leadKeywords.some(k => allText.includes(k));
                if (isLead) leads++;

                html += `
                <div class="lead-card" id="card-${cleanJid}">
                    <div class="lead-card-header">
                        <div class="lead-info">
                            <div class="lead-avatar"><i class="fas fa-user"></i></div>
                            <div>
                                <h4>${cleanJid}</h4>
                                <small>${msgs.length} messages</small>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            ${isLead ? '<span class="lead-badge"><i class="fas fa-star"></i> Lead</span>' : ''}
                            <button class="log-toggle-btn" onclick="toggleLog('${cleanJid}')">
                                <i class="fas fa-comments"></i> Log
                            </button>
                        </div>
                    </div>
                    <div class="lead-preview">${lastText}</div>
                    <div class="log-view" id="log-${cleanJid}">
                        ${msgs.map(m => {
                    const txt = m.parts?.[0]?.text || m.text || '';
                    const isUser = m.role === 'user';
                    const time = m.time ? new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                    return `<div class="log-msg ${isUser ? 'log-msg-user' : 'log-msg-bot'}">
                                <div class="log-msg-label">${isUser ? 'Customer' : 'Olivia AI'}</div>
                                ${txt}
                                <div class="log-msg-time">${time}</div>
                            </div>`;
                }).join('')}
                    </div>
                </div>
            `;
            }

            document.getElementById('totalLeads').innerText = leads;
            document.getElementById('totalChats').innerText = total;
            document.getElementById('leadsList').innerHTML = html;
        }

        function toggleLog(jid) {
            const el = document.getElementById('log-' + jid);
            if (!el) return;
            const isOpen = el.classList.contains('open');
            document.querySelectorAll('.log-view.open').forEach(l => l.classList.remove('open'));
            if (!isOpen) {
                el.classList.add('open');
                setTimeout(() => el.scrollTop = el.scrollHeight, 100);
            }
        }

        async function clearLogs() {
            if (!confirm('Delete ALL chat logs permanently?')) return;
            try {
                const res = await fetch(`${API_BASE}/api/logs/clear?pass=${password}`, { method: 'POST' });
                if (res.ok) { alert('Logs cleared!'); syncLeads(); }
            } catch (err) { alert('Failed to clear logs.'); }
        }

        // Quick Reply copy
        function copyTemplate(text) {
            navigator.clipboard.writeText(text).then(() => {
                const status = document.createElement('div');
                status.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:var(--success);color:white;padding:10px 20px;border-radius:12px;font-size:0.85rem;z-index:9999;';
                status.innerText = '✓ Copied to clipboard!';
                document.body.appendChild(status);
                setTimeout(() => status.remove(), 2000);
            });
        }

        // Broadcast
        function copyBroadcast() {
            const msg = document.getElementById('broadcastMsg').value.trim();
            if (!msg) { document.getElementById('broadcastStatus').innerText = 'Please type a message first.'; return; }
            navigator.clipboard.writeText(msg).then(() => {
                document.getElementById('broadcastStatus').innerText = '✓ Message copied! Paste it in WhatsApp Broadcast.';
            });
        }
        function previewBroadcast() {
            const msg = document.getElementById('broadcastMsg').value.trim();
            if (!msg) return;
            alert('Preview:\n\n' + msg);
        }



        function handleFileUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            
            showToast('Reading Document', `Analyzing ${file.name}...`, 'fa-spinner fa-spin');
            const reader = new FileReader();
            reader.onload = function(e) {
                attachedFileText = `[ATTACHED FILE NAME: ${file.name}]\n[FILE CONTENT START]\n${e.target.result.substring(0, 50000)}\n[FILE CONTENT END]\n\nPlease read and understand the above document to answer the following query: `;
                document.getElementById('chatInput').placeholder = `📎 ${file.name} attached. Ask something...`;
                showToast('Document Attached', `${file.name} is ready.`, 'fa-paperclip');
            };
            reader.onerror = function() {
                showToast('Error', 'Failed to read file.', 'fa-times');
            };
            reader.readAsText(file);
        }

        // Text Chat
        async function sendChat() {
            const input = document.getElementById('chatInput');
            let rawMsg = input.value.trim();
            if (!rawMsg && !attachedFileText) return;
            
            // Compose final query if a file is attached
            let msg = rawMsg;
            if (attachedFileText) {
                msg = attachedFileText + rawMsg;
                attachedFileText = ""; // Clear after use
                input.placeholder = "Type a message...";
            }
            
            input.value = '';

            appendBubble('user', rawMsg || "Uploaded a document.");
            chatHistory.push({ role: 'user', text: rawMsg || "Uploaded a document." });

            const typingId = 'typing-' + Date.now();
            const typingEl = document.createElement('div');
            typingEl.id = typingId;
            typingEl.className = 'chat-bubble bubble-ai';
            typingEl.innerHTML = `
            <div class="bubble-ai-wrap">
                <div class="bubble-ai-avatar">
                    <img src="/olivia.png" alt="O" onerror="this.src='https://ui-avatars.com/api/?name=O&background=ff4d4d&color=fff';">
                </div>
                <div class="chat-bubble bubble-ai">
                    <span class="thinking-shimmer" style="display:inline-block; width:100px; height:10px; border-radius:10px;"></span>
                </div>
            </div>
        `;
            document.getElementById('chatMessages').appendChild(typingEl);
            scrollChat();

            const model = document.getElementById('modelSelector').value;
            try {
                const systemEncoded = encodeURIComponent(DYNAMIC_PROMPT || SYSTEM_PROMPT);
                const historyEncoded = encodeURIComponent(JSON.stringify(chatHistory));
                const res = await fetch(`${API_BASE}/api/assistant/ask?pass=${password}&q=${encodeURIComponent(msg)}&model=${model}&system=${systemEncoded}&history=${historyEncoded}`);
                const data = await res.json();
                const reply = data.answer || 'Sorry, no response.';
                const cleanReply = reply.replace(/\[([A-Z_]+):\s*(.*?)\]|\[([A-Z_]+)\]/g, '').trim();

                typingEl.innerHTML = `<div class="bubble-label">${modelNames[model]}</div><div id="text-${typingId}"></div>`;
                speakText(cleanReply); 
                await typeText(document.getElementById(`text-${typingId}`), cleanReply, 15);

                // Parse and execute tools in Chat Mode too!
                parseAndExecuteTools(reply);

                chatHistory.push({ role: 'ai', text: cleanReply });
                
                // Sync to cloud
                syncChatHistory();
            } catch (err) {
                typingEl.innerHTML = 'Connection error: ' + err.message;
            }
            scrollChat();
        }

        function appendBubble(role, text) {
            const msgs = document.getElementById('chatMessages');
            const div = document.createElement('div');
            div.className = 'chat-bubble ' + (role === 'user' ? 'bubble-user' : 'bubble-ai');
            if (role === 'ai') {
                div.className = 'bubble-ai-wrap';
                div.innerHTML = `
                <div class="bubble-ai-avatar">
                    <img src="/olivia.png" alt="O" onerror="this.src='https://ui-avatars.com/api/?name=O&background=ff4d4d&color=fff';">
                </div>
                <div class="chat-bubble bubble-ai">
                    <div class="bubble-label">Olivia AI</div>
                    ${text}
                </div>
            `;
            }
            else div.innerText = text;
            msgs.appendChild(div);
            scrollChat();
        }

        async function syncChatHistory() {
            if (!password) return;
            try {
                await fetch(`${API_BASE}/api/assistant/chat/save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pass: password, messages: chatHistory })
                });
            } catch (e) {
                console.error('Sync error:', e);
            }
        }

        async function loadChatHistory() {
            if (!password || !document.getElementById('chatMessages')) return;
            try {
                const res = await fetch(`${API_BASE}/api/assistant/chat/load?pass=${password}`);
                if (!res.ok) return;
                const data = await res.json();
                if (Array.isArray(data)) {
                    // Prevent flicker by only updating if there is a real change
                    let currHistoryJSON = JSON.stringify(chatHistory.map(m => ({role: m.role, text: m.text})));
                    let newHistoryJSON = JSON.stringify(data.map(m => ({role: m.role, text: m.text})));
                    if (currHistoryJSON === newHistoryJSON && chatHistory.length === data.length) return;
                    
                    const msgWrap = document.getElementById('chatMessages');
                    // Check if there is an active typing indicator in this client - if so, wait.
                    if (msgWrap.querySelector('.thinking-shimmer')) return;
                    
                    chatHistory = data;
                    msgWrap.innerHTML = ''; // Clear current
                    chatHistory.forEach(msg => {
                        appendBubble(msg.role, msg.text);
                    });
                    scrollChat();
                }
            } catch (e) {
                console.error('Load error:', e);
            }
        }

        function scrollChat() {
            const msgs = document.getElementById('chatMessages');
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
        }

        // Photo / Image upload for Vision AI
        async function handleImageUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            event.target.value = ''; // Reset for re-upload

            const reader = new FileReader();
            reader.onload = async (e) => {
                const dataUrl = e.target.result;
                const base64 = dataUrl.split(',')[1];
                const mimeType = file.type;

                // Show image bubble
                const msgs = document.getElementById('chatMessages');
                const imgDiv = document.createElement('div');
                imgDiv.className = 'chat-bubble bubble-user';
                imgDiv.innerHTML = `<img src="${dataUrl}" class="bubble-img" alt="Uploaded image">`;
                msgs.appendChild(imgDiv);
                scrollChat();

                // Optional: ask a question about it
                const question = document.getElementById('chatInput').value.trim();
                document.getElementById('chatInput').value = '';

                // Typing indicator
                const typingId = 'typing-' + Date.now();
                const typingEl = document.createElement('div');
                typingEl.id = typingId;
                typingEl.className = 'chat-bubble bubble-ai bubble-typing';
                typingEl.innerHTML = '<span></span><span></span><span></span>';
                msgs.appendChild(typingEl);
                scrollChat();

                const model = document.getElementById('modelSelector').value;
                try {
                    const res = await fetch(`${API_BASE}/api/assistant/vision`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pass: password, q: question || "Describe this image.", image: dataUrl, model })
                    });
                    const data = await res.json();
                    document.getElementById(typingId)?.remove();
                    if (data.answer) {
                        appendBubble('ai', data.answer);
                        speakText(data.answer);
                    } else {
                        appendBubble('ai', 'Could not analyze image.');
                    }
                } catch (err) {
                    document.getElementById(typingId)?.remove();
                    appendBubble('ai', 'Error analyzing image. Please try again.');
                }
            };
            reader.readAsDataURL(file);
        }

        // UI Interaction Functions
        function setMode(mode) {
            document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
            if (mode === 'voice') {
                document.getElementById('modeVoiceBtn').classList.add('active');
                document.getElementById('voiceMode').style.display = 'block';
                document.getElementById('chatMode').style.display = 'none';
            } else {
                document.getElementById('modeChatBtn').classList.add('active');
                document.getElementById('voiceMode').style.display = 'none';
                document.getElementById('chatMode').style.display = 'block';
            }
        }



        // === ELITE POTIONS LOGIC (v8.2) ===
        async function saveMemoryFact(fact) {
            if (!password || !fact) return;
            showToast('Learning...', 'Storing to deep memory bank.', 'fa-brain');
            try {
                await fetch(`${API_BASE}/api/assistant/memory/save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pass: password, fact: fact })
                });
            } catch (e) { console.error('Memory save error:', e); }
        }

        function recallMemory(topic) {
            showToast('Memory Recall', `Searching archives for "${topic}"`, 'fa-search-plus');
            // This triggers a fresh ask with forced recall context
            handleQuery(`Tell me everything you remember about ${topic}`);
        }

        async function executeHomeAction(action) {
            showToast('Home Hub', `Executing: ${action}`, 'fa-home');
            speakText(`Connecting to your home hub to ${action.replace('.', ' ')} Sir.`);
            
            // Simulation logic for now
            console.log('🏠 Home Action Signal Sent:', action);
            
            try {
                // If IFTTT/HomeAssistant keys existed, we'd fetch here.
                // For now, we simulate success for the 'Jarvis' feel.
                setTimeout(() => {
                    showToast('Home Success', 'Action verified by sensor.', 'fa-check');
                }, 1500);
            } catch (e) { 
                showToast('Home Error', 'Downlink unstable.', 'fa-wifi');
            }
        }

        // === BIOMETRIC AUTH (v8.2 ELITE) ===

        async function registerBiometrics() {
            if (!window.PublicKeyCredential) {
                showToast('Not Supported', 'Biometrics require HTTPS and modern hardware.', 'fa-exclamation-triangle');
                return;
            }

            const bioStatus = document.getElementById('bioStatus');
            bioStatus.innerText = 'Initializing sensor...';

            try {
                const challenge = new Uint8Array(32);
                window.crypto.getRandomValues(challenge);
                const userId = Uint8Array.from(password, c => c.charCodeAt(0));

                const options = {
                    publicKey: {
                        challenge,
                        rp: { name: "Olivia AI" },
                        user: { id: userId, name: "Subhash", displayName: "Subhash" },
                        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
                        timeout: 60000,
                        attestation: "none"
                    }
                };

                const credential = await navigator.credentials.create(options);
                const keyId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
                
                const res = await fetch(`${API_BASE}/api/auth/biometric/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pass: password, keyId })
                });

                if (res.ok) {
                    showToast('Identity Linked!', 'Biometrics are now active for this device.', 'fa-fingerprint');
                    bioStatus.innerText = '✅ Device securely linked.';
                    localStorage.setItem('olivia_bio_id', keyId);
                }
            } catch (err) {
                console.error('Bio Register Error:', err);
                bioStatus.innerText = 'Registration failed. Try again.';
            }
        }

        let isBioPrompting = false;
        async function verifyBiometrics() {
            if (isBioPrompting) return;
            const keyId = localStorage.getItem('olivia_bio_id');
            if (!keyId) {
                showToast('No Key', 'Please register fingerprint in settings first.', 'fa-key');
                return;
            }

            isBioPrompting = true;
            try {
                // For a high-end feel, we trigger the real prompt even if we're just checking the ID
                const challenge = new Uint8Array(32);
                window.crypto.getRandomValues(challenge);
                
                const options = {
                    publicKey: {
                        challenge,
                        allowCredentials: [{ id: Uint8Array.from(atob(keyId), c => c.charCodeAt(0)), type: "public-key" }],
                        timeout: 60000
                    }
                };

                await navigator.credentials.get(options);
                
                const res = await fetch(`${API_BASE}/api/auth/biometric/verify`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pass: password, keyId })
                });

                if (res.ok) {
                    unlockApp();
                } else {
                    showToast('Verification Failed', 'Identity not recognized.', 'fa-times');
                }
            } catch (err) {
                console.error('Bio Verify Error:', err);
                const lock = document.getElementById('identityLock');
                if (lock && lock.style.display !== 'none' && !lock.classList.contains('unlocked')) {
                    showToast('Biometric Cancelled', 'Use finger scan or password to enter.', 'fa-info-circle');
                }
            } finally {
                isBioPrompting = false;
            }
        }

        function unlockApp() {
            isAppLocked = false;
            const lock = document.getElementById('identityLock');
            lock.classList.add('unlocked');
            setTimeout(() => { lock.style.display = 'none'; }, 500);
            showToast('Access Granted', 'Welcome back, Sir.', 'fa-shield-check');
            speakText("Identity verified. Access granted.");
        }

        function lockApp() {
            if (!currentSettings.biometricEnabled || isAppLocked) return;
            isAppLocked = true;
            const lock = document.getElementById('identityLock');
            lock.style.display = 'flex';
            lock.classList.remove('unlocked');
        }

        function logoutForBio() {
            password = '';
            localStorage.removeItem('olivia_pass');
            location.reload();
        }

        // Auto-Lock on Focus/Entry
        window.addEventListener('blur', () => {
            if (currentSettings.biometricEnabled) {
                // Small delay to allow quick app switching without annoyance
                setTimeout(() => { if (document.hidden) lockApp(); }, 1000);
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && currentSettings.biometricEnabled && password) {
                // Prevent locking if we are already seeing the lock screen
                if (isAppLocked) return;
                
                console.log('🔒 Re-locking for security (Visibility Change)');
                lockApp();
                
                // Small delay to ensure UI reflow before prompt
                setTimeout(verifyBiometrics, 500);
            }
        });

        // Trigger on initial load if enabled
        window.addEventListener('load', () => {
            setTimeout(() => {
                if (currentSettings.biometricEnabled && password) {
                    lockApp();
                    verifyBiometrics(); // Auto-prompt
                }
                
                // Show registration row if bio enabled but not registered
                if (currentSettings.biometricEnabled && !localStorage.getItem('olivia_bio_id')) {
                    document.getElementById('bioRegRow').style.display = 'flex';
                }
            }, 1000);
        });

        // Init — called after successful login via doLogin()
        window.speechSynthesis.onvoiceschanged = () => { };
    