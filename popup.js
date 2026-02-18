// Enterprise HR Portal - Core Interface Logic
(function () {
    'use strict';

    // --- Configuration & State ---
    let timerInterval = null;
    const API_BASE = 'https://hr-portal.jspinfotech.com/api/v1';
    const PUNCH_DELAY_MS = 2 * 60 * 60 * 1000; // 2 Hours

    // --- DOM Accessors ---
    const nodes = {
        app: document.getElementById('app'),
        loginView: document.getElementById('login-view'),
        dashboardView: document.getElementById('dashboard-view'),
        profileStrip: document.getElementById('profile-strip'),
        userName: document.getElementById('user-display'),
        timerDisplay: document.getElementById('timer'),
        punchBtn: document.getElementById('punch-btn'),
        historyList: document.getElementById('history-list'),
        loginBtn: document.getElementById('login-btn'),
        logoutBtn: document.getElementById('logout-btn'),
        themeBtn: document.getElementById('theme-btn'),
        emailInput: document.getElementById('email'),
        passwordInput: document.getElementById('password'),
        loginError: document.getElementById('login-error'),
        statusToast: document.getElementById('status-msg'),
        statusDot: document.getElementById('status-dot'),
        statusText: document.getElementById('status-text'),
        rememberCheckbox: document.getElementById('remember-me')
    };

    // --- Initialization ---
    const init = async () => {
        const data = await chrome.storage.local.get(['token', 'user', 'theme', 'savedCreds']);

        // 0. Prefill credentials (Remember Me)
        if (data.savedCreds) {
            const savedEmail = data.savedCreds.email || '';
            const savedPassword = data.savedCreds.password || '';

            if (nodes.emailInput) {
                nodes.emailInput.value = savedEmail;
                // Some browsers/extensions can be picky about password fields; set both property + attribute.
                nodes.emailInput.setAttribute('value', savedEmail);
            }
            if (nodes.passwordInput) {
                nodes.passwordInput.value = savedPassword;
                nodes.passwordInput.setAttribute('value', savedPassword);
            }
            if (nodes.rememberCheckbox) nodes.rememberCheckbox.checked = true;
        }

        // 1. Theme Orchestration
        applyTheme(data.theme || 'dark');

        // 2. State & Auth Restoration
        if (data.token) {
            setupDashboard(data.user);
            await syncState();
        } else {
            transitionToView('login');
        }

        attachEvents();
    };

    const syncState = async () => {
        // First, restore state from local storage immediately (before API calls)
        // This ensures the UI shows the correct state even if API calls fail
        await restoreLocalState();
        
        // Then sync with server in the background (non-blocking)
        // Use setTimeout to delay server sync slightly, giving UI time to render
        setTimeout(async () => {
            try {
                // Fetch user info and history first (these don't affect punch state)
                await Promise.all([
                    fetchMe(),
                    fetchHistory()
                ]);
                
                // Then fetch status (but it won't overwrite if local state is recent)
                await fetchStatus();
            } catch (e) {
                console.error('Background sync failed:', e);
                // Don't clear local state if API fails - keep what we have
            }
        }, 500); // Small delay to ensure UI is rendered first
    };

    // Restore state from local storage immediately
    const restoreLocalState = async () => {
        try {
            console.log('=== Restoring local state ===');
            const data = await chrome.storage.local.get(['punchInTime', 'token', 'user']);
            console.log('Storage data retrieved:', {
                hasToken: !!data.token,
                hasPunchInTime: !!data.punchInTime,
                punchInTime: data.punchInTime,
                punchInTimeDate: data.punchInTime ? new Date(data.punchInTime).toLocaleString() : null
            });
            
            if (!data.token) {
                console.log('No token found, skipping state restoration');
                return; // Not logged in
            }

            if (data.punchInTime) {
                const punchInTime = data.punchInTime;
                const now = Date.now();

                // IMPORTANT: Do NOT clear punch state automatically based on date/inactivity.
                // If the user was punched in, we keep that state until an explicit Punch Out succeeds.
                console.log('Restoring punch-in time (no auto-clear):', {
                    punchInTime,
                    punchInTimeDate: new Date(punchInTime).toLocaleString(),
                    timeSincePunchSeconds: Math.floor((now - punchInTime) / 1000)
                });

                startTimer(punchInTime);
                updatePunchUI(true, punchInTime);
            } else {
                // No punch-in time stored, show offline state
                console.log('✗ No punch-in time in storage, showing offline state');
                updatePunchUI(false);
            }
        } catch (e) {
            console.error('✗ Error restoring local state:', e);
            console.error('Error stack:', e.stack);
            // On error, default to offline state
            updatePunchUI(false);
        }
    };

    const attachEvents = () => {
        if (nodes.loginBtn) nodes.loginBtn.onclick = handleLogin;
        if (nodes.logoutBtn) nodes.logoutBtn.onclick = handleLogout;
        if (nodes.punchBtn) nodes.punchBtn.onclick = handlePunch;
        if (nodes.themeBtn) nodes.themeBtn.onclick = toggleTheme;
    };

    // --- Theme Logic ---
    const applyTheme = (theme) => {
        document.body.setAttribute('data-theme', theme);
    };

    const toggleTheme = async () => {
        const current = document.body.getAttribute('data-theme');
        const next = current === 'light' ? 'dark' : 'light';

        // Add a temporary class for orchestrated theme swap effect if needed
        applyTheme(next);
        await chrome.storage.local.set({ theme: next });
    };

    // --- Authentication Flow ---
    const handleLogin = async () => {
        const email = nodes.emailInput.value.trim();
        const password = nodes.passwordInput.value;

        if (!email || !password) {
            showError('Invalid credentials provided.');
            return;
        }

        try {
            setLoading(nodes.loginBtn, true);
            const formData = new FormData();
            formData.append('email', email);
            formData.append('password', password);

            const response = await fetch(`${API_BASE}/login`, {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (response.ok && (result.token || result.data?.token)) {
                const token = result.token || result.data?.token;
                const user = {
                    name: result.user?.name || result.data?.user?.name || email.split('@')[0],
                    email: email
                };

                // Handle Remember Me
                if (nodes.rememberCheckbox?.checked) {
                    await chrome.storage.local.set({ savedCreds: { email, password } });
                } else {
                    await chrome.storage.local.remove('savedCreds');
                }

                await chrome.storage.local.set({ token, user });
                setupDashboard(user);
                renderHistory([]);
                updatePunchUI(false);
                showToast('Welcome back');
            } else {
                showError(result.message || 'Login failed. Check credentials.');
            }
        } catch (e) {
            console.error('Login Error:', e);
            showError('Connection error during login.');
        } finally {
            setLoading(nodes.loginBtn, false, 'Authenticate');
        }
    };

    const handleLogout = async ({ preservePunch = false } = {}) => {
        const data = await chrome.storage.local.get(['token']);

        if (data.token) {
            try {
                setLoading(nodes.logoutBtn, true);
                // Notifying server of logout
                await fetch(`${API_BASE}/logout`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${data.token}`,
                        'Accept': 'application/json'
                    }
                });
            } catch (e) {
                console.error('Logout API failure:', e);
            } finally {
                setLoading(nodes.logoutBtn, false, 'Sign Out');
            }
        }

        // Targeted removal of authentication state instead of clearing everything
        if (preservePunch) {
            // Keep `punchInTime` so punch-in state can be restored after re-login/session refresh.
            await chrome.storage.local.remove(['token', 'user']);
        } else {
            await chrome.storage.local.remove(['token', 'user', 'punchInTime']);
        }
        stopTimer();
        transitionToView('login');
        showToast('Logged out successfully');
    };

    // --- View Transitions ---
    const transitionToView = (view) => {
        const isLogin = view === 'login';

        // Use classes for orchestrated CSS transitions
        [nodes.loginView, nodes.dashboardView].forEach(v => v.classList.add('hide'));

        if (isLogin) {
            nodes.loginView.classList.remove('hide');
            nodes.loginView.classList.add('view-enter');
            nodes.profileStrip.classList.add('hide');
        } else {
            nodes.dashboardView.classList.remove('hide');
            nodes.dashboardView.classList.add('view-enter');
            nodes.profileStrip.classList.remove('hide');
        }

        // Cleanup transition class after animation completes
        setTimeout(() => {
            nodes.loginView.classList.remove('view-enter');
            nodes.dashboardView.classList.remove('view-enter');
        }, 600);
    };

    const setupDashboard = (user) => {
        nodes.userName.textContent = user?.name || 'Employee';
        transitionToView('dashboard');
    };

    // --- Persistence & Tracking ---
    const handlePunch = async () => {
        if (!navigator.onLine) {
            showToast('Offline: Check connection');
            return;
        }

        const data = await chrome.storage.local.get(['punchInTime', 'token']);
        if (!data.token) {
            handleLogout({ preservePunch: true });
            return;
        }

        const isPunchedIn = !!data.punchInTime;
        const type = isPunchedIn ? 'out' : 'in';
        const now = Date.now();

        // Single Shift Check: Prevent Punch In if already punched out today
        if (!isPunchedIn) {
            const historyData = await chrome.storage.local.get('history');
            const history = historyData.history || [];
            const todayStr = new Date().toDateString();
            const hasPunchedOutToday = history.some(item =>
                item.type === 'out' && new Date(item.timestamp).toDateString() === todayStr
            );

            if (hasPunchedOutToday) {
                showToast('Already completed today’s attendance');
                return;
            }
        }

        // 2-Hour Delay Validation
        if (isPunchedIn && (now - data.punchInTime < PUNCH_DELAY_MS)) {
            const remaining = Math.ceil((PUNCH_DELAY_MS - (now - data.punchInTime)) / 60000);
            showToast(`Min. stay required: ${remaining} mins left`);
            return;
        }

        try {
            setLoading(nodes.punchBtn, true);

            const formData = new FormData();
            formData.append('type', type);
            formData.append('timestamp', Math.floor(now / 1000));

            console.log('Sending punch request:', { type, timestamp: Math.floor(now / 1000) });
            
            const response = await apiFetch('/punch/action', {
                method: 'POST',
                body: formData
            });
            
            console.log('Punch response status:', response.status, response.statusText);

            // Get response text first, then try to parse as JSON
            const responseText = await response.text();
            let result;
            try {
                result = JSON.parse(responseText);
            } catch (jsonError) {
                console.error('Failed to parse response as JSON:', jsonError);
                console.error('Response text:', responseText);
                console.error('Response status:', response.status, response.statusText);
                showToast(`Server error: ${response.status} ${response.statusText}`);
                return;
            }

            // Log the full response for debugging
            console.log('Punch API response:', result);
            console.log('Response status:', response.status, response.ok);
            console.log('Result status:', result.status);
            console.log('Result keys:', Object.keys(result));

            // Check if there's an explicit error in the response
            const hasError = result.error || (result.message && result.message.toLowerCase().includes('error')) || 
                           (result.status && result.status.toLowerCase() === 'error');

            // Check for explicit success indicators - prioritize status === 'success'
            const isSuccess = result.status === 'success' || result.success === true || 
                            (result.data && result.data.status === 'success');

            console.log('Success check:', {
                hasError: hasError,
                isSuccess: isSuccess,
                resultStatus: result.status,
                responseOk: response.ok,
                responseStatus: response.status
            });

            // If response is 200 OK and (explicit success OR no explicit error), treat as success
            if (response.ok && response.status === 200 && (isSuccess || !hasError)) {
                console.log('✓ Punch action successful (200 OK), updating UI...');
                console.log('Punch type:', type, 'Timestamp:', now);
                
                // Update UI based on punch type
                if (type === 'in') {
                    console.log('→ Setting punchInTime to:', now);
                    console.log('→ Punch-in timestamp:', new Date(now).toLocaleString());
                    
                    // Save to storage with error handling
                    try {
                        await chrome.storage.local.set({ punchInTime: now });
                        console.log('→ punchInTime saved to storage');
                        
                        // Verify it was set correctly
                        const verify = await chrome.storage.local.get('punchInTime');
                        if (verify.punchInTime === now) {
                            console.log('→ ✓ Verified: punchInTime correctly stored:', verify.punchInTime);
                            console.log('→ ✓ Stored time:', new Date(verify.punchInTime).toLocaleString());
                        } else {
                            console.error('→ ✗ Storage verification failed! Expected:', now, 'Got:', verify.punchInTime);
                        }
                    } catch (storageError) {
                        console.error('→ ✗ Error saving to storage:', storageError);
                        showToast('Error saving punch-in time');
                        return;
                    }
                    
                    console.log('→ Starting timer with time:', now);
                    startTimer(now);
                    
                    console.log('→ Updating UI to punched in state');
                    updatePunchUI(true, now);
                    
                    // Verify UI was updated
                    console.log('→ UI Update verification:', {
                        buttonText: nodes.punchBtn?.textContent,
                        statusText: nodes.statusText?.textContent,
                        statusDotActive: nodes.statusDot?.classList.contains('active'),
                        timerDisplay: nodes.timerDisplay?.textContent
                    });
                    
                    showToast(result.message || 'Punched In Successfully');
                } else {
                    console.log('→ Removing punchInTime, updating UI to punched out');
                    await chrome.storage.local.remove('punchInTime');
                    stopTimer();
                    updatePunchUI(false);
                    showToast(result.message || 'Punched Out Successfully');
                }
                
                // Only fetch history, don't fetch status (it might overwrite our state)
                // The status is already updated by our UI changes above
                try {
                    await fetchHistory();
                    console.log('→ History refreshed successfully');
                } catch (syncError) {
                    console.error('Error syncing history after punch:', syncError);
                    // Don't fail the punch action if sync fails
                }
            } else {
                // Handle error case
                const errorMsg = result.message || result.error || result.msg || `Action failed (${response.status})`;
                console.error('✗ Punch action failed:', {
                    status: response.status,
                    response: result,
                    hasError: hasError,
                    isSuccess: isSuccess
                });
                showToast(errorMsg);
            }
        } catch (e) {
            console.error('Punch Error:', e);
            // Show more detailed error message
            const errorMsg = e.message || 'Network error. Please check your connection.';
            showToast(`Punch failed: ${errorMsg}`);
        } finally {
            setLoading(nodes.punchBtn, false, isPunchedIn ? 'Punch Out' : 'Punch In');
        }
    };

    // --- UI State Helpers ---
    const updatePunchUI = (active, punchInTime) => {
        console.log('updatePunchUI called with:', { active, punchInTime, nodesExist: !!nodes.punchBtn });
        
        if (!nodes.punchBtn) {
            console.error('Punch button node not found!');
            return;
        }

        console.log('Updating button:', { 
            currentText: nodes.punchBtn.textContent,
            newText: active ? 'Punch Out' : 'Punch In'
        });
        
        nodes.punchBtn.textContent = active ? 'Punch Out' : 'Punch In';
        nodes.punchBtn.className = `btn-punch ${active ? 'out' : 'in'}`;

        // Handle 2-hour restriction UI
        if (active && punchInTime) {
            const elapsed = Date.now() - punchInTime;
            if (elapsed < PUNCH_DELAY_MS) {
                nodes.punchBtn.classList.add('btn-disabled');
                nodes.punchBtn.title = 'Available after 2 hours of work';
            } else {
                nodes.punchBtn.classList.remove('btn-disabled');
                nodes.punchBtn.title = '';
            }
        } else {
            nodes.punchBtn.classList.remove('btn-disabled');
            nodes.punchBtn.title = '';
        }

        console.log('Updating status:', { 
            statusDotExists: !!nodes.statusDot,
            statusTextExists: !!nodes.statusText,
            active: active
        });
        
        if (nodes.statusDot) {
            if (active) {
                nodes.statusDot.classList.add('active');
            } else {
                nodes.statusDot.classList.remove('active');
            }
            console.log('Status dot classes:', nodes.statusDot.className);
        }
        
        if (nodes.statusText) {
            nodes.statusText.textContent = active ? 'Online' : 'Offline';
            console.log('Status text set to:', nodes.statusText.textContent);
        }

        if (!active && nodes.timerDisplay) {
            nodes.timerDisplay.textContent = '00:00:00';
        }
        
        console.log('UI update complete');
    };

    const renderHistory = (history) => {
        if (!nodes.historyList) return;
        if (!history || history.length === 0) {
            nodes.historyList.innerHTML = '<div class="empty-log">No session activity found</div>';
            return;
        }

        nodes.historyList.innerHTML = history.slice(-5).reverse().map((item, index) => {
            const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            // Add staggered delay for list entries
            return `
                <div class="entry-item" style="animation-delay: ${index * 0.1}s">
                    <span class="entry-type type-${item.type}">${item.type.toUpperCase()}</span>
                    <span class="entry-time">${time}</span>
                </div>
            `;
        }).join('');
    };

    const logActivity = async (type) => {
        const data = await chrome.storage.local.get('history');
        const history = data.history || [];
        history.push({ type, timestamp: Date.now() });
        const snapshot = history.slice(-20);
        await chrome.storage.local.set({ history: snapshot });
        renderHistory(snapshot);
    };

    // --- API Helpers ---
    const apiFetch = async (endpoint, options = {}) => {
        const data = await chrome.storage.local.get('token');
        if (!data.token) {
            handleLogout({ preservePunch: true });
            throw new Error('No token found');
        }

        // Build headers - don't set Content-Type for FormData (browser sets it automatically)
        const headers = {
            'Authorization': `Bearer ${data.token}`,
            'Accept': 'application/json',
            ...options.headers
        };

        // If body is FormData, don't set Content-Type header (browser will set it with boundary)
        if (options.body instanceof FormData) {
            delete headers['Content-Type'];
        }

        try {
            console.log(`Making API request to: ${API_BASE}${endpoint}`, {
                method: options.method || 'GET',
                hasBody: !!options.body,
                headers: headers
            });
            
            const response = await fetch(`${API_BASE}${endpoint}`, {
                ...options,
                headers
            });

            console.log(`API response for ${endpoint}:`, {
                status: response.status,
                statusText: response.statusText,
                ok: response.ok
            });

            if (response.status === 401) {
                // Session expired; don't wipe punch state from storage.
                handleLogout({ preservePunch: true });
                throw new Error('Session expired');
            }

            return response;
        } catch (error) {
            console.error(`API Fetch Error for ${endpoint}:`, error);
            // Re-throw with more context
            throw new Error(`Network request failed: ${error.message}`);
        }
    };

    const fetchMe = async () => {
        try {
            const response = await apiFetch('/me');
            const result = await response.json();
            if (response.ok && result.user) {
                nodes.userName.textContent = result.user.name;
                await chrome.storage.local.set({ user: { name: result.user.name, email: result.user.business_email } });
            }
        } catch (e) {
            console.error('Fetch Me error:', e);
        }
    };

    const fetchStatus = async () => {
        try {
            const response = await apiFetch('/user/status');
            const result = await response.json();
            if (response.ok) {
                const isPunchedIn = result.isPunchedIn;
                const serverPunchInTime = result.punchInTime; // Assuming "10:16:29 AM" or similar

                // Get local state first
                let localData = await chrome.storage.local.get('punchInTime');
                let localStartTime = localData.punchInTime;

                if (isPunchedIn) {
                    // Server says user is punched in
                    let startTime = localStartTime;

                    // Prefer local start time when available (it persists across popup closes)
                    if (localStartTime) {
                        startTime = localStartTime;
                    }

                    // If no valid local time, try to parse server time
                    if (!startTime && serverPunchInTime) {
                        try {
                            // Try parsing serverPunchInTime (it might be "10:16:29 AM" or a full ISO string)
                            let parsedTime;
                            if (serverPunchInTime.includes(':')) {
                                const today = new Date();
                                const timeStr = serverPunchInTime.match(/(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\s*(AM|PM))?/i);
                                if (timeStr) {
                                    let [_, hours, minutes, seconds, modifier] = timeStr;
                                    hours = parseInt(hours, 10);
                                    minutes = parseInt(minutes, 10);
                                    seconds = parseInt(seconds, 10);
                                    if (modifier) {
                                        if (modifier.toUpperCase() === 'PM' && hours < 12) hours += 12;
                                        if (modifier.toUpperCase() === 'AM' && hours === 12) hours = 0;
                                    }
                                    today.setHours(hours, minutes, seconds, 0);
                                    parsedTime = today.getTime();
                                }
                            } else {
                                // Try parsing as ISO string or timestamp
                                parsedTime = new Date(serverPunchInTime).getTime();
                            }

                            if (parsedTime && !isNaN(parsedTime)) {
                                startTime = parsedTime;
                                await chrome.storage.local.set({ punchInTime: startTime });
                                console.log('Updated punch-in time from server:', startTime);
                            }
                        } catch (parseError) {
                            console.error('Failed to parse server time:', serverPunchInTime, parseError);
                        }
                    }

                    // If still no start time, use current time as fallback (shouldn't happen)
                    if (!startTime) {
                        console.warn('No valid punch-in time found, using current time');
                        startTime = Date.now();
                        await chrome.storage.local.set({ punchInTime: startTime });
                    }

                    // Update UI with the start time
                    startTimer(startTime);
                    updatePunchUI(true, startTime);
                } else {
                    // Server says user is NOT punched in.
                    // IMPORTANT: Do NOT clear local punch state automatically (inactivity / server lag / cross-day).
                    // Only clear punch state when an explicit Punch Out succeeds.
                    if (localStartTime) {
                        console.warn('Server says not punched in, but local punch state exists. Preserving local punch state.', {
                            localStartTime,
                            localStartTimeDate: new Date(localStartTime).toLocaleString()
                        });
                        startTimer(localStartTime);
                        updatePunchUI(true, localStartTime);
                        return;
                    }

                    // No local state -> show offline
                    stopTimer();
                    updatePunchUI(false);
                }
            } else {
                // API call failed - don't change local state
                console.warn('Fetch status API failed, preserving local state');
            }
        } catch (e) {
            console.error('Fetch Status error:', e);
            // On error, preserve local state - don't clear it
            // The UI should already be restored from restoreLocalState()
        }
    };

    const fetchHistory = async () => {
        try {
            const response = await apiFetch('/punch/history');
            const result = await response.json();
            if (response.ok && result.history) {
                renderHistory(result.history);
                await chrome.storage.local.set({ history: result.history });
            }
        } catch (e) {
            console.error('Fetch History error:', e);
        }
    };

    const startTimer = (startTime) => {
        console.log('startTimer called with:', startTime);
        console.log('Current time:', Date.now());
        console.log('Timer display node exists:', !!nodes.timerDisplay);
        
        if (timerInterval) {
            console.log('Clearing existing timer interval');
            clearInterval(timerInterval);
        }
        
        const update = () => {
            const diff = Date.now() - startTime;
            const h = String(Math.floor(diff / 3600000)).padStart(2, '0');
            const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
            const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
            const timeString = `${h}:${m}:${s}`;
            
            if (nodes.timerDisplay) {
                nodes.timerDisplay.textContent = timeString;
            } else {
                console.error('Timer display node not found!');
            }
        };
        
        update(); // Update immediately
        timerInterval = setInterval(update, 1000);
        console.log('Timer started, interval ID:', timerInterval);
    };

    const stopTimer = () => {
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = null;
    };

    const setLoading = (btn, isLoading, originalText) => {
        if (!btn) return;
        if (isLoading) {
            btn.classList.add('btn-loading');
            btn.disabled = true;
        } else {
            btn.classList.remove('btn-loading');
            btn.disabled = false;
            if (originalText) btn.textContent = originalText;
        }
    };

    const showError = (msg) => {
        showToast(msg);
    };

    const showToast = (msg) => {
        if (!nodes.statusToast) return;
        nodes.statusToast.textContent = msg;
        nodes.statusToast.classList.add('show');
        setTimeout(() => nodes.statusToast.classList.remove('show'), 3000);
    };

    // --- Bootstrap ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
