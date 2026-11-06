// ============================
// Global variables
// ============================
// ============================
// Config
// ============================
// API_BASE / DASHBOARD_URL come from ../config.js (loaded before this script)
const API_BASE = SCULPT_CONFIG.API_BASE; // shorthand alias used throughout
const DASHBOARD_URL = SCULPT_CONFIG.DASHBOARD_URL;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
let jobDescriptionFull = "";
let isExpanded = false;
let currentUser = null;

// ============================
// Helpers
// ============================

/** Inline icon from the sprite in popup.html (one set, one stroke). */
function icon(name, extraClass = "") {
    return `<svg class="icon ${extraClass}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}
const SPINNER = icon("loader", "icon-spin keep-motion");

/** Briefly ring a section so the user sees where to act next. */
function flashSection(el) {
    if (!el) return;
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1800);
}

/** Safely extract a human-readable message from a FastAPI error payload. */
function apiErrorMessage(error, fallback) {
    if (!error) return fallback;
    // String detail (most auth errors)
    if (typeof error.detail === "string") return error.detail;
    // Array of validation errors (422 Unprocessable Entity)
    if (Array.isArray(error.detail)) {
        return error.detail.map((e) => e.msg || JSON.stringify(e)).join(", ");
    }
    // Plain Error object
    if (error.message) return error.message;
    return fallback;
}


function getFromStorage(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function setToStorage(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

// ============================
// Background message helpers
// ============================

/** Send a message to the background service worker and await its response. */
function sendToBackground(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (response?.error) {
                reject({ message: response.error });
                return;
            }
            resolve(response);
        });
    });
}

// ============================
// Session Persistence
// Keys: session_jd, session_jd_cache_id, session_ats_score,
//       session_optimized_score, session_improvements,
//       session_progress, session_optimized_yaml,
//       optimization_status, optimization_error
// ============================
async function saveSession(patch) {
    await setToStorage(patch);
}

async function restoreSession() {
    const s = await getFromStorage([
        "session_jd", "session_jd_cache_id",
        "session_ats_score", "session_ats_breakdown", "session_optimized_score",
        "session_improvements", "session_progress",
        "session_optimized_yaml", "optimization_status", "optimization_error",
        "analyze_status", "analyze_error",
        "upload_status", "upload_error", "upload_filename",
        "session_resume_changes",
        "selected_template",
        "daily_usage", "monthly_usage", "weekly_usage", "weekly_limit",
    ]);

    // ---- Restore upload state ----
    if (s.upload_status === "running") {
        showUploadingState(true, s.upload_filename);
        startUploadPoller();
    } else if (s.upload_status === "error") {
        showUploadError(s.upload_error || "Upload failed.");
    }
    // upload_status === "done" is already reflected in has_resume (set by background)

    if (!s.session_jd) return; // Nothing else to restore

    // Restore job description
    jobDescriptionFull = s.session_jd;
    displayJobDescription();
    if (s.selected_template && document.getElementById("templateSelect")) {
        document.getElementById("templateSelect").value = s.selected_template;
    }
    document.querySelector(".input-section").style.display = "none";
    updateProgress(1);

    // ---- Restore analyze state ----
    if (s.analyze_status === "running") {
        const btn = document.getElementById("analyzeBtn");
        btn.disabled = true;
        showLoadingState(btn, "Analyzing…");
        TaskProgress.start("Analyzing resume compatibility", 15_000);
        startAnalyzePoller();
    } else if (s.analyze_status === "error") {
        showError("Analysis failed: " + (s.analyze_error || "Unknown error"));
        document.getElementById("analyzeBtn").disabled = false;
    } else if (s.session_ats_score != null) {
        const origEl = document.getElementById("originalScore");
        if (origEl) origEl.textContent = `${Math.round(s.session_ats_score)}%`;
        // Restore breakdown card if we have saved data
        if (s.session_ats_breakdown) {
            try { renderATSBreakdown(JSON.parse(s.session_ats_breakdown)); } catch (_) { }
        }
        document.getElementById("analyzeBtn").disabled = false;
        document.getElementById("generateBtn").disabled = false;
        updateProgress(2);
    } else {
        document.getElementById("analyzeBtn").disabled = false;
    }

    // ---- Restore optimization state ----
    if (s.optimization_status === "done" && s.session_optimized_score != null) {
        handleOptimizeDone({
            original_score: s.session_ats_score ?? 0,
            optimized_score: s.session_optimized_score,
            improvements_made: s.session_improvements || [],
            resume_changes: s.session_resume_changes || [],
        });
    } else if (s.optimization_status === "running") {
        setGenerateButtonRunning(true);
        TaskProgress.start("Generating optimized resume", 40_000);
        startResultPoller();
    } else if (s.optimization_status === "error") {
        showError(`Optimization failed: ${s.optimization_error || "Unknown error"}`);
        setGenerateButtonRunning(false);
    }

    // Safety net: always unlock Download if YAML is already in storage
    if (s.session_optimized_yaml) {
        const dlBtn = document.getElementById("downloadBtn");
        if (dlBtn) { dlBtn.style.display = "inline-flex"; dlBtn.disabled = false; }
        const texBtn = document.getElementById("downloadTexBtn");
        if (texBtn) { texBtn.style.display = "inline-flex"; texBtn.disabled = false; }
        const startOverBtn = document.getElementById("startOverBtn");
        if (startOverBtn) { startOverBtn.style.display = "inline-flex"; }
        const explainBtn = document.getElementById("explainChangesBtn");
        if (explainBtn) { explainBtn.style.display = "inline-flex"; }
    }

    if (s.session_jd) {
        const homeBtn = document.getElementById("homeBtn");
        if (homeBtn) { homeBtn.style.display = "inline-flex"; }
    }
}


let _resultPollerTimer = null;
let _uploadPollerTimer = null;
let _analyzePollerTimer = null;

/** Poll until upload completes or errors. */
function startUploadPoller() {
    if (_uploadPollerTimer) return;
    _uploadPollerTimer = setInterval(async () => {
        const s = await getFromStorage(["upload_status", "upload_error", "resume_filename"]);
        if (s.upload_status === "done") {
            clearInterval(_uploadPollerTimer); _uploadPollerTimer = null;
            handleUploadDone(s.resume_filename || "resume.pdf");
        } else if (s.upload_status === "error") {
            clearInterval(_uploadPollerTimer); _uploadPollerTimer = null;
            handleUploadError(s.upload_error || "Upload failed.");
        }
    }, 1000);
}
function stopUploadPoller() {
    clearInterval(_uploadPollerTimer); _uploadPollerTimer = null;
}

/** Poll until ATS analysis completes or errors. */
function startAnalyzePoller() {
    if (_analyzePollerTimer) return;
    _analyzePollerTimer = setInterval(async () => {
        const s = await getFromStorage(["analyze_status", "analyze_error", "session_ats_score", "session_ats_breakdown"]);
        if (s.analyze_status === "done" && s.session_ats_score != null) {
            clearInterval(_analyzePollerTimer); _analyzePollerTimer = null;
            let breakdownObj = null;
            if (s.session_ats_breakdown) {
                try { breakdownObj = JSON.parse(s.session_ats_breakdown); } catch (_) {}
            }
            handleAnalyzeDone(s.session_ats_score, breakdownObj);
        } else if (s.analyze_status === "error") {
            clearInterval(_analyzePollerTimer); _analyzePollerTimer = null;
            handleAnalyzeError(s.analyze_error || "Unknown error");
        }
    }, 1000);
}
function stopAnalyzePoller() {
    clearInterval(_analyzePollerTimer); _analyzePollerTimer = null;
}

function stopResultPoller() {
    clearInterval(_resultPollerTimer); _resultPollerTimer = null;
}

/** Poll until optimization completes or errors (catches missed OPTIMIZE_DONE push). */
function startResultPoller() {
    if (_resultPollerTimer) return; // already polling
    _resultPollerTimer = setInterval(async () => {
        const s = await getFromStorage([
            "optimization_status", "optimization_error",
            "session_optimized_score", "session_ats_score",
            "session_improvements",
            "weekly_usage", "weekly_limit", "daily_usage", "monthly_usage",
        ]);

        if (s.optimization_status === "done" && s.session_optimized_score != null) {
            clearInterval(_resultPollerTimer);
            _resultPollerTimer = null;
            handleOptimizeDone({
                original_score:   s.session_ats_score,
                optimized_score:  s.session_optimized_score,
                improvements_made: s.session_improvements || [],
                weekly_usage:     s.weekly_usage  ?? 0,
                weekly_limit:     s.weekly_limit  ?? 5,
                daily_usage:      s.daily_usage   ?? 0,
                monthly_usage:    s.monthly_usage ?? 0,
            });
        } else if (s.optimization_status === "error") {
            clearInterval(_resultPollerTimer);
            _resultPollerTimer = null;
            handleOptimizeError(s.optimization_error || "Unknown error during optimization.");
        }
        // still "running" → keep polling
    }, 1000);
}


async function clearSession() {
    await chrome.storage.local.remove([
        "session_jd", "session_jd_cache_id",
        "session_ats_score", "session_optimized_score",
        "session_improvements", "session_progress",
        "session_optimized_yaml", "optimization_status", "optimization_error",
    ]);
}

// ============================
// Task Progress Bar
// ============================
const TaskProgress = {
    _timer: null,
    _start: 0,
    _duration: 0,
    _pct: 0,

    /**
     * Start the progress bar.
     * @param {string} label      - e.g. "Analyzing resume…"
     * @param {number} durationMs - expected total duration (ms). Bar reaches ~90% at this point.
     */
    start(label, durationMs) {
        this.stop();
        this._start = Date.now();
        this._duration = durationMs;
        this._pct = 0;

        const wrap = document.getElementById("taskProgressWrap");
        const bar = document.getElementById("taskProgressBar");
        const pctEl = document.getElementById("taskProgressPct");
        const lbl = document.getElementById("taskProgressLabel");
        const eta = document.getElementById("taskProgressEta");

        if (!wrap) return;
        wrap.style.display = "block";
        lbl.textContent = label;
        bar.style.transform = "scaleX(0)";
        pctEl.textContent = "0%";
        eta.textContent = "";

        this._timer = setInterval(() => {
            const elapsed = Date.now() - this._start;
            const ratio = Math.min(elapsed / this._duration, 1);
            // Ease-out: fast start, slow near the end — caps at 90%
            const eased = (1 - Math.pow(1 - ratio, 3)) * 90;
            this._pct = Math.round(eased);

            bar.style.transform = `scaleX(${this._pct / 100})`;
            pctEl.textContent = `${this._pct}%`;

            const remaining = Math.max(0, Math.round((this._duration - elapsed) / 1000));
            eta.textContent = remaining > 0 ? `About ${remaining}s remaining` : "Almost done…";
        }, 400);
    },

    /** Snap to 100% and hide after a short delay. */
    done() {
        clearInterval(this._timer);
        this._timer = null;

        const bar = document.getElementById("taskProgressBar");
        const pctEl = document.getElementById("taskProgressPct");
        const eta = document.getElementById("taskProgressEta");
        const wrap = document.getElementById("taskProgressWrap");

        if (!bar) return;
        bar.style.transform = "scaleX(1)";
        pctEl.textContent = "100%";
        if (eta) eta.textContent = "Done.";

        setTimeout(() => {
            if (wrap) wrap.style.display = "none";
            if (bar) bar.style.transform = "scaleX(0)";
        }, 900);
    },

    /** Hide immediately (e.g. on error). */
    stop() {
        clearInterval(this._timer);
        this._timer = null;
        const wrap = document.getElementById("taskProgressWrap");
        if (wrap) wrap.style.display = "none";
    },
};


// ============================
// Initialize
// ============================
document.addEventListener("DOMContentLoaded", async function () {
    await checkAuthStatus();
    initializeEventListeners();
    listenToBackground();
});

async function checkAuthStatus() {
    const {
        access_token, user_email, has_resume, resume_filename,
        email_verified, is_byok_allowed, is_admin,
        weekly_usage, weekly_limit, daily_usage, monthly_usage, plan,
    } = await getFromStorage([
        "access_token", "user_email", "has_resume", "resume_filename",
        "email_verified", "is_byok_allowed", "is_admin",
        "weekly_usage", "weekly_limit", "daily_usage", "monthly_usage", "plan",
    ]);

    if (!access_token) {
        showAuthScreen();
        return;
    }

    currentUser = {
        email:          user_email,
        has_resume:     !!has_resume,
        resume_filename,
        email_verified: email_verified ?? true,
        is_byok_allowed: !!is_byok_allowed,
        is_admin:       !!is_admin,
        plan:           plan ?? "free",
        weekly_usage:   weekly_usage  ?? 0,
        weekly_limit:   weekly_limit  ?? 5,
        daily_usage:    daily_usage   ?? 0,
        monthly_usage:  monthly_usage ?? 0,
    };
    showMainApp();

    // Silently refresh the token if it expires within 24 hours
    tryRefreshToken(access_token);

    // Re-check profile to keep entitlement and verification up to date
    try {
        const res = await fetch(`${API_BASE}/auth/me`, {
            headers: { "Authorization": `Bearer ${access_token}` },
        });
        if (res.ok) {
            const data = await res.json();
            currentUser.email_verified = data.email_verified;
            currentUser.is_byok_allowed = data.is_byok_allowed ?? false;
            currentUser.is_admin = data.is_admin ?? false;
            currentUser.plan = data.plan;
            currentUser.weekly_usage = data.weekly_usage;
            currentUser.weekly_limit = data.weekly_limit;
            await setToStorage({
                email_verified: data.email_verified,
                is_byok_allowed: data.is_byok_allowed ?? false,
                is_admin: data.is_admin ?? false,
                plan: data.plan,
                weekly_usage: data.weekly_usage,
                weekly_limit: data.weekly_limit,
            });
            const banner = document.getElementById("unverifiedBanner");
            if (banner && data.email_verified) banner.remove();
            renderKeyStatus();
        }
    } catch {
        // Network error — ignore
    }
}

/**
 * Decode a JWT payload (no signature verification — read-only).
 * Returns the exp timestamp in seconds, or null if unreadable.
 */
function getTokenExpiry(token) {
    try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        return payload.exp ?? null;
    } catch {
        return null;
    }
}

/**
 * If the token expires within 24 hours, silently call /auth/refresh
 * and store the new token so the user never sees a re-login screen.
 */
async function tryRefreshToken(currentToken) {
    const exp = getTokenExpiry(currentToken);
    if (!exp) return;

    const secondsLeft = exp - Math.floor(Date.now() / 1000);
    const oneDayInSeconds = 60 * 60 * 24;
    if (secondsLeft > oneDayInSeconds) return; // plenty of time left

    try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${currentToken}` },
        });
        if (!res.ok) return; // expired — user will be logged out on next API call
        const data = await res.json();
        await setToStorage({
            access_token:  data.access_token,
            user_email:    data.email,
            plan:          data.plan,
            has_resume:    data.has_resume,
            resume_filename: data.resume_filename,
            email_verified: data.email_verified,
            is_byok_allowed: data.is_byok_allowed ?? false,
            is_admin:      data.is_admin ?? false,
            weekly_usage:  data.weekly_usage,
            weekly_limit:  data.weekly_limit,
            daily_usage:   data.daily_usage,
            monthly_usage: data.monthly_usage,
        });
        // Update in-memory currentUser with refreshed data
        currentUser.plan           = data.plan;
        currentUser.is_byok_allowed = data.is_byok_allowed ?? false;
        currentUser.is_admin        = data.is_admin ?? false;
        currentUser.weekly_usage   = data.weekly_usage;
        currentUser.weekly_limit   = data.weekly_limit;
        currentUser.daily_usage    = data.daily_usage;
        currentUser.monthly_usage  = data.monthly_usage;
        currentUser.email_verified = data.email_verified;
        renderKeyStatus();
    } catch {
        // Network error — ignore, current token still works until expiry
    }
}



