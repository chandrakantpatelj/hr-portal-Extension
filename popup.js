// Enterprise HR Portal - Core Interface Logic
(function () {
    'use strict';

    // --- Configuration & State ---
    let timerInterval = null;
    const API_BASE = 'http://hr-portal.jspinfotech.com/api/v1';
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

        // 0. Prefill credentials
        if (data.savedCreds) {
            nodes.emailInput.value = data.savedCreds.email || '';
            nodes.passwordInput.value = data.savedCreds.password || '';
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
        try {
            await Promise.all([
                fetchMe(),
                fetchStatus(),
                fetchHistory()
            ]);
        } catch (e) {
            console.error('Initial sync failed:', e);
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

            const response = await fetch('https://hr-portal.jspinfotech.com/api/v1/login', {
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
                showToast(result.message || 'Login failed. Check credentials.');
            }
        } catch (e) {
            console.error('Login Error:', e);
            showToast('Connection error during login.');
        } finally {
            setLoading(nodes.loginBtn, false, 'Authenticate');
        }
    };

    const handleLogout = async () => {
        const data = await chrome.storage.local.get(['token']);

        if (data.token) {
            try {
                setLoading(nodes.logoutBtn, true);
                // Notifying server of logout
                await fetch('http://hr-portal.jspinfotech.com/api/v1/logout', {
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

        await chrome.storage.local.clear();
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
            handleLogout();
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

            const response = await apiFetch('/punch/action', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (response.ok && result.status === 'success') {
                if (type === 'in') {
                    await chrome.storage.local.set({ punchInTime: now });
                    startTimer(now);
                    updatePunchUI(true, now);
                    showToast('Punched In Successfully');
                } else {
                    await chrome.storage.local.remove('punchInTime');
                    stopTimer();
                    updatePunchUI(false);
                    showToast('Punched Out Successfully');
                }
                await fetchStatus();
                await fetchHistory();
            } else {
                showToast(result.message || 'Action failed');
            }
        } catch (e) {
            console.error('Punch Error:', e);
            showToast('Sync Error');
        } finally {
            setLoading(nodes.punchBtn, false, isPunchedIn ? 'Punch Out' : 'Punch In');
        }
    };

    // --- UI State Helpers ---
    const updatePunchUI = (active, punchInTime) => {
        if (!nodes.punchBtn) return;

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

        if (nodes.statusDot) nodes.statusDot.classList.toggle('active', active);
        if (nodes.statusText) nodes.statusText.textContent = active ? 'Online' : 'Offline';

        if (!active && nodes.timerDisplay) nodes.timerDisplay.textContent = '00:00:00';
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
            handleLogout();
            throw new Error('No token found');
        }

        const headers = {
            'Authorization': `Bearer ${data.token}`,
            'Accept': 'application/json',
            ...options.headers
        };

        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers
        });

        if (response.status === 401) {
            handleLogout();
            throw new Error('Session expired');
        }

        return response;
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

                if (isPunchedIn) {
                    let localData = await chrome.storage.local.get('punchInTime');
                    let startTime = localData.punchInTime;

                    // Midnight/Split Check
                    if (startTime) {
                        const punchDate = new Date(startTime).toDateString();
                        const todayDate = new Date().toDateString();
                        if (punchDate !== todayDate) {
                            // Cross-day session detected
                            console.log('Session crossed midnight. Syncing fresh state.');
                            // For simplicity, we trust the server's state, but we might want to alert if server says still in.
                        }
                    }

                    // If server says punched in but we don't have local time, 
                    // we try to parse server time or use current time as fallback for timer.
                    if (!startTime && serverPunchInTime) {
                        // Very basic parsing for "HH:MM:SS AM/PM"
                        const [time, modifier] = serverPunchInTime.split(' ');
                        let [hours, minutes, seconds] = time.split(':');
                        if (hours === '12') hours = '00';
                        if (modifier === 'PM') hours = parseInt(hours, 10) + 12;

                        const serverTime = new Date();
                        serverTime.setHours(hours, minutes, seconds, 0);
                        startTime = serverTime.getTime();
                        await chrome.storage.local.set({ punchInTime: startTime });
                    }

                    if (startTime) {
                        startTimer(startTime);
                        updatePunchUI(true, startTime);
                    }
                } else {
                    await chrome.storage.local.remove('punchInTime');
                    stopTimer();
                    updatePunchUI(false);
                }
            }
        } catch (e) {
            console.error('Fetch Status error:', e);
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
        if (timerInterval) clearInterval(timerInterval);
        const update = () => {
            const diff = Date.now() - startTime;
            const h = String(Math.floor(diff / 3600000)).padStart(2, '0');
            const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
            const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
            if (nodes.timerDisplay) nodes.timerDisplay.textContent = `${h}:${m}:${s}`;
        };
        update();
        timerInterval = setInterval(update, 1000);
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