/** Listen for push notifications from the background worker. */
function listenToBackground() {
    chrome.runtime.onMessage.addListener((message) => {
        switch (message.type) {
            // ---- Upload ----
            case "UPLOAD_PROGRESS":
                showUploadingState(true);
                break;
            case "UPLOAD_DONE":
                stopUploadPoller();
                handleUploadDone(message.payload.filename);
                break;
            case "UPLOAD_ERROR":
                stopUploadPoller();
                handleUploadError(message.error);
                break;

            // ---- Analyze ----
            case "ANALYZE_PROGRESS":
                // already showing via button spinner — nothing extra needed
                break;
            case "ANALYZE_DONE":
                stopAnalyzePoller();
                handleAnalyzeDone(message.payload.overall_score, message.payload);
                break;
            case "ANALYZE_ERROR":
                stopAnalyzePoller();
                handleAnalyzeError(message.error);
                break;

            // ---- Optimize ----
            case "OPTIMIZE_PROGRESS":
                setGenerateButtonRunning(true);
                break;
            case "OPTIMIZE_DONE":
                stopResultPoller(); // cancel poller so it doesn't double-fire
                handleOptimizeDone(message.payload);
                break;
            case "OPTIMIZE_ERROR":
                stopResultPoller();
                handleOptimizeError(message.error);
                break;
        }
    });
}

function showAuthScreen() {
    document.getElementById("authScreen").style.display = "block";
    document.getElementById("mainApp").style.display = "none";
    document.documentElement.style.height = "480px";
    document.documentElement.style.overflow = "clip";
    document.body.style.height = "480px";
    document.body.style.overflow = "clip";
}

async function showMainApp() {
    document.getElementById("authScreen").style.display = "none";
    document.getElementById("mainApp").style.display = "flex";
    document.documentElement.style.height = "480px";
    document.documentElement.style.overflow = "clip";
    document.body.style.height = "480px";
    document.body.style.overflow = "clip";

    const userEmailEl = document.getElementById("userEmail");
    if (userEmailEl && currentUser) userEmailEl.textContent = currentUser.email;

    updateResumeUI(currentUser?.has_resume, currentUser?.resume_filename);
    await restoreSession();

    // Show usage meter from stored auth data
    updateUsageMeter(
        currentUser?.daily_usage  ?? 0,
        currentUser?.monthly_usage ?? 0,
        currentUser?.weekly_usage  ?? 0,
        currentUser?.weekly_limit  ?? 5,
        currentUser?.plan          ?? "free",
    );

    // Render the API key status (BYOK)
    await renderKeyStatus();

    // Remind unverified users to check their inbox
    if (currentUser && !currentUser.email_verified) {
        showUnverifiedBanner();
    }

    // Silently fetch and show history panel if optimizations exist
    loadHistory(false);

    // Auto-probe the active tab for a job description (non-blocking)
    probePageForJD();
}

function initializeEventListeners() {
    const loginBtn = document.getElementById("loginBtn");
    const signupBtn = document.getElementById("signupBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    const showSignupLink = document.getElementById("showSignup");
    const showLoginLink = document.getElementById("showLogin");

    if (loginBtn) loginBtn.addEventListener("click", handleLogin);
    if (signupBtn) signupBtn.addEventListener("click", handleSignup);
    if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
    document.getElementById("forgotPasswordLink")?.addEventListener("click", handleForgotPassword);
    if (showSignupLink) showSignupLink.addEventListener("click", () => toggleAuthForm("signup"));
    if (showLoginLink) showLoginLink.addEventListener("click", () => toggleAuthForm("login"));

    document.getElementById("googleLoginBtn")?.addEventListener("click", handleGoogleLogin);
    document.getElementById("googleSignupBtn")?.addEventListener("click", handleGoogleLogin);

    document.getElementById("landingBtn")?.addEventListener("click", handleLandingClick);
    document.getElementById("resumeFileInput")?.addEventListener("change", handleResumeUpload);
    document.getElementById("addJobBtn")?.addEventListener("click", handleAddJobClick);
    document.getElementById("fetchFromPageBtn")?.addEventListener("click", handleFetchFromPageClick);
    document.getElementById("removeJobBtn")?.addEventListener("click", handleRemoveJobClick);
    document.getElementById("readMoreBtn")?.addEventListener("click", handleReadMoreClick);
    document.getElementById("analyzeBtn")?.addEventListener("click", handleAnalyzeClick);
    document.getElementById("generateBtn")?.addEventListener("click", handleGenerateClick);
    document.getElementById("previewBtn")?.addEventListener("click", handlePreviewClick);
    document.getElementById("downloadBtn")?.addEventListener("click", handleDownloadClick);
    document.getElementById("downloadTexBtn")?.addEventListener("click", handleDownloadTexClick);
    document.getElementById("homeBtn")?.addEventListener("click", handleResetToHome);
    document.getElementById("startOverBtn")?.addEventListener("click", handleResetToHome);
    document.getElementById("postDownloadHomeBtn")?.addEventListener("click", handleResetToHome);
    document.getElementById("explainChangesBtn")?.addEventListener("click", handleExplainChangesClick);
    document.getElementById("closeExplanationBtn")?.addEventListener("click", () => {
        const panel = document.getElementById("explanationPanel");
        if (panel) panel.style.display = "none";
    });
    document.getElementById("templateSelect")?.addEventListener("change", (e) => {
        setToStorage({ selected_template: e.target.value });
    });
    document.getElementById("recalculateBtn")?.addEventListener("click", handleRecalculateClick);
    document.getElementById("changelogToggle")?.addEventListener("click", handleChangelogToggle);
    document.getElementById("atsToggleBtn")?.addEventListener("click", handleATSToggle);
    document.getElementById("historyToggle")?.addEventListener("click", handleHistoryToggle);

    const jobDescInput = document.getElementById("jobDescriptionInput");
    if (jobDescInput) jobDescInput.addEventListener("input", handleJobDescriptionInputChange);

    // BYOK / API key handlers
    document.getElementById("aiKeySaveBtn")?.addEventListener("click", handleSaveApiKey);
    document.getElementById("aiKeyTestBtn")?.addEventListener("click", handleTestApiKey);
    document.getElementById("apiKeyToggleBtn")?.addEventListener("click", handleApiKeyToggleVisibility);
    document.getElementById("aiKeyEditBtn")?.addEventListener("click", handleApiKeyEdit);
    document.getElementById("aiKeyChangeBtn")?.addEventListener("click", () => {
        // Scroll the aiKeySection into view
        document.getElementById("aiKeySection")?.scrollIntoView({ behavior: "smooth", block: "start" });
        handleApiKeyEdit();
    });
}

// ============================
// Authentication Handlers
// ============================
function toggleAuthForm(form) {
    const loginForm = document.getElementById("loginForm");
    const signupForm = document.getElementById("signupForm");
    if (form === "signup") {
        loginForm.style.display = "none";
        signupForm.style.display = "block";
    } else {
        signupForm.style.display = "none";
        loginForm.style.display = "block";
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const errorEl = document.getElementById("loginError");
    const btn = document.getElementById("loginBtn");

    if (!email || !password) { errorEl.textContent = "Please fill in all fields"; return; }
    if (!EMAIL_RE.test(email)) { errorEl.textContent = "Please enter a valid email address"; return; }

    errorEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Signing in…";

    try {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw data;

        await setToStorage({
            access_token: data.access_token,
            user_email: data.email,
            user_id: data.user_id,
            has_resume: data.has_resume,
            resume_filename: data.resume_filename || null,
            plan: data.plan,
            email_verified: data.email_verified,
            is_byok_allowed: data.is_byok_allowed ?? false,
            is_admin: data.is_admin ?? false,
            weekly_usage: data.weekly_usage,
            weekly_limit: data.weekly_limit,
            daily_usage: data.daily_usage,
            monthly_usage: data.monthly_usage,
        });
        currentUser = {
            email: data.email,
            has_resume: data.has_resume,
            resume_filename: data.resume_filename || null,
            plan: data.plan,
            email_verified: data.email_verified,
            is_byok_allowed: data.is_byok_allowed ?? false,
            is_admin: data.is_admin ?? false,
            weekly_usage: data.weekly_usage,
            weekly_limit: data.weekly_limit,
            daily_usage: data.daily_usage,
            monthly_usage: data.monthly_usage,
        };
        showMainApp();
    } catch (error) {
        errorEl.textContent = apiErrorMessage(error, "Login failed. Please try again.");
        btn.disabled = false;
        btn.textContent = "Sign In";
    }
}

async function handleForgotPassword(e) {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const errorEl = document.getElementById("loginError");
    if (!EMAIL_RE.test(email)) {
        errorEl.textContent = "Enter your email above, then click Forgot password.";
        return;
    }
    errorEl.textContent = "";
    try {
        const res = await fetch(`${API_BASE}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Could not send reset email.");
        showToast("If that account exists, a reset link is on its way.", "info");
    } catch (err) {
        errorEl.textContent = err.message || "Could not send reset email.";
    }
}

async function handleSignup(e) {
    e.preventDefault();
    const email = document.getElementById("signupEmail").value.trim();
    const password = document.getElementById("signupPassword").value;
    const fullName = document.getElementById("signupName").value.trim();
    const errorEl = document.getElementById("signupError");
    const btn = document.getElementById("signupBtn");

    if (!email || !password) { errorEl.textContent = "Email and password are required"; return; }
    if (!EMAIL_RE.test(email)) { errorEl.textContent = "Please enter a valid email address"; return; }
    if (password.length < 6) { errorEl.textContent = "Password must be at least 6 characters"; return; }

    errorEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Creating account…";

    try {
        const res = await fetch(`${API_BASE}/auth/signup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, full_name: fullName || null }),
        });
        const data = await res.json();
        if (!res.ok) throw data;

        await setToStorage({
            access_token: data.access_token,
            user_email: data.email,
            user_id: data.user_id,
            has_resume: data.has_resume,
            resume_filename: data.resume_filename || null,
            email_verified: data.email_verified,
            is_byok_allowed: data.is_byok_allowed ?? false,
            is_admin: data.is_admin ?? false,
            weekly_usage: data.weekly_usage,
            weekly_limit: data.weekly_limit,
            daily_usage: data.daily_usage,
            monthly_usage: data.monthly_usage,
        });
        currentUser = {
            email: data.email,
            has_resume: data.has_resume,
            resume_filename: data.resume_filename || null,
            email_verified: data.email_verified,
            is_byok_allowed: data.is_byok_allowed ?? false,
            is_admin: data.is_admin ?? false,
            weekly_usage: data.weekly_usage,
            weekly_limit: data.weekly_limit,
            daily_usage: data.daily_usage,
            monthly_usage: data.monthly_usage,
        };
        // Show verification-pending screen instead of main app
        showVerificationPendingScreen(data.email);
    } catch (error) {
        errorEl.textContent = apiErrorMessage(error, "Signup failed. Please try again.");
        btn.disabled = false;
        btn.textContent = "Create Account";
    }
}

async function handleLogout() {
    await clearSession();
    // Also clear the saved API key on logout
    await chrome.storage.local.remove(["ai_provider", "ai_api_key", "ai_model"]);
    await chrome.storage.local.clear();
    currentUser = null;
    showAuthScreen();
}

/**
 * Google OAuth flow — Chrome Extension type.
 * Uses chrome.identity.getAuthToken() to get an access token directly
 * (no code exchange, no client secret needed in the extension).
 * The backend verifies the token against Google's userinfo endpoint.
 */
async function handleGoogleLogin() {
    // Guard: ensure the Client ID has been configured in manifest.json
    const manifest  = chrome.runtime.getManifest();
    const clientId  = manifest.oauth2?.client_id;
    if (!clientId || clientId.startsWith("YOUR_")) {
        showAuthError("Google sign-in is not configured yet. Contact support.");
        return;
    }

    const btn = document.getElementById("googleLoginBtn") ||
                document.getElementById("googleSignupBtn");
    const googleBtnHTML = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.textContent = "Connecting…"; }

    try {
        // 1. Get an access token from Chrome's identity API
        const accessToken = await new Promise((resolve, reject) => {
            chrome.identity.getAuthToken({ interactive: true }, (token) => {
                if (chrome.runtime.lastError || !token) {
                    reject(new Error(chrome.runtime.lastError?.message || "OAuth cancelled"));
                } else {
                    resolve(token);
                }
            });
        });

        // 2. Send the access token to our backend — it verifies with Google
        const res = await fetch(`${API_BASE}/auth/google`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ access_token: accessToken }),
        });
        const data = await res.json();
        if (!res.ok) throw data;

        // 3. Store session exactly like a regular login
        await setToStorage({
            access_token:    data.access_token,
            user_email:      data.email,
            user_id:         data.user_id,
            has_resume:      data.has_resume,
            resume_filename: null,
            plan:            data.plan,
            email_verified:  data.email_verified,
            weekly_usage:    data.weekly_usage,
            weekly_limit:    data.weekly_limit,
            daily_usage:     data.daily_usage,
            monthly_usage:   data.monthly_usage,
        });
        currentUser = {
            email:          data.email,
            has_resume:     data.has_resume,
            resume_filename: null,
            email_verified: data.email_verified,
            plan:           data.plan,
            weekly_usage:   data.weekly_usage,
            weekly_limit:   data.weekly_limit,
            daily_usage:    data.daily_usage,
            monthly_usage:  data.monthly_usage,
        };
        showMainApp();
    } catch (err) {
        const msg = err?.detail || err?.message || String(err);
        showError(`Google sign-in failed: ${msg}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = googleBtnHTML;
        }
    }
}


// ============================
// AI Provider / BYOK Handlers
// ============================

/** Render the saved-key state vs. form state in the aiKeySection. */
async function renderKeyStatus() {
    const aiSection = document.getElementById("aiKeySection");
    const statusBar  = document.getElementById("aiKeyStatusBar");
    const chipEl     = document.getElementById("aiKeyChip");
    const chipText   = document.getElementById("aiKeyChipText");

    const isByokAllowed = !!currentUser?.is_byok_allowed;

    if (!isByokAllowed) {
        // Standard user: Server-managed AI active, hide custom key drawer
        if (aiSection) aiSection.style.display = "none";
        if (statusBar) statusBar.style.display = "flex";
        const changeBtn = document.getElementById("aiKeyChangeBtn");
        if (changeBtn) changeBtn.style.display = "none";
        if (chipEl) {
            chipEl.classList.remove("has-key");
            chipEl.classList.add("server-ai");
        }
        const planName = (currentUser?.plan || "free").toLowerCase();
        const used = currentUser?.weekly_usage ?? 0;
        const limit = currentUser?.weekly_limit ?? 5;
        if (chipText) {
            chipText.textContent = `Server AI, ${planName} plan, ${used} of ${limit} used this week`;
        }
        return;
    }

    // BYOK-entitled user: show custom key drawer & status
    if (aiSection) aiSection.style.display = "block";
    const changeBtn = document.getElementById("aiKeyChangeBtn");
    if (changeBtn) changeBtn.style.display = "";
    const stored = await getFromStorage(["ai_provider", "ai_api_key", "ai_model"]);
    const { ai_provider, ai_api_key, ai_model } = stored;

    const savedState = document.getElementById("aiKeySavedState");
    const formState  = document.getElementById("aiKeyFormState");
    const provText   = document.getElementById("aiKeyProviderText");
    const maskedText = document.getElementById("aiKeyMaskedText");

    const PROVIDER_LABELS = {
        openai: "OpenAI", anthropic: "Anthropic", google: "Google Gemini",
        groq: "Groq", openrouter: "OpenRouter",
    };

    if (ai_provider && ai_api_key) {
        const label = PROVIDER_LABELS[ai_provider] || ai_provider;
        const masked = ai_api_key.length > 8
            ? ai_api_key.slice(0, 4) + "…" + ai_api_key.slice(-4)
            : "****";

        if (savedState) savedState.style.display = "block";
        if (formState)  formState.style.display  = "none";
        if (provText)   provText.textContent  = label;
        if (maskedText) maskedText.textContent = masked;

        if (statusBar) statusBar.style.display = "flex";
        if (chipEl) {
            chipEl.classList.remove("server-ai");
            chipEl.classList.add("has-key");
        }
        if (chipText)  chipText.textContent = `Your key: ${label}, ${masked}`;
    } else {
        if (savedState) savedState.style.display = "none";
        if (formState)  formState.style.display  = "block";

        if (statusBar) statusBar.style.display = "flex";
        if (chipEl) {
            chipEl.classList.remove("server-ai");
            chipEl.classList.remove("has-key");
        }
        if (chipText)  chipText.textContent = "Your key: not set";
    }
}


async function handleSaveApiKey() {
    const provider = document.getElementById("providerSelect")?.value?.trim();
    const apiKey   = document.getElementById("apiKeyInput")?.value?.trim();
    const model    = document.getElementById("modelInput")?.value?.trim() || null;
    const errEl    = document.getElementById("aiKeyError");
    const succEl   = document.getElementById("aiKeySuccess");

    if (errEl)  errEl.textContent = "";
    if (succEl) { succEl.style.display = "none"; succEl.textContent = ""; }

    if (!provider) { if (errEl) errEl.textContent = "Please select a provider."; return; }
    if (!apiKey || apiKey.length < 8) {
        if (errEl) errEl.textContent = "Please enter a valid API key (at least 8 characters).";
        return;
    }

    await setToStorage({ ai_provider: provider, ai_api_key: apiKey, ai_model: model || null });
    if (succEl) { succEl.textContent = "Key saved."; succEl.style.display = "block"; }
    setTimeout(() => { if (succEl) succEl.style.display = "none"; }, 2000);
    await renderKeyStatus();
}

async function handleTestApiKey() {
    const provider = document.getElementById("providerSelect")?.value?.trim();
    const apiKey   = document.getElementById("apiKeyInput")?.value?.trim();
    const model    = document.getElementById("modelInput")?.value?.trim() || null;
    const errEl    = document.getElementById("aiKeyError");
    const succEl   = document.getElementById("aiKeySuccess");
    const testBtn  = document.getElementById("aiKeyTestBtn");

    if (errEl)  errEl.textContent = "";
    if (succEl) { succEl.style.display = "none"; succEl.textContent = ""; }

    if (!provider || !apiKey || apiKey.length < 8) {
        if (errEl) errEl.textContent = "Please fill in provider and API key before testing.";
        return;
    }

    if (testBtn) { testBtn.disabled = true; testBtn.textContent = "Testing…"; }

    try {
        const stored = await getFromStorage(["access_token"]);
        const res = await fetch(`${API_BASE}/validate-key`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${stored.access_token}`,
            },
            body: JSON.stringify({ provider, api_key: apiKey, model: model || null }),
        });
        const data = await res.json();
        if (!res.ok) throw data;
        if (succEl) {
            succEl.textContent = `Connection successful. Using ${data.provider}, model ${data.model}.`;
            succEl.style.display = "block";
        }
    } catch (err) {
        const msg = err?.detail || err?.message || String(err);
        if (errEl) errEl.textContent = `Connection failed: ${msg}`;
    } finally {
        if (testBtn) { testBtn.disabled = false; testBtn.textContent = "Test connection"; }
    }
}

async function handleApiKeyToggleVisibility() {
    const input = document.getElementById("apiKeyInput");
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
}

async function handleApiKeyEdit() {
    const savedState = document.getElementById("aiKeySavedState");
    const formState  = document.getElementById("aiKeyFormState");
    // Pre-fill form with stored values
    const stored = await getFromStorage(["ai_provider", "ai_api_key", "ai_model"]);
    if (stored.ai_provider) {
        const sel = document.getElementById("providerSelect");
        if (sel) sel.value = stored.ai_provider;
    }
    if (stored.ai_api_key) {
        const inp = document.getElementById("apiKeyInput");
        if (inp) inp.value = stored.ai_api_key;
    }
    if (stored.ai_model) {
        const mInp = document.getElementById("modelInput");
        if (mInp) mInp.value = stored.ai_model;
    }
    if (savedState) savedState.style.display = "none";
    if (formState)  formState.style.display  = "block";
}


// ============================
// Resume Upload
// ============================
function updateResumeUI(hasResume, filename) {
    const noState = document.getElementById("noResumeState");
    const hasState = document.getElementById("hasResumeState");
    const nameEl = document.getElementById("resumeFilenameText");

    if (hasResume) {
        noState.style.display = "none";
        hasState.style.display = "block";
        if (nameEl) nameEl.textContent = filename || "resume.pdf";
    } else {
        noState.style.display = "block";
        hasState.style.display = "none";
    }
}

async function handleResumeUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";

    const errorEl = document.getElementById("uploadError");
    const errorEl2 = document.getElementById("uploadError2");
    [errorEl, errorEl2].forEach((el) => { if (el) el.textContent = ""; });

    const isPdf  = file.type === "application/pdf";
    const isDocx = file.name.toLowerCase().endsWith(".docx");
    if (!isPdf && !isDocx) {
        (errorEl || errorEl2).textContent = "Only PDF or DOCX files are supported.";
        return;
    }
    if (file.size > 2 * 1024 * 1024) {
        (errorEl || errorEl2).textContent = "File must be smaller than 2 MB.";
        return;
    }

    // Show uploading state immediately
    showUploadingState(true, file.name);

    // Check that an API key is configured — gate before upload only if user has BYOK entitlement
    const storedKey = await getFromStorage(["ai_provider", "ai_api_key"]);
    if (currentUser?.is_byok_allowed && (!storedKey.ai_provider || !storedKey.ai_api_key)) {
        showUploadingState(false);

        // Show inline error under the upload button
        const errEl = document.getElementById("uploadError") || document.getElementById("uploadError2");
        if (errEl) errEl.textContent = "Set up an AI provider key before uploading.";

        // Scroll to and briefly highlight the AI Provider section
        const aiSection = document.getElementById("aiKeySection");
        if (aiSection) {
            aiSection.scrollIntoView({ behavior: "smooth", block: "start" });
            flashSection(aiSection);
        }
        return;
    }


    // Convert PDF to base64 so it crosses the message boundary to the background worker
    const reader = new FileReader();
    reader.onload = async function (evt) {
        // btoa loop avoids call-stack overflow on large files
        const buf = evt.target.result;
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);

        // Fire-and-forget — background handles the actual POST
        chrome.runtime.sendMessage({
            type: "UPLOAD_RESUME",
            payload: {
                base64,
                filename: file.name,
                ai_provider: storedKey.ai_provider,
                ai_api_key:  storedKey.ai_api_key,
                ai_model:    storedKey.ai_model || null,
            },
        });

        // Poll storage every second so we catch the result if the popup is closed
        startUploadPoller();
    };
    reader.onerror = () => showUploadError("Could not read the file. Please try again.");
    reader.readAsArrayBuffer(file);
}

/** Show / hide the uploading spinner state.
 *  Works for both the initial-upload label (#uploadResumeLabel)
 *  and the "Change" label inside hasResumeState. */
function showUploadingState(on, filename) {
    const uploadLabel = document.getElementById("uploadResumeLabel");
    const hasResumeVisible = document.getElementById("hasResumeState")?.style.display !== "none";
    // In "has resume" state the Change button is a label inside #hasResumeState
    const changeLabel = document.querySelector("#hasResumeState label[for='resumeFileInput']");
    const targetLabel = hasResumeVisible ? (changeLabel || uploadLabel) : (uploadLabel || changeLabel);
    if (!targetLabel) return;

    if (on) {
        targetLabel._originalHTML = targetLabel._originalHTML || targetLabel.innerHTML;
        targetLabel.innerHTML =
            SPINNER +
            (filename ? `Uploading \u201c${escapeHtml(filename)}\u201d\u2026` : "Uploading\u2026");
        targetLabel.setAttribute("aria-busy", "true");
        targetLabel.style.pointerEvents = "none";
    } else {
        // Restore whichever label(s) were mutated
        [uploadLabel, changeLabel].forEach(el => {
            if (el && el._originalHTML) {
                el.innerHTML = el._originalHTML;
                el._originalHTML = null;
                el.removeAttribute("aria-busy");
                el.style.pointerEvents = "";
            }
        });
    }
}

function showUploadError(msg) {
    showUploadingState(false);
    // Toast is always visible regardless of scroll position or resume state
    showToast(msg, "error");
    // Also persist in the inline error div for reference
    const el = document.getElementById("uploadError2") || document.getElementById("uploadError");
    if (el) el.textContent = msg;
}


function handleUploadDone(filename) {
    showUploadingState(false);
    setToStorage({ upload_status: null }).catch(() => { });
    currentUser = { ...currentUser, has_resume: true, resume_filename: filename };
    updateResumeUI(true, filename);
}

function handleUploadError(msg) {
    showUploadError(apiErrorMessage({ detail: msg }, "Upload failed. Please try again."));
    setToStorage({ upload_status: null }).catch(() => { });
}


// ============================
// Event Handlers
// ============================
function handleLandingClick() {
    chrome.tabs.create({ url: DASHBOARD_URL });
}

function handleJobDescriptionInputChange() {
    const textarea = document.getElementById("jobDescriptionInput");
    const addJobBtn = document.getElementById("addJobBtn");
    addJobBtn.disabled = textarea.value.trim().length === 0;
}

async function handleAddJobClick() {
    const textarea = document.getElementById("jobDescriptionInput");
    const inputText = textarea.value.trim();

    if (!inputText) { showAuthError("Please paste a job description first."); return; }
    if (inputText.length < 50) {
        showAuthError("Job description is too short. Please paste the full job posting.");
        return;
    }

    jobDescriptionFull = inputText;
    displayJobDescription();
    updateProgress(1);

    // Clear any stale optimization state from a previous JD
    await saveSession({
        session_jd: inputText,
        session_jd_cache_id: null,
        session_ats_score: null,
        session_optimized_score: null,
        session_improvements: null,
        session_optimized_yaml: null,
        optimization_status: null,
        optimization_error: null,
        session_progress: 1,
    });

    document.getElementById("analyzeBtn").disabled = false;
    textarea.value = "";
    document.querySelector(".input-section").style.display = "none";

    // Flash success label
    const addJobBtn = document.getElementById("addJobBtn");
    const originalText = addJobBtn.innerHTML;
    addJobBtn.innerHTML = icon("check") + "Added";
    addJobBtn.disabled = true;
    setTimeout(() => { addJobBtn.innerHTML = originalText; }, 2000);

    // Pre-parse the JD in the background (cache-warming — improves Analyze speed)
    sendToBackground({ type: "PARSE_JD", payload: { job_desc: inputText } }).catch(() => {
        // Silently ignore — cache miss will be handled at Analyze time
    });
}

function displayJobDescription() {
    const jobContainer = document.getElementById("jobContainer");
    const jobDescription = document.getElementById("jobDescription");
    jobDescription.textContent = jobDescriptionFull.substring(0, 200) + "...";
    jobContainer.style.display = "block";
    jobContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const homeBtn = document.getElementById("homeBtn");
    if (homeBtn) homeBtn.style.display = "inline-flex";
}

/**
 * Reset extension back to initial "Home" state:
 * clears loaded job description, optimization scores, changelog,
 * and resets progress so user can paste or fetch a new job description.
 */
async function handleResetToHome() {
    // 1. Clear in-memory state
    jobDescriptionFull = "";
    isExpanded = false;
    _pageJDCache = null;

    // 2. Stop running pollers & progress
    stopAnalyzePoller();
    stopResultPoller();
    TaskProgress.stop();

    // 3. Clear session storage (retaining user auth and preferences)
    await chrome.storage.local.remove([
        "session_jd", "session_jd_cache_id",
        "session_ats_score", "session_ats_breakdown",
        "session_optimized_score", "session_improvements",
        "session_optimized_yaml", "session_progress",
        "session_resume_changes", "session_explanation",
        "optimization_status", "optimization_error",
        "analyze_status", "analyze_error",
    ]);
    _cachedExplanation = null;

    // 4. Hide JD card, show input area again
    const jobContainer = document.getElementById("jobContainer");
    if (jobContainer) jobContainer.style.display = "none";

    const inputSection = document.querySelector(".input-section");
    if (inputSection) inputSection.style.display = "block";

    const jdInput = document.getElementById("jobDescriptionInput");
    if (jdInput) jdInput.value = "";

    // 5. Reset score displays & breakdown
    const origScore = document.getElementById("originalScore");
    if (origScore) origScore.textContent = "--";

    const optSection = document.getElementById("optimizedScoreSection");
    if (optSection) optSection.style.display = "none";
    document.querySelector(".main-content")?.classList.remove("has-proof");

    const atsBreakdown = document.getElementById("atsBreakdownCard");
    if (atsBreakdown) atsBreakdown.style.display = "none";

    const changelogPanel = document.getElementById("changelogPanel");
    if (changelogPanel) changelogPanel.style.display = "none";

    const banner = document.getElementById("downloadSuccessBanner");
    if (banner) banner.style.display = "none";

    // 6. Lock downstream buttons
    const analyzeBtn = document.getElementById("analyzeBtn");
    if (analyzeBtn) analyzeBtn.disabled = true;

    const generateBtn = document.getElementById("generateBtn");
    if (generateBtn) {
        generateBtn.disabled = true;
        setGenerateButtonRunning(false);
    }

    const previewBtn = document.getElementById("previewBtn");
    if (previewBtn) previewBtn.disabled = true;

    const downloadBtn = document.getElementById("downloadBtn");
    if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.style.display = "none";
    }

    const texBtnReset = document.getElementById("downloadTexBtn");
    if (texBtnReset) {
        texBtnReset.disabled = true;
        texBtnReset.style.display = "none";
    }

    const startOverBtn = document.getElementById("startOverBtn");
    if (startOverBtn) startOverBtn.style.display = "none";

    const explainBtn = document.getElementById("explainChangesBtn");
    if (explainBtn) explainBtn.style.display = "none";

    const expPanel = document.getElementById("explanationPanel");
    if (expPanel) expPanel.style.display = "none";

    const homeBtn = document.getElementById("homeBtn");
    if (homeBtn) homeBtn.style.display = "none";

    // 7. Reset progress steps
    resetProgress();

    // 8. Re-probe the page so the fetch bar comes back if still on a job listing
    probePageForJD();

    // 9. Scroll smoothly to top
    window.scrollTo({ top: 0, behavior: "smooth" });
    const mainContent = document.querySelector(".main-content");
    if (mainContent) mainContent.scrollTo({ top: 0, behavior: "smooth" });

    showToast("Ready for your next application.", "info");
}

/**
 * Remove the loaded job description and reset all downstream state.
 */
async function handleRemoveJobClick() {
    await handleResetToHome();
}

function handleReadMoreClick() {
    const jobDescription = document.getElementById("jobDescription");
    const readMoreBtn = document.getElementById("readMoreBtn");
    const fadeOverlay = document.getElementById("fadeOverlay");

    if (!isExpanded) {
        jobDescription.textContent = jobDescriptionFull;
        jobDescription.classList.add("expanded");
        readMoreBtn.textContent = "Show less";
        fadeOverlay.style.display = "none";
        isExpanded = true;
    } else {
        jobDescription.textContent = jobDescriptionFull.substring(0, 200) + "...";
        jobDescription.classList.remove("expanded");
        readMoreBtn.textContent = "Show full description";
        fadeOverlay.style.display = "block";
        isExpanded = false;
    }
}

// ============================
// API Integration  (via Background)
// ============================

/**
 * Analyze Step
 * Sends ANALYZE_ATS to the background worker and awaits the result.
 * The background handles the /calculate-ats-detailed request using the cached JD parse.
 */
async function handleAnalyzeClick() {
    const btn = document.getElementById("analyzeBtn");

    // Guard: resume must be uploaded before analysis can run
    if (!currentUser?.has_resume) {
        showError("Please upload your resume first before analyzing compatibility.");
        return;
    }

    // Guard: API key must be configured if user has BYOK entitlement
    const keyCheck = await getFromStorage(["ai_provider", "ai_api_key"]);
    if (currentUser?.is_byok_allowed && (!keyCheck.ai_provider || !keyCheck.ai_api_key)) {
        showError("Please set up your AI provider key first.");
        const aiSection = document.getElementById("aiKeySection");
        if (aiSection) {
            aiSection.scrollIntoView({ behavior: "smooth", block: "start" });
            flashSection(aiSection);
        }
        return;
    }

    btn.disabled = true;
    showLoadingState(btn, "Analyzing…");
    TaskProgress.start("Analyzing resume compatibility", 15_000);

    const { session_jd_cache_id } = await getFromStorage(["session_jd_cache_id"]);

    // Fire-and-forget — background writes result to storage
    chrome.runtime.sendMessage({
        type: "ANALYZE_ATS",
        payload: {
            job_desc: jobDescriptionFull,
            jd_cache_id: session_jd_cache_id || null,
        },
    });

    // Poll storage every second (catches result even if popup closes and reopens)
    startAnalyzePoller();
}


function handleAnalyzeDone(atsScore, breakdown) {
    TaskProgress.done();
    const btn = document.getElementById("analyzeBtn");
    if (btn) {
        btn.innerHTML = btn._origHTML ||
            icon("activity") + "Analyze compatibility";
        btn.disabled = false;
    }
    // Keep the plain fallback value in sync (used by optimise flow)
    const origEl = document.getElementById("originalScore");
    if (origEl) origEl.textContent = `${Math.round(atsScore)}%`;

    if (breakdown) {
        renderATSBreakdown(breakdown);
        saveSession({
            session_ats_score:     atsScore,
            session_ats_breakdown: JSON.stringify(breakdown),
            session_progress: 2,
            analyze_status: "done",
        }).catch(() => { });
    } else {
        saveSession({ session_ats_score: atsScore, session_progress: 2, analyze_status: "done" }).catch(() => { });
    }

    updateProgress(2);
    document.getElementById("generateBtn").disabled = false;
    setTimeout(() => {
        document.getElementById("atsBreakdownCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
}

// ==============================
// ATS Score Breakdown Renderer
// ==============================
function scoreLabel(v) {
    if (v >= 90) return "Excellent";
    if (v >= 75) return "Great";
    if (v >= 60) return "Good";
    if (v >= 45) return "Fair";
    return "Poor";
}

function handleATSToggle() {
    const body = document.getElementById("atsBreakdownBody");
    const btn = document.getElementById("atsToggleBtn");
    const chevron = document.getElementById("atsChevron");
    if (!body || !btn || !chevron) return;

    const isOpen = body.style.display !== "none";
    body.style.display = isOpen ? "none" : "block";
    btn.setAttribute("aria-expanded", !isOpen);
    chevron.classList.toggle("open", !isOpen);
}

function renderATSBreakdown(data, prevScore) {
    const card = document.getElementById("atsBreakdownCard");
    if (!card) return;

    const overall = Math.round(data.overall_score ?? 0);
    const kw      = Math.round(data.keyword_analysis?.keyword_density_score   ?? 0);
    const sk      = Math.round(data.skills_analysis?.skills_alignment_score   ?? 0);
    const fmt     = Math.round(data.formatting_score?.readability_score        ?? 0);
    const exp     = Math.round(data.experience_alignment?.experience_score     ?? 0);

    // Update summary row elements
    const summaryScore = document.getElementById("atsSummaryScore");
    if (summaryScore) summaryScore.textContent = overall + "%";

    const summaryBadge = document.getElementById("atsSummaryBadge");
    if (summaryBadge) {
        const level = data.match_level || scoreLabel(overall);
        summaryBadge.textContent = level;
        summaryBadge.className = "ats-match-badge ats-badge-" + level.toLowerCase();
    }

    // Gauge — circumference for r=40 is 2π*40 ≈ 251.3
    const CIRC = 251.3;
    const fill = (overall / 100) * CIRC;
    const gaugeEl = document.getElementById("atsGaugeFill");
    if (gaugeEl) {
        gaugeEl.style.strokeDasharray = `0 ${CIRC}`; // reset
        setTimeout(() => {
            gaugeEl.style.strokeDasharray = `${fill} ${CIRC}`;
        }, 80);
    }
    const gv = document.getElementById("atsGaugeValue");
    if (gv) gv.textContent = overall;

    // Improvement chip (only if prevScore provided)
    const chip = document.getElementById("atsImprovementChip");
    if (chip && prevScore != null && overall > prevScore) {
        chip.textContent = `+${overall - Math.round(prevScore)}% vs previous`;
        chip.style.display = "block";
    } else if (chip) {
        chip.style.display = "none";
    }

    // Sub-score bars
    const rows = [
        { bar: "atsBarKeyword", val: "atsValKeyword", lbl: "atsLblKeyword", score: kw,  cls: "keyword" },
        { bar: "atsBarSkills",  val: "atsValSkills",  lbl: "atsLblSkills",  score: sk,  cls: "skills"  },
        { bar: "atsBarFormat",  val: "atsValFormat",  lbl: "atsLblFormat",  score: fmt, cls: "format"  },
        { bar: "atsBarExp",     val: "atsValExp",     lbl: "atsLblExp",     score: exp, cls: "exp"     },
    ];
    rows.forEach(({ bar, val, lbl, score, cls }) => {
        const barEl = document.getElementById(bar);
        const valEl = document.getElementById(val);
        const lblEl = document.getElementById(lbl);
        if (barEl) { barEl.style.transform = "scaleX(0)"; setTimeout(() => { barEl.style.transform = `scaleX(${score / 100})`; }, 80); }
        if (valEl) valEl.textContent = score + "%";
        if (lblEl) { lblEl.textContent = scoreLabel(score); lblEl.className = `ats-sub-badge ats-badge-${scoreLabel(score).toLowerCase()}`; }
    });

    // AI Insight — pick the first critical improvement if any, else first strength
    const insightStrip = document.getElementById("atsInsightStrip");
    const insightText  = document.getElementById("atsInsightText");
    const insight = (data.critical_improvements?.[0]) || (data.strengths?.[0]) || null;
    if (insightStrip && insightText && insight) {
        insightText.textContent = insight;
        insightStrip.style.display = "flex";
    } else if (insightStrip) {
        insightStrip.style.display = "none";
    }

    card.style.display = "block";
}

function handleAnalyzeError(errMsg) {
    TaskProgress.stop();
    const btn = document.getElementById("analyzeBtn");
    if (btn) {
        btn.innerHTML = btn._origHTML ||
            icon("activity") + "Analyze compatibility";
        btn.disabled = false;
    }
    if (errMsg === "SESSION_EXPIRED") { handleLogout(); return; }
    showError("Error analyzing: " + errMsg);
}

/**
 * Generate Step
 * Fires OPTIMIZE_RESUME to the background worker (fire-and-forget).
 * The button is disabled and a spinner shown; the result arrives via
 * OPTIMIZE_DONE / OPTIMIZE_ERROR messages pushed by the worker.
 */
async function handleGenerateClick() {
    // Guard: API key must be configured if user has BYOK entitlement
    const keyCheck = await getFromStorage(["ai_provider", "ai_api_key"]);
    if (currentUser?.is_byok_allowed && (!keyCheck.ai_provider || !keyCheck.ai_api_key)) {
        showError("Please set up your AI provider key first.");
        const aiSection = document.getElementById("aiKeySection");
        if (aiSection) {
            aiSection.scrollIntoView({ behavior: "smooth", block: "start" });
            flashSection(aiSection);
        }
        return;
    }

    const { session_jd_cache_id, session_ats_score } =
        await getFromStorage(["session_jd_cache_id", "session_ats_score"]);

    setGenerateButtonRunning(true);
    await saveSession({ optimization_status: "running" });
    TaskProgress.start("Generating optimized resume", 40_000);

    const templateSelect = document.getElementById("templateSelect");
    const selectedTemplate = templateSelect ? templateSelect.value : "jakes_resume";
    await setToStorage({ selected_template: selectedTemplate });

    // Fire-and-forget — background manages the 30-second request
    chrome.runtime.sendMessage({
        type: "OPTIMIZE_RESUME",
        payload: {
            job_desc: jobDescriptionFull,
            jd_cache_id: session_jd_cache_id || null,
            original_ats_score: session_ats_score || null,
            template: selectedTemplate,
        },
    });

    // Start polling storage — catches the result whether or not the
    // OPTIMIZE_DONE push message arrives (MV3 service worker timing)
    startResultPoller();
}

function handleOptimizeDone(data) {
    stopResultPoller();          // idempotent — safe to call even if timer is null
    TaskProgress.done();
    setGenerateButtonRunning(false);

    const origScore = data.original_score ?? data.originalScore ?? 0;
    const optScore = data.optimized_score ?? data.optimizedScore ?? 0;
    const improvements = data.improvements_made || data.improvements || [];
    const changes = data.resume_changes || [];

    showOptimizedScoreSection({
        originalScore: origScore,
        optimizedScore: optScore,
        improvements,
    });

    // Render changelog
    renderChangelog(changes);

    // Update usage meter with fresh counts from the optimize response
    updateUsageMeter(
        data.daily_usage  ?? 0,
        data.monthly_usage ?? 0,
        data.weekly_usage  ?? 0,
        data.weekly_limit  ?? 5,
        data.plan          ?? currentUser?.plan ?? "free",
    );

    // Persist so the safety-net in restoreSession also finds YAML
    saveSession({
        optimization_status: "done",
        session_optimized_score: optScore,
        session_improvements: improvements,
        session_resume_changes: changes,
    }).catch(() => { });

    updateProgress(3);
    document.getElementById("previewBtn").style.display = "none";
    document.getElementById("downloadBtn").style.display = "inline-flex";
    document.getElementById("downloadBtn").disabled = false;
    const dlTex = document.getElementById("downloadTexBtn");
    if (dlTex) { dlTex.style.display = "inline-flex"; dlTex.disabled = false; }
    const startOver = document.getElementById("startOverBtn");
    if (startOver) { startOver.style.display = "inline-flex"; }
    const homeBtn = document.getElementById("homeBtn");
    if (homeBtn) { homeBtn.style.display = "inline-flex"; }
    const explainBtn = document.getElementById("explainChangesBtn");
    if (explainBtn) { explainBtn.style.display = "inline-flex"; }
    _cachedExplanation = null;
    updateProgress(5);

    setTimeout(() => {
        document.getElementById("optimizedScoreSection")?.scrollIntoView({
            behavior: "smooth",
            block: "start",
        });
    }, 200);

    // Refresh history panel silently with the new optimization
    loadHistory(false);
}

function handleOptimizeError(errMsg) {
    TaskProgress.stop();
    setGenerateButtonRunning(false);
    showError("Optimization failed: " + errMsg);
}

async function handlePreviewClick() {
    showToast("Preview is coming soon.", "info");
}

async function handleDownloadClick() {
    const btn = document.getElementById("downloadBtn");
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    showLoadingState(btn, "Generating PDF…");

    try {
        const { access_token, session_optimized_yaml } =
            await getFromStorage(["access_token", "session_optimized_yaml"]);

        if (!access_token) { await handleLogout(); return; }

        const templateSelect = document.getElementById("templateSelect");
        const template = templateSelect ? templateSelect.value : "jakes_resume";

        // Send the optimized YAML if available; backend falls back to base resume
        const body = JSON.stringify({
            resume_yaml: session_optimized_yaml || undefined,
            template: template,
            return_tex: false,
        });

        const res = await fetch(`${API_BASE}/generate-pdf`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${access_token}`,
            },
            body,
        });

        if (res.status === 401) { await handleLogout(); return; }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || "PDF generation failed.");
        }

        // Stream the blob and trigger a native Save dialog
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "optimized_resume.pdf";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Show post-download completion banner
        const banner = document.getElementById("downloadSuccessBanner");
        if (banner) {
            banner.style.display = "block";
            banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        showToast("PDF downloaded. Use Back to home when you are ready for the next job.", "success");

    } catch (err) {
        showError("Download failed: " + (err.message || String(err)));
    } finally {
        btn.innerHTML = originalHTML;
        btn.removeAttribute("aria-busy");
        btn.disabled = false;
    }
}


async function handleDownloadTexClick() {
    const btn = document.getElementById("downloadTexBtn");
    if (!btn) return;
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    showLoadingState(btn, "Generating .tex…");

    try {
        const { access_token, session_optimized_yaml } =
            await getFromStorage(["access_token", "session_optimized_yaml"]);

        if (!access_token) { await handleLogout(); return; }

        const templateSelect = document.getElementById("templateSelect");
        const template = templateSelect ? templateSelect.value : "jakes_resume";

        const body = JSON.stringify({
            resume_yaml: session_optimized_yaml || undefined,
            template: template,
            return_tex: true,
        });

        const res = await fetch(`${API_BASE}/generate-pdf`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${access_token}`,
            },
            body,
        });

        if (res.status === 401) { await handleLogout(); return; }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || "LaTeX export failed.");
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "optimized_resume.tex";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Show post-download completion banner
        const banner = document.getElementById("downloadSuccessBanner");
        if (banner) {
            banner.style.display = "block";
            banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        showToast(".tex file downloaded. Use Back to home when you are ready for the next job.", "success");

    } catch (err) {
        showError("LaTeX download failed: " + (err.message || String(err)));
    } finally {
        btn.innerHTML = originalHTML;
        btn.removeAttribute("aria-busy");
        btn.disabled = false;
    }
}


async function handleRecalculateClick() {
    if (!jobDescriptionFull) {
        showError("No job description loaded. Please add one first.");
        return;
    }
    await handleAnalyzeClick();
}

// ============================
// Usage Meter
// ============================

/**
 * Update the usage meter strip with the latest counts.
/**
 * @param {number} daily    - resumes generated today
 * @param {number} monthly  - resumes generated this calendar month
 * @param {number} weekly   - resumes generated this week (for limit display)
 * @param {number} limit    - weekly plan limit
 * @param {string} plan     - "free" | "pro"
 */
function updateUsageMeter(daily, monthly, weekly, limit, plan = "free") {
    const meter = document.getElementById("usageMeter");
    if (!meter) return;

    const todayEl   = document.getElementById("usageToday");
    const monthEl   = document.getElementById("usageMonth");
    const weeklyEl  = document.getElementById("usageWeekly");
    const limitEl   = document.getElementById("usageWeeklyLimit");
    const badgeEl   = document.getElementById("planBadge");
    const ctaBanner = document.getElementById("upgradeCta");

    if (todayEl)  todayEl.textContent = daily;
    if (monthEl)  monthEl.textContent = monthly;
    if (weeklyEl) weeklyEl.firstChild.textContent = weekly + " ";
    if (limitEl)  limitEl.textContent = `/ ${limit}`;

    // Plan badge
    if (badgeEl) {
        const isPro = (plan === "pro");
        badgeEl.textContent = isPro ? "Pro" : "Free";
        badgeEl.className   = isPro ? "plan-badge plan-badge--pro" : "plan-badge";
    }

    // Upgrade CTA — only for free users who have exhausted their weekly limit
    if (ctaBanner) {
        const limitHit = (plan !== "pro") && (weekly >= limit);
        ctaBanner.style.display = limitHit ? "flex" : "none";
        // Point upgrade link to the dashboard (opens in a new tab)
        const upgradeBtn = document.getElementById("upgradeCtaBtn");
        if (upgradeBtn) upgradeBtn.href = DASHBOARD_URL;
    }

    meter.style.display = "flex";
}

// ============================
// UI Helpers
// ============================

/** Toggle the Generate button between normal and "running" (spinner) states. */
function setGenerateButtonRunning(running) {
    const btn = document.getElementById("generateBtn");
    if (!btn) return;
    if (running) {
        showLoadingState(btn, "Generating, this takes about 30 seconds…");
        btn.disabled = true;
    } else {
        btn.innerHTML = icon("zap") + "Generate optimized resume";
        btn.disabled = false;
    }
}

function showError(msg) {
    // Try main app error slot first, then auth form error, then toast
    const mainEl = document.getElementById("uploadError2") || document.getElementById("uploadError");
    if (mainEl && document.getElementById("mainApp")?.style.display !== "none") {
        mainEl.textContent = msg;
        mainEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
        showAuthError(msg);
    }
}

/** Show a temporary toast notification at the top of the popup. */
function showToast(msg, type = "success") {
    const existing = document.getElementById("sculpt-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "sculpt-toast";
    toast.className = `toast toast--${["success", "error", "info"].includes(type) ? type : "info"}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

/** Show an error on the auth screen (uses whichever error div is visible). */
function showAuthError(msg) {
    // Pick the visible form's error div
    const loginForm  = document.getElementById("loginForm");
    const signupForm = document.getElementById("signupForm");
    const isSignup   = signupForm && signupForm.style.display !== "none";
    const errEl      = isSignup
        ? document.getElementById("signupError")
        : document.getElementById("loginError");

    if (errEl) {
        errEl.textContent = msg;
        errEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
        showToast(msg, "error");
    }
}

/* Counts a score from one value to another, for a short, restrained reading. Reduced motion lands on the value. */
function countScore(el, from, to, delay, duration) {
    const final = `${Math.round(to)}%`;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        el.textContent = final;
        return;
    }
    el.textContent = `${Math.round(from)}%`;
    let start = null;
    setTimeout(() => {
        const tick = (t) => {
            if (start === null) start = t;
            const p = Math.min(1, (t - start) / duration);
            el.textContent = `${Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)))}%`;
            if (p < 1) requestAnimationFrame(tick);
            else el.textContent = final;
        };
        requestAnimationFrame(tick);
    }, delay);
}

function showOptimizedScoreSection({ originalScore, optimizedScore, improvements }) {
    const originalScoreDisplay = document.getElementById("originalScoreDisplay");
    const optimizedScoreDisplay = document.getElementById("optimizedScore");
    const improvementTextEl = document.getElementById("improvementText");

    originalScoreDisplay.textContent = `${Math.round(originalScore)}%`;
    optimizedScoreDisplay.textContent = `${Math.round(optimizedScore)}%`;

    const improvement = Math.round(optimizedScore - originalScore);
    if (improvement > 0) {
        improvementTextEl.textContent = `+${improvement}% match`;
        improvementTextEl.className = "improvement-text positive";
    } else if (improvement === 0) {
        improvementTextEl.textContent = "Score maintained";
        improvementTextEl.className = "improvement-text neutral";
    } else {
        improvementTextEl.textContent = `Score decreased by ${Math.abs(improvement)}%`;
        improvementTextEl.className = "improvement-text negative";
    }

    const section = document.getElementById("optimizedScoreSection");
    section.style.display = "block";

    // Measure both scores on one 0 to 100 scale, and let the proof lead the work area
    const onScale = (v) => Math.max(0, Math.min(100, Math.round(v)));
    section.style.setProperty("--was", onScale(originalScore) / 100);
    section.style.setProperty("--now", onScale(optimizedScore) / 100);
    const rulerWas = document.getElementById("rulerWas");
    const rulerNow = document.getElementById("rulerNow");
    if (rulerWas) rulerWas.textContent = onScale(originalScore);
    if (rulerNow) rulerNow.textContent = onScale(optimizedScore);
    document.querySelector(".main-content")?.classList.add("has-proof");

    // Play the reveal: the ruler guides draw, the new score counts up from the original
    section.classList.remove("score-reveal");
    void section.offsetWidth;
    section.classList.add("score-reveal");
    countScore(optimizedScoreDisplay, originalScore, optimizedScore, 450, 900);

    setTimeout(() => {
        section.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 100);
}

function resetProgress() {
    for (let i = 1; i <= 5; i++) {
        const stepIcon = document.getElementById(`step${i}`);
        if (stepIcon) {
            const stepItem = stepIcon.parentElement;
            stepIcon.classList.remove("completed");
            stepIcon.classList.add("pending");
            stepIcon.innerHTML = `${i}`;
            stepItem.classList.remove("completed");
        }
    }
}

function updateProgress(step) {
    for (let i = 1; i <= step; i++) {
        const stepIcon = document.getElementById(`step${i}`);
        if (stepIcon) {
            const stepItem = stepIcon.parentElement;
            stepIcon.classList.remove("pending");
            stepIcon.classList.add("completed");
            stepIcon.innerHTML = icon("check");
            stepItem.classList.add("completed");
        }
    }
}


function showLoadingState(button, loadingText) {
    button.setAttribute("aria-busy", "true");
    button.innerHTML = `${SPINNER}${loadingText}`;
}

// ============================
// Fetch JD from Active Page
// ============================

/**
 * _Stored_ extracted text from the page so handleFetchFromPageClick
 * doesn't need to re-query the background.
 */
let _pageJDCache = null;

/**
 * Called automatically when the main app is shown.
 * Silently probes the active tab and reveals the fetch bar if a JD is found.
 */
async function probePageForJD() {
    // Don't show the bar if a JD is already loaded in this session
    const { session_jd } = await getFromStorage(["session_jd"]);
    if (session_jd) return;

    const bar = document.getElementById("fetchFromPageBar");
    const label = document.getElementById("fetchBarLabel");
    const fetchBtn = document.getElementById("fetchFromPageBtn");
    if (!bar || !label || !fetchBtn) return;

    // Hide bar immediately — reveal only once we confirm a JD is found (fixes flash)
    bar.style.display = "none";
    label.textContent = "Detecting job description…";
    fetchBtn.disabled = true;

    try {
        const result = await sendToBackground({ type: "FETCH_JD", payload: {} });
        if (result?.text) {
            _pageJDCache = result.text;
            // Truncate label to ~50 chars for display
            const preview = result.text.replace(/\s+/g, " ").trim().slice(0, 50);
            label.textContent = `Found on ${result.source}: "${preview}…"`;
            bar.style.display = "flex";
            fetchBtn.disabled = false;
        }
        // Nothing found — bar stays hidden
    } catch (_) {
        // Could not access tab (e.g. chrome:// page) — keep bar hidden
    }
}

/**
 * User clicks "Use from Page" — pre-fills the textarea and submits.
 */
async function handleFetchFromPageClick() {
    const fetchBtn = document.getElementById("fetchFromPageBtn");
    if (!fetchBtn) return;

    let jdText = _pageJDCache;

    // If cache is stale / missing, re-fetch from background
    if (!jdText) {
        fetchBtn.disabled = true;
        fetchBtn.textContent = "Fetching…";
        try {
            const result = await sendToBackground({ type: "FETCH_JD", payload: {} });
            jdText = result?.text;
        } catch (err) {
            fetchBtn.disabled = false;
            fetchBtn.textContent = "Use from page";
            showError("Could not fetch job description: " + (err?.message || String(err)));
            return;
        }
    }

    if (!jdText) {
        showError("No job description found on this page.");
        fetchBtn.disabled = false;
        return;
    }

    // Stuff the textarea and trigger the normal Add Job flow
    const textarea = document.getElementById("jobDescriptionInput");
    if (textarea) {
        textarea.value = jdText;
        // Trigger the same handler as "Add Job Description"
        await handleAddJobClick();
    }
}

// ============================
// Changelog / What Changed Panel
// ============================

/**
 * Renders the "What Changed" changelog panel from the backend diff data.
 * @param {Array<{severity: string, label: string, items: string[]|null}>} changes
 */
function renderChangelog(changes) {
    const panel = document.getElementById("changelogPanel");
    const list = document.getElementById("changelogList");
    const badge = document.getElementById("changelogBadge");
    const toggle = document.getElementById("changelogToggle");
    const body = document.getElementById("changelogBody");

    if (!panel || !list || !changes || changes.length === 0) return;

    list.innerHTML = "";

    let criticalCount = 0;

    for (const [index, change] of changes.entries()) {
        const { severity, label, items } = change;
        if (severity === "critical") criticalCount++;

        const li = document.createElement("li");
        li.className = `changelog-item ${severity}`;
        li.style.setProperty("--i", Math.min(index, 8));

        // Header row: dot + text
        const header = document.createElement("div");
        header.className = "changelog-item-header";

        const dot = document.createElement("span");
        dot.className = "changelog-dot";

        const text = document.createElement("span");
        text.className = "changelog-item-text";
        text.textContent = label;

        header.appendChild(dot);
        header.appendChild(text);
        li.appendChild(header);

        // Optional pill tags for item lists (e.g. skill names)
        if (items && items.length > 0) {
            const pills = document.createElement("div");
            pills.className = "changelog-pills";
            // Show max 8 pills to avoid overflow
            const visible = items.slice(0, 8);
            for (const item of visible) {
                const pill = document.createElement("span");
                pill.className = "changelog-pill";
                pill.textContent = item;
                pills.appendChild(pill);
            }
            if (items.length > 8) {
                const more = document.createElement("span");
                more.className = "changelog-pill";
                more.textContent = `+${items.length - 8} more`;
                pills.appendChild(more);
            }
            li.appendChild(pills);
        }

        list.appendChild(li);
    }

    // Show critical badge if needed
    if (criticalCount > 0) {
        badge.textContent = `${criticalCount} critical`;
        badge.style.display = "inline-block";
    } else {
        badge.style.display = "none";
    }

    panel.style.display = "block";

    // Auto-expand the body if there are critical items
    if (criticalCount > 0) {
        body.style.display = "block";
        toggle.classList.add("open");
    }
}

/** Toggle open/close of the changelog body. */
function handleChangelogToggle() {
    const body = document.getElementById("changelogBody");
    const toggle = document.getElementById("changelogToggle");
    if (!body || !toggle) return;

    const isOpen = body.style.display !== "none";
    body.style.display = isOpen ? "none" : "block";
    toggle.classList.toggle("open", !isOpen);
}

// ============================
// AI Change Explanations UI
// ============================

let _cachedExplanation = null;

async function handleExplainChangesClick() {
    const panel = document.getElementById("explanationPanel");
    const loading = document.getElementById("explanationLoading");
    const content = document.getElementById("explanationContent");
    if (!panel) return;

    // Toggle close if already open and content is visible
    if (panel.style.display !== "none" && content && content.style.display !== "none") {
        panel.style.display = "none";
        return;
    }

    panel.style.display = "block";

    if (_cachedExplanation) {
        renderExplanation(_cachedExplanation);
        return;
    }

    const { session_explanation, session_optimized_yaml, access_token } =
        await getFromStorage(["session_explanation", "session_optimized_yaml", "access_token"]);

    if (session_explanation) {
        _cachedExplanation = session_explanation;
        renderExplanation(session_explanation);
        return;
    }

    if (!session_optimized_yaml) {
        showError("Please optimize a resume first.");
        panel.style.display = "none";
        return;
    }

    loading.style.display = "flex";
    content.style.display = "none";

    try {
        const storedKey = await getFromStorage(["ai_provider", "ai_api_key", "ai_model", "is_byok_allowed"]);
        const aiConfig = storedKey.is_byok_allowed && storedKey.ai_provider && storedKey.ai_api_key ? {
            provider: storedKey.ai_provider,
            api_key: storedKey.ai_api_key,
            model: storedKey.ai_model || null,
        } : null;

        const res = await fetch(`${API_BASE}/explain-changes`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${access_token}`,
            },
            body: JSON.stringify({
                optimized_yaml: session_optimized_yaml,
                job_description: jobDescriptionFull || "",
                ai_config: aiConfig,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || "Failed to generate change explanation");
        }

        const data = await res.json();
        _cachedExplanation = data;
        await setToStorage({ session_explanation: data });
        renderExplanation(data);

    } catch (e) {
        loading.style.display = "none";
        showError("Could not explain changes: " + (e.message || String(e)));
        panel.style.display = "none";
    }
}

function renderExplanation(data) {
    const loading = document.getElementById("explanationLoading");
    const content = document.getElementById("explanationContent");
    if (!content) return;

    if (loading) loading.style.display = "none";
    content.style.display = "block";

    // 1. Summary
    const summaryBox = document.getElementById("expSummaryBox");
    const summaryText = document.getElementById("expSummaryText");
    if (data.summary_rationale) {
        summaryText.textContent = data.summary_rationale;
        summaryBox.style.display = "block";
    } else {
        summaryBox.style.display = "none";
    }

    // 2. Bullets
    const bulletsList = document.getElementById("expBulletsList");
    bulletsList.innerHTML = "";
    const enhancements = data.key_enhancements || [];
    if (enhancements.length > 0) {
        enhancements.forEach(item => {
            const card = document.createElement("div");
            card.className = "exp-card";

            const secTitle = document.createElement("div");
            secTitle.className = "exp-card__title";
            secTitle.textContent = item.section || "Role enhancement";
            card.appendChild(secTitle);

            if (item.original) {
                const origDiv = document.createElement("div");
                origDiv.className = "exp-card__old";
                const origText = document.createElement("span");
                origText.textContent = item.original;
                origDiv.appendChild(origText);
                card.appendChild(origDiv);
            }

            const optDiv = document.createElement("div");
            optDiv.className = "exp-card__new";
            const optText = document.createElement("span");
            optText.textContent = item.optimized;
            optDiv.appendChild(optText);
            card.appendChild(optDiv);

            if (item.reason) {
                const reasonDiv = document.createElement("div");
                reasonDiv.className = "exp-card__why";
                reasonDiv.textContent = item.reason;
                card.appendChild(reasonDiv);
            }

            bulletsList.appendChild(card);
        });
    } else {
        bulletsList.innerHTML = '<div class="exp-block__text">All bullets already align with the role.</div>';
    }

    // 3. Skills
    const skillsList = document.getElementById("expSkillsList");
    skillsList.innerHTML = "";
    (data.skills_strategy || []).forEach(strat => {
        const li = document.createElement("li");
        li.textContent = strat;
        skillsList.appendChild(li);
    });

    // 4. Preservation
    const presText = document.getElementById("expPreservationText");
    if (presText) {
        presText.textContent = data.preservation_notes || "Education, roles and factual history were kept as written.";
    }

    const panel = document.getElementById("explanationPanel");
    if (panel) {
        panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
}


// ============================
// Email Verification UI
// ============================

/**
 * Replace the auth screen with a "Check your inbox" panel.
 * Shown immediately after signup.
 */
function showVerificationPendingScreen(email) {
    const authScreen = document.getElementById("authScreen");
    if (!authScreen) return;

    authScreen.style.display = "block";
    document.getElementById("mainApp").style.display = "none";

    authScreen.innerHTML = `
      <div class="verify-screen">
        ${icon("mail")}
        <h2>Check your inbox</h2>
        <p>We sent a verification link to <strong>${escapeHtml(email)}</strong>. Open it to activate your account, then come back and sign in.</p>
        <button type="button" id="resendVerifyBtn" class="btn btn-primary">Resend email</button>
        <button type="button" id="backToLoginBtn" class="link-btn">Back to sign in</button>
      </div>`;

    document.getElementById("resendVerifyBtn")?.addEventListener("click", handleResendVerification);
    document.getElementById("backToLoginBtn")?.addEventListener("click", () => {
        // Clear the pending state and show the normal auth screen
        chrome.storage.local.clear();
        currentUser = null;
        location.reload();
    });
}

/**
 * Show a dismissible banner at the top of the main app for logged-in
 * but unverified users.
 */
function showUnverifiedBanner() {
    if (document.getElementById("unverifiedBanner")) return; // already shown

    const banner = document.createElement("div");
    banner.id = "unverifiedBanner";
    banner.className = "banner";
    banner.setAttribute("role", "status");
    banner.innerHTML = `
        <span class="banner__text">${icon("alert")}Verify your email to use all features.</span>
        <button type="button" id="resendVerifyBannerBtn" class="link-btn">Resend</button>`;

    const mainApp = document.getElementById("mainApp");
    if (mainApp) mainApp.prepend(banner);

    document.getElementById("resendVerifyBannerBtn")
        ?.addEventListener("click", handleResendVerification);
}

/** Call /auth/resend-verification and show feedback. */
async function handleResendVerification() {
    const btn = document.getElementById("resendVerifyBtn") ||
        document.getElementById("resendVerifyBannerBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }

    try {
        const { access_token } = await getFromStorage(["access_token"]);
        const res = await fetch(`${API_BASE}/auth/resend-verification`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${access_token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast(data.detail || "Could not resend email. Please try again.", "error");
        } else {
            showToast("Verification email sent. Check your inbox.", "success");
        }
    } catch {
        showToast("Network error. Please try again.", "error");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = btn.id === "resendVerifyBtn" ? "Resend email" : "Resend"; }
    }
}

// ============================
// History Panel Handlers
// ============================

async function handleHistoryToggle() {
    const body = document.getElementById("historyBody");
    const chevron = document.getElementById("historyChevron");
    const toggle = document.getElementById("historyToggle");
    const isExpanded = toggle.getAttribute("aria-expanded") === "true";

    if (isExpanded) {
        body.style.display = "none";
        chevron.style.transform = "rotate(0deg)";
        toggle.setAttribute("aria-expanded", "false");
    } else {
        body.style.display = "block";
        chevron.style.transform = "rotate(180deg)";
        toggle.setAttribute("aria-expanded", "true");
        // Load and render history on expand
        await loadHistory(true);
    }
}

async function loadHistory(showLoading = false) {
    const list = document.getElementById("historyList");
    const countBadge = document.getElementById("historyCount");
    const panel = document.getElementById("historyPanel");

    if (!list || !countBadge || !panel) return;

    if (showLoading) {
        list.innerHTML = `<div class="history-empty" role="status">Loading history…</div>`;
    }

    try {
        const { access_token } = await getFromStorage(["access_token"]);
        if (!access_token) return;

        const res = await fetch(`${API_BASE}/my-optimizations`, {
            headers: { "Authorization": `Bearer ${access_token}` },
        });

        if (!res.ok) throw new Error("Failed to fetch history");

        const history = await res.json();
        
        // Show panel if we have items
        if (history && history.length > 0) {
            panel.style.display = "block";
            countBadge.textContent = history.length;
            countBadge.style.display = "inline-flex";
            
            // Render items
            renderHistoryList(history);
        } else {
            panel.style.display = "none"; // Hide panel if no history
            countBadge.style.display = "none";
        }
    } catch (err) {
        if (list) {
            list.innerHTML = `<div class="history-error" role="alert">Could not load history. Reopen the panel to retry.</div>`;
        }
    }
}

function renderHistoryList(history) {
    const list = document.getElementById("historyList");
    if (!list) return;
    list.innerHTML = "";

    history.forEach(item => {
        const div = document.createElement("div");
        div.className = "history-item";
        
        // Calculate date format: e.g. May 28, 2026
        let dateStr = "";
        if (item.created_at) {
            try {
                const date = new Date(item.created_at);
                dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
            } catch (e) {
                dateStr = item.created_at;
            }
        }

        // Score improvement badge
        const diff = item.score_improvement || (item.optimized_ats_score - item.original_ats_score) || 0;
        const diffNum = Number(diff) || 0;
        const diffText = diffNum > 0 ? `+${diffNum}` : `${diffNum}`;
        const diffClass = diff > 0 ? "history-score-up" : "history-score-neutral";

        div.innerHTML = `
            <div class="history-item-details">
                <div class="history-item-title" title="${escapeHtml(item.job_title || 'Optimized resume')}">
                    ${escapeHtml(item.job_title || 'Optimized resume')}
                </div>
                <div class="history-item-meta">
                    <span class="history-item-date">${escapeHtml(dateStr)}</span>
                    <span class="history-item-scores">
                        <s>${Number(item.original_ats_score) || 0}%</s>
                        <strong>${Number(item.optimized_ats_score) || 0}%</strong>
                        <span class="history-score-badge ${diffClass}">${diffText} pts</span>
                    </span>
                </div>
            </div>
            <button type="button" class="history-download-btn" data-id="${escapeHtml(String(item.id))}" title="Download PDF" aria-label="Download PDF">
                ${icon("download")}
            </button>
        `;

        // Add event listener for download
        div.querySelector(".history-download-btn").addEventListener("click", async function(e) {
            e.stopPropagation();
            const recordId = this.getAttribute("data-id");
            await downloadHistoryPDF(recordId, this);
        });

        list.appendChild(div);
    });
}

async function downloadHistoryPDF(recordId, btnElement) {
    const originalHTML = btnElement.innerHTML;
    btnElement.disabled = true;
    
    // Show spinner/loading inside the small button
    btnElement.innerHTML = SPINNER;

    try {
        const { access_token } = await getFromStorage(["access_token"]);
        if (!access_token) return;

        const res = await fetch(`${API_BASE}/my-optimizations/${recordId}/pdf`, {
            headers: { "Authorization": `Bearer ${access_token}` },
        });

        if (!res.ok) throw new Error("Failed to download PDF");

        const blob = await res.blob();
        
        // Retrieve filename from content-disposition header if available
        let filename = "optimized_resume.pdf";
        const disposition = res.headers.get("content-disposition");
        if (disposition && disposition.indexOf("attachment") !== -1) {
            const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
            const matches = filenameRegex.exec(disposition);
            if (matches != null && matches[1]) {
                filename = matches[1].replace(/['"]/g, '');
            }
        }

        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showToast("Downloaded.", "success");
    } catch (err) {
        showToast("Failed to download PDF. Please try again.", "error");
    } finally {
        btnElement.disabled = false;
        btnElement.innerHTML = originalHTML;
    }
}

function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
