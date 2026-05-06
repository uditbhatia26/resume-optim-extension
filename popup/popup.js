// ============================
// Global variables
// ============================
const API_BASE = "http://localhost:8000"; // ← swap to production URL before deploying
let jobDescriptionFull = "";
let isExpanded = false;
let currentUser = null;

// ============================
// Helpers
// ============================

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
        "session_ats_score", "session_optimized_score",
        "session_improvements", "session_progress",
        "session_optimized_yaml", "optimization_status", "optimization_error",
        "analyze_status", "analyze_error",
        "upload_status",  "upload_error",  "upload_filename",
        "session_resume_changes",
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
    document.querySelector(".input-section").style.display = "none";
    updateProgress(1);

    // ---- Restore analyze state ----
    if (s.analyze_status === "running") {
        const btn = document.getElementById("analyzeBtn");
        btn.disabled = true;
        showLoadingState(btn, "Analyzing...");
        TaskProgress.start("Analyzing resume compatibility", 15_000);
        startAnalyzePoller();
    } else if (s.analyze_status === "error") {
        showError("Analysis failed: " + (s.analyze_error || "Unknown error"));
        document.getElementById("analyzeBtn").disabled = false;
    } else if (s.session_ats_score != null) {
        document.getElementById("originalScore").textContent = `${Math.round(s.session_ats_score)}%`;
        document.getElementById("analyzeBtn").disabled = false;
        document.getElementById("generateBtn").disabled = false;
        updateProgress(2);
    } else {
        document.getElementById("analyzeBtn").disabled = false;
    }

    // ---- Restore optimization state ----
    if (s.optimization_status === "done" && s.session_optimized_score != null) {
        handleOptimizeDone({
            original_score:    s.session_ats_score  ?? 0,
            optimized_score:   s.session_optimized_score,
            improvements_made: s.session_improvements || [],
            resume_changes:    s.session_resume_changes || [],
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
    }
}


let _resultPollerTimer  = null;
let _uploadPollerTimer  = null;
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
        const s = await getFromStorage(["analyze_status", "analyze_error", "session_ats_score"]);
        if (s.analyze_status === "done" && s.session_ats_score != null) {
            clearInterval(_analyzePollerTimer); _analyzePollerTimer = null;
            handleAnalyzeDone(s.session_ats_score);
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
    console.log("[POLLER] Starting result poller");
    _resultPollerTimer = setInterval(async () => {
        const s = await getFromStorage([
            "optimization_status", "optimization_error",
            "session_optimized_score", "session_ats_score",
            "session_improvements",
        ]);
        console.log("[POLLER] tick:", JSON.stringify({
            status: s.optimization_status,
            score: s.session_optimized_score,
            ats: s.session_ats_score,
        }));

        if (s.optimization_status === "done" && s.session_optimized_score != null) {
            console.log("[POLLER] Detected DONE — calling handleOptimizeDone");
            clearInterval(_resultPollerTimer);
            _resultPollerTimer = null;
            handleOptimizeDone({
                original_score:   s.session_ats_score,
                optimized_score:  s.session_optimized_score,
                improvements_made: s.session_improvements || [],
            });
        } else if (s.optimization_status === "error") {
            console.log("[POLLER] Detected ERROR");
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
    _timer:    null,
    _start:    0,
    _duration: 0,
    _pct:      0,

    /**
     * Start the progress bar.
     * @param {string} label      - e.g. "Analyzing resume…"
     * @param {number} durationMs - expected total duration (ms). Bar reaches ~90% at this point.
     */
    start(label, durationMs) {
        this.stop();
        this._start    = Date.now();
        this._duration = durationMs;
        this._pct      = 0;

        const wrap  = document.getElementById("taskProgressWrap");
        const bar   = document.getElementById("taskProgressBar");
        const pctEl = document.getElementById("taskProgressPct");
        const lbl   = document.getElementById("taskProgressLabel");
        const eta   = document.getElementById("taskProgressEta");

        if (!wrap) return;
        wrap.style.display  = "block";
        lbl.textContent     = label;
        bar.style.width     = "0%";
        pctEl.textContent   = "0%";
        eta.textContent     = "";

        this._timer = setInterval(() => {
            const elapsed  = Date.now() - this._start;
            const ratio    = Math.min(elapsed / this._duration, 1);
            // Ease-out: fast start, slow near the end — caps at 90%
            const eased    = (1 - Math.pow(1 - ratio, 3)) * 90;
            this._pct      = Math.round(eased);

            bar.style.width   = `${this._pct}%`;
            pctEl.textContent = `${this._pct}%`;

            const remaining = Math.max(0, Math.round((this._duration - elapsed) / 1000));
            eta.textContent = remaining > 0 ? `~${remaining}s remaining` : "Almost done…";
        }, 400);
    },

    /** Snap to 100% and hide after a short delay. */
    done() {
        clearInterval(this._timer);
        this._timer = null;

        const bar   = document.getElementById("taskProgressBar");
        const pctEl = document.getElementById("taskProgressPct");
        const eta   = document.getElementById("taskProgressEta");
        const wrap  = document.getElementById("taskProgressWrap");

        if (!bar) return;
        bar.style.width   = "100%";
        pctEl.textContent = "100%";
        if (eta) eta.textContent = "Done!";

        setTimeout(() => {
            if (wrap) wrap.style.display = "none";
            if (bar)  bar.style.width    = "0%";
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
    const { access_token, user_email, has_resume, resume_filename } =
        await getFromStorage(["access_token", "user_email", "has_resume", "resume_filename"]);

    if (access_token) {
        currentUser = { email: user_email, has_resume: !!has_resume, resume_filename };
        showMainApp();
    } else {
        showAuthScreen();
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
                handleAnalyzeDone(message.payload.overall_score);
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
                console.log("[MSG] Received OPTIMIZE_DONE push", message.payload);
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
    document.documentElement.style.overflow = "hidden";
    document.body.style.height = "480px";
    document.body.style.overflow = "hidden";
}

async function showMainApp() {
    document.getElementById("authScreen").style.display = "none";
    document.getElementById("mainApp").style.display = "flex";
    document.documentElement.style.height = "480px";
    document.documentElement.style.overflow = "hidden";
    document.body.style.height = "480px";
    document.body.style.overflow = "hidden";

    const userEmailEl = document.getElementById("userEmail");
    if (userEmailEl && currentUser) userEmailEl.textContent = currentUser.email;

    updateResumeUI(currentUser?.has_resume, currentUser?.resume_filename);
    await restoreSession();

    // Show usage meter from stored auth data
    updateUsageMeter(
        currentUser?.daily_usage   ?? 0,
        currentUser?.monthly_usage ?? 0,
        currentUser?.weekly_usage  ?? 0,
        currentUser?.weekly_limit  ?? 5,
    );

    // Remind unverified users to check their inbox
    if (currentUser && !currentUser.email_verified) {
        showUnverifiedBanner();
    }

    // Auto-probe the active tab for a job description (non-blocking)
    probePageForJD();
}

function initializeEventListeners() {
    const loginBtn      = document.getElementById("loginBtn");
    const signupBtn     = document.getElementById("signupBtn");
    const logoutBtn     = document.getElementById("logoutBtn");
    const showSignupLink = document.getElementById("showSignup");
    const showLoginLink  = document.getElementById("showLogin");

    if (loginBtn)       loginBtn.addEventListener("click", handleLogin);
    if (signupBtn)      signupBtn.addEventListener("click", handleSignup);
    if (logoutBtn)      logoutBtn.addEventListener("click", handleLogout);
    if (showSignupLink) showSignupLink.addEventListener("click", () => toggleAuthForm("signup"));
    if (showLoginLink)  showLoginLink.addEventListener("click", () => toggleAuthForm("login"));

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
    document.getElementById("recalculateBtn")?.addEventListener("click", handleRecalculateClick);
    document.getElementById("changelogToggle")?.addEventListener("click", handleChangelogToggle);

    const jobDescInput = document.getElementById("jobDescriptionInput");
    if (jobDescInput) jobDescInput.addEventListener("input", handleJobDescriptionInputChange);
}

// ============================
// Authentication Handlers
// ============================
function toggleAuthForm(form) {
    const loginForm  = document.getElementById("loginForm");
    const signupForm = document.getElementById("signupForm");
    if (form === "signup") {
        loginForm.style.display  = "none";
        signupForm.style.display = "block";
    } else {
        signupForm.style.display = "none";
        loginForm.style.display  = "block";
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const email     = document.getElementById("loginEmail").value.trim();
    const password  = document.getElementById("loginPassword").value;
    const errorEl   = document.getElementById("loginError");
    const btn       = document.getElementById("loginBtn");

    if (!email || !password) { errorEl.textContent = "Please fill in all fields"; return; }

    errorEl.textContent = "";
    btn.disabled     = true;
    btn.textContent  = "Signing in…";

    try {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw data;

        await setToStorage({
            access_token:   data.access_token,
            user_email:     data.email,
            user_id:        data.user_id,
            has_resume:     data.has_resume,
            resume_filename: null,
            plan:           data.plan,
            email_verified: data.email_verified,
            weekly_usage:   data.weekly_usage,
            weekly_limit:   data.weekly_limit,
            daily_usage:    data.daily_usage,
            monthly_usage:  data.monthly_usage,
        });
        currentUser = {
            email:          data.email,
            has_resume:     data.has_resume,
            resume_filename: null,
            email_verified: data.email_verified,
            weekly_usage:   data.weekly_usage,
            weekly_limit:   data.weekly_limit,
            daily_usage:    data.daily_usage,
            monthly_usage:  data.monthly_usage,
        };
        showMainApp();
    } catch (error) {
        errorEl.textContent = apiErrorMessage(error, "Login failed. Please try again.");
        btn.disabled    = false;
        btn.textContent = "Sign In";
    }
}

async function handleSignup(e) {
    e.preventDefault();
    const email    = document.getElementById("signupEmail").value.trim();
    const password = document.getElementById("signupPassword").value;
    const fullName = document.getElementById("signupName").value.trim();
    const errorEl  = document.getElementById("signupError");
    const btn      = document.getElementById("signupBtn");

    if (!email || !password) { errorEl.textContent = "Email and password are required"; return; }
    if (password.length < 6)  { errorEl.textContent = "Password must be at least 6 characters"; return; }

    errorEl.textContent = "";
    btn.disabled    = true;
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
            access_token:   data.access_token,
            user_email:     data.email,
            user_id:        data.user_id,
            has_resume:     data.has_resume,
            resume_filename: null,
            plan:           data.plan,
            email_verified: data.email_verified,
            weekly_usage:   data.weekly_usage,
            weekly_limit:   data.weekly_limit,
            daily_usage:    data.daily_usage,
            monthly_usage:  data.monthly_usage,
        });
        currentUser = {
            email:          data.email,
            has_resume:     data.has_resume,
            resume_filename: null,
            email_verified: data.email_verified,
            weekly_usage:   data.weekly_usage,
            weekly_limit:   data.weekly_limit,
            daily_usage:    data.daily_usage,
            monthly_usage:  data.monthly_usage,
        };
        // Show verification-pending screen instead of main app
        showVerificationPendingScreen(data.email);
    } catch (error) {
        errorEl.textContent = apiErrorMessage(error, "Signup failed. Please try again.");
        btn.disabled    = false;
        btn.textContent = "Create Account";
    }
}

async function handleLogout() {
    await clearSession();
    await chrome.storage.local.clear();
    currentUser = null;
    showAuthScreen();
}

// ============================
// Resume Upload
// ============================
function updateResumeUI(hasResume, filename) {
    const noState  = document.getElementById("noResumeState");
    const hasState = document.getElementById("hasResumeState");
    const nameEl   = document.getElementById("resumeFilenameText");

    if (hasResume) {
        noState.style.display  = "none";
        hasState.style.display = "block";
        if (nameEl) nameEl.textContent = filename || "resume.pdf";
    } else {
        noState.style.display  = "block";
        hasState.style.display = "none";
    }
}

async function handleResumeUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";

    const errorEl  = document.getElementById("uploadError");
    const errorEl2 = document.getElementById("uploadError2");
    [errorEl, errorEl2].forEach((el) => { if (el) el.textContent = ""; });

    if (file.type !== "application/pdf") {
        (errorEl || errorEl2).textContent = "Only PDF files are supported.";
        return;
    }
    if (file.size > 2 * 1024 * 1024) {
        (errorEl || errorEl2).textContent = "File must be smaller than 2 MB.";
        return;
    }

    // Client-side size cap before wasting time on base64 conversion
    if (file.size > 3 * 1024 * 1024) {
        showUploadError("File must be smaller than 2 MB.");
        return;
    }

    // Show uploading state immediately
    showUploadingState(true, file.name);

    // Convert PDF to base64 so it crosses the message boundary to the background worker
    const reader = new FileReader();
    reader.onload = async function (evt) {
        // btoa loop avoids call-stack overflow on large files
        const buf    = evt.target.result;
        const bytes  = new Uint8Array(buf);
        let binary   = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);

        // Fire-and-forget — background handles the actual POST
        chrome.runtime.sendMessage({
            type: "UPLOAD_RESUME",
            payload: { base64, filename: file.name },
        });

        // Poll storage every second so we catch the result if the popup is closed
        startUploadPoller();
    };
    reader.onerror = () => showUploadError("Could not read the file. Please try again.");
    reader.readAsArrayBuffer(file);
}

/** Show / hide the uploading spinner state on the upload label. */
function showUploadingState(on, filename) {
    const label = document.getElementById("uploadResumeLabel");
    if (!label) return;
    if (on) {
        label._originalHTML = label._originalHTML || label.innerHTML;
        label.innerHTML =
            '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="animation:pulse 1s infinite"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' +
            (filename ? `Uploading ${filename}…` : "Uploading…");
    } else if (label._originalHTML) {
        label.innerHTML    = label._originalHTML;
        label._originalHTML = null;
    }
}

function showUploadError(msg) {
    showUploadingState(false);
    const el = document.getElementById("uploadError2") || document.getElementById("uploadError");
    if (el) el.textContent = msg;
}

function handleUploadDone(filename) {
    showUploadingState(false);
    setToStorage({ upload_status: null }).catch(() => {});
    currentUser = { ...currentUser, has_resume: true, resume_filename: filename };
    updateResumeUI(true, filename);
}

function handleUploadError(msg) {
    showUploadError(apiErrorMessage({ detail: msg }, "Upload failed. Please try again."));
    setToStorage({ upload_status: null }).catch(() => {});
}


// ============================
// Event Handlers
// ============================
function handleLandingClick() {
    window.open("https://resumesculpt.com", "_blank");
}

function handleJobDescriptionInputChange() {
    const textarea = document.getElementById("jobDescriptionInput");
    const addJobBtn = document.getElementById("addJobBtn");
    addJobBtn.disabled = textarea.value.trim().length === 0;
}

async function handleAddJobClick() {
    const textarea  = document.getElementById("jobDescriptionInput");
    const inputText = textarea.value.trim();

    if (!inputText) { alert("Please paste a job description first"); return; }
    if (inputText.length < 50) {
        alert("Job description seems too short. Please provide a more detailed one.");
        return;
    }

    jobDescriptionFull = inputText;
    displayJobDescription();
    updateProgress(1);

    // Clear any stale optimization state from a previous JD
    await saveSession({
        session_jd:             inputText,
        session_jd_cache_id:    null,
        session_ats_score:      null,
        session_optimized_score: null,
        session_improvements:   null,
        session_optimized_yaml: null,
        optimization_status:    null,
        optimization_error:     null,
        session_progress:       1,
    });

    document.getElementById("analyzeBtn").disabled = false;
    textarea.value = "";
    document.querySelector(".input-section").style.display = "none";

    // Flash success label
    const addJobBtn = document.getElementById("addJobBtn");
    const originalText = addJobBtn.innerHTML;
    addJobBtn.innerHTML =
        '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6L9 17l-5-5"/></svg>Added Successfully';
    addJobBtn.disabled = true;
    setTimeout(() => { addJobBtn.innerHTML = originalText; }, 2000);

    // Pre-parse the JD in the background (cache-warming — improves Analyze speed)
    sendToBackground({ type: "PARSE_JD", payload: { job_desc: inputText } }).catch(() => {
        // Silently ignore — cache miss will be handled at Analyze time
    });
}

function displayJobDescription() {
    const jobContainer   = document.getElementById("jobContainer");
    const jobDescription = document.getElementById("jobDescription");
    jobDescription.textContent = jobDescriptionFull.substring(0, 200) + "...";
    jobContainer.style.display = "block";
    jobContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * Remove the loaded job description and reset all downstream state.
 */
async function handleRemoveJobClick() {
    // Clear in-memory state
    jobDescriptionFull = "";
    isExpanded         = false;
    _pageJDCache       = null;

    // Clear persisted session
    await chrome.storage.local.remove([
        "session_jd",           "session_jd_cache_id",
        "session_ats_score",    "session_optimized_score",
        "session_improvements", "session_optimized_yaml",
        "session_progress",     "optimization_status",
        "optimization_error",   "analyze_status",
        "analyze_error",
    ]);

    // Hide JD card, show input area again
    document.getElementById("jobContainer").style.display      = "none";
    document.querySelector(".input-section").style.display      = "block";
    document.getElementById("jobDescriptionInput").value        = "";

    // Reset score display
    document.getElementById("originalScore").textContent = "--";

    // Lock downstream buttons
    document.getElementById("analyzeBtn").disabled  = true;
    document.getElementById("generateBtn").disabled = true;
    document.getElementById("previewBtn").disabled  = true;
    document.getElementById("downloadBtn").disabled = true;
    document.getElementById("downloadBtn").style.display = "none";

    // Hide optimized results section if visible
    const optSection = document.getElementById("optimizedScoreSection");
    if (optSection) optSection.style.display = "none";

    // Stop any running pollers
    stopAnalyzePoller();
    stopResultPoller();
    TaskProgress.stop();

    // Re-probe the page so the fetch bar comes back if still on a job listing
    probePageForJD();
}

function handleReadMoreClick() {
    const jobDescription = document.getElementById("jobDescription");
    const readMoreBtn    = document.getElementById("readMoreBtn");
    const fadeOverlay    = document.getElementById("fadeOverlay");

    if (!isExpanded) {
        jobDescription.textContent = jobDescriptionFull;
        jobDescription.classList.add("expanded");
        readMoreBtn.textContent    = "Show Less";
        fadeOverlay.style.display  = "none";
        isExpanded = true;
    } else {
        jobDescription.textContent = jobDescriptionFull.substring(0, 200) + "...";
        jobDescription.classList.remove("expanded");
        readMoreBtn.textContent    = "Show Full Description";
        fadeOverlay.style.display  = "block";
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
    btn.disabled = true;
    showLoadingState(btn, "Analyzing...");
    TaskProgress.start("Analyzing resume compatibility", 15_000);

    const { session_jd_cache_id } = await getFromStorage(["session_jd_cache_id"]);

    // Fire-and-forget — background writes result to storage
    chrome.runtime.sendMessage({
        type: "ANALYZE_ATS",
        payload: {
            job_desc:    jobDescriptionFull,
            jd_cache_id: session_jd_cache_id || null,
        },
    });

    // Poll storage every second (catches result even if popup closes and reopens)
    startAnalyzePoller();
}

function handleAnalyzeDone(atsScore) {
    TaskProgress.done();
    const btn = document.getElementById("analyzeBtn");
    if (btn) {
        btn.innerHTML = btn._origHTML ||
            '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>Analyze Compatibility';
        btn.disabled = false;
    }
    document.getElementById("originalScore").textContent = `${Math.round(atsScore)}%`;
    updateProgress(2);
    document.getElementById("generateBtn").disabled = false;
    saveSession({ session_ats_score: atsScore, session_progress: 2, analyze_status: "done" }).catch(() => {});
    setTimeout(() => {
        document.getElementById("originalScore")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
}

function handleAnalyzeError(errMsg) {
    TaskProgress.stop();
    const btn = document.getElementById("analyzeBtn");
    if (btn) {
        btn.innerHTML = btn._origHTML ||
            '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>Analyze Compatibility';
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
    const { session_jd_cache_id, session_ats_score } =
        await getFromStorage(["session_jd_cache_id", "session_ats_score"]);

    setGenerateButtonRunning(true);
    await saveSession({ optimization_status: "running" });
    TaskProgress.start("Generating optimized resume", 40_000);

    // Fire-and-forget — background manages the 30-second request
    chrome.runtime.sendMessage({
        type: "OPTIMIZE_RESUME",
        payload: {
            job_desc:           jobDescriptionFull,
            jd_cache_id:        session_jd_cache_id || null,
            original_ats_score: session_ats_score   || null,
        },
    });

    // Start polling storage — catches the result whether or not the
    // OPTIMIZE_DONE push message arrives (MV3 service worker timing)
    startResultPoller();
}

function handleOptimizeDone(data) {
    console.log("[handleOptimizeDone] called with:", JSON.stringify(data));
    stopResultPoller();          // idempotent — safe to call even if timer is null
    TaskProgress.done();
    setGenerateButtonRunning(false);

    const origScore = data.original_score  ?? data.originalScore  ?? 0;
    const optScore  = data.optimized_score ?? data.optimizedScore ?? 0;
    const improvements = data.improvements_made || data.improvements || [];
    const changes      = data.resume_changes || [];

    showOptimizedScoreSection({
        originalScore:  origScore,
        optimizedScore: optScore,
        improvements,
    });

    // Render changelog
    renderChangelog(changes);

    // Update usage meter with fresh counts from the optimize response
    updateUsageMeter(
        data.daily_usage   ?? 0,
        data.monthly_usage ?? 0,
        data.weekly_usage  ?? 0,
        data.weekly_limit  ?? 5,
    );

    // Persist so the safety-net in restoreSession also finds YAML
    saveSession({
        optimization_status:     "done",
        session_optimized_score: optScore,
        session_improvements:    improvements,
        session_resume_changes:  changes,
    }).catch(() => {});

    updateProgress(3);
    document.getElementById("previewBtn").style.display  = "none";
    document.getElementById("downloadBtn").style.display = "inline-flex";
    document.getElementById("downloadBtn").disabled      = false;
    updateProgress(5);

    setTimeout(() => {
        document.getElementById("optimizedScoreSection")?.scrollIntoView({
            behavior: "smooth",
            block: "start",
        });
    }, 200);
}

function handleOptimizeError(errMsg) {
    TaskProgress.stop();
    setGenerateButtonRunning(false);
    showError("Optimization failed: " + errMsg);
}

async function handlePreviewClick() {
    alert("Preview feature coming soon!");
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

        // Send the optimized YAML if available; backend falls back to base resume
        const body = session_optimized_yaml
            ? JSON.stringify({ resume_yaml: session_optimized_yaml })
            : "{}";

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
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href     = url;
        a.download = "optimized_resume.pdf";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    } catch (err) {
        showError("Download failed: " + (err.message || String(err)));
    } finally {
        btn.innerHTML = originalHTML;
        btn.disabled  = false;
    }
}


async function handleRecalculateClick() {
    if (!jobDescriptionFull) {
        alert("No job description loaded.");
        return;
    }
    await handleAnalyzeClick();
}

// ============================
// Usage Meter
// ============================

/**
 * Update the usage meter strip with the latest counts.
 * @param {number} daily    - resumes generated today
 * @param {number} monthly  - resumes generated this calendar month
 * @param {number} weekly   - resumes generated this week (for limit display)
 * @param {number} limit    - weekly plan limit
 */
function updateUsageMeter(daily, monthly, weekly, limit) {
    const meter = document.getElementById("usageMeter");
    if (!meter) return;

    const todayEl   = document.getElementById("usageToday");
    const monthEl   = document.getElementById("usageMonth");
    const weeklyEl  = document.getElementById("usageWeekly");
    const limitEl   = document.getElementById("usageWeeklyLimit");

    if (todayEl)  todayEl.textContent  = daily;
    if (monthEl)  monthEl.textContent  = monthly;
    if (weeklyEl) weeklyEl.firstChild.textContent = weekly + " ";
    if (limitEl)  limitEl.textContent  = `/ ${limit}`;

    meter.style.display = "flex";
}

// Coming Soon handler — button is disabled + badged, nothing to do
function handlePreviewClick() { /* coming soon */ }

// ============================
// UI Helpers
// ============================

/** Toggle the Generate button between normal and "running" (spinner) states. */
function setGenerateButtonRunning(running) {
    const btn = document.getElementById("generateBtn");
    if (!btn) return;
    if (running) {
        showLoadingState(btn, "Generating… (this takes ~30s)");
        btn.disabled = true;
    } else {
        btn.innerHTML =
            '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>Generate Optimized Resume';
        btn.disabled = false;
    }
}

function showError(msg) {
    // Reuse the upload error slot or fall back to alert
    const el = document.getElementById("uploadError2") || document.getElementById("uploadError");
    if (el) {
        el.textContent = msg;
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
        alert(msg);
    }
}

function showOptimizedScoreSection({ originalScore, optimizedScore, improvements }) {
    const originalScoreDisplay  = document.getElementById("originalScoreDisplay");
    const optimizedScoreDisplay = document.getElementById("optimizedScore");
    const improvementTextEl     = document.getElementById("improvementText");
    const improvementIndicator  = document.getElementById("improvementIndicator");

    originalScoreDisplay.textContent  = `${Math.round(originalScore)}%`;
    optimizedScoreDisplay.textContent = `${Math.round(optimizedScore)}%`;

    const improvement = Math.round(optimizedScore - originalScore);
    if (improvement > 0) {
        improvementTextEl.textContent = `Improved by ${improvement}%! 🎉`;
        improvementTextEl.className   = "improvement-text positive";
        improvementIndicator.style.background = "rgba(0, 212, 170, 0.1)";
    } else if (improvement === 0) {
        improvementTextEl.textContent = "Score maintained";
        improvementTextEl.className   = "improvement-text neutral";
        improvementIndicator.style.background = "rgba(136, 146, 176, 0.1)";
    } else {
        improvementTextEl.textContent = `Score decreased by ${Math.abs(improvement)}%`;
        improvementTextEl.className   = "improvement-text negative";
        improvementIndicator.style.background = "rgba(255, 107, 107, 0.1)";
    }

    const section = document.getElementById("optimizedScoreSection");
    section.style.display   = "block";
    section.style.animation = "slideIn 0.5s ease-out";

    setTimeout(() => {
        section.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 100);
}

function updateProgress(step) {
    for (let i = 1; i <= step; i++) {
        const stepIcon = document.getElementById(`step${i}`);
        if (stepIcon) {
            const stepItem = stepIcon.parentElement;
            stepIcon.classList.remove("pending");
            stepIcon.classList.add("completed");
            stepIcon.innerHTML = "✓";
            stepItem.classList.add("completed");
        }
    }
}


function showLoadingState(button, loadingText) {
    const loadingIcon =
        '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="animation: pulse 1s infinite;"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
    button.innerHTML = `${loadingIcon}${loadingText}`;
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

    const bar      = document.getElementById("fetchFromPageBar");
    const label    = document.getElementById("fetchBarLabel");
    const fetchBtn = document.getElementById("fetchFromPageBtn");
    if (!bar || !label || !fetchBtn) return;

    // Show bar in "detecting…" state
    bar.style.display = "flex";
    label.textContent = "Detecting job description…";
    fetchBtn.disabled = true;

    try {
        const result = await sendToBackground({ type: "FETCH_JD", payload: {} });
        if (result?.text) {
            _pageJDCache   = result.text;
            // Truncate label to ~50 chars for display
            const preview  = result.text.replace(/\s+/g, " ").trim().slice(0, 50);
            label.textContent = `Found on ${result.source}: "${preview}…"`;
            fetchBtn.disabled = false;
        } else {
            // Nothing found — hide the bar silently
            bar.style.display = "none";
        }
    } catch (_) {
        // Could not access tab (e.g. chrome:// page, extension page, etc.) — hide silently
        bar.style.display = "none";
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
            fetchBtn.textContent = "Use from Page";
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
    const panel  = document.getElementById("changelogPanel");
    const list   = document.getElementById("changelogList");
    const badge  = document.getElementById("changelogBadge");
    const toggle = document.getElementById("changelogToggle");
    const body   = document.getElementById("changelogBody");

    if (!panel || !list || !changes || changes.length === 0) return;

    list.innerHTML = "";

    let criticalCount = 0;

    for (const change of changes) {
        const { severity, label, items } = change;
        if (severity === "critical") criticalCount++;

        const li = document.createElement("li");
        li.className = `changelog-item ${severity}`;

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
        badge.textContent  = `${criticalCount} critical`;
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
    const body   = document.getElementById("changelogBody");
    const toggle = document.getElementById("changelogToggle");
    if (!body || !toggle) return;

    const isOpen = body.style.display !== "none";
    body.style.display = isOpen ? "none" : "block";
    toggle.classList.toggle("open", !isOpen);
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
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  height:100%;padding:32px 24px;text-align:center;gap:16px;">
        <div style="font-size:48px;">📬</div>
        <h2 style="color:#e2e8f0;margin:0;font-size:18px;font-weight:700;">
          Check your inbox
        </h2>
        <p style="color:#94a3b8;margin:0;line-height:1.6;font-size:13px;max-width:280px;">
          We've sent a verification link to<br>
          <strong style="color:#a78bfa;">${email}</strong>.<br><br>
          Click the link in the email to activate your account, then come back and sign in.
        </p>
        <button id="resendVerifyBtn"
                style="background:transparent;border:1px solid #6c63ff;color:#a78bfa;
                       border-radius:8px;padding:10px 24px;cursor:pointer;font-size:13px;
                       margin-top:8px;">
          Resend Email
        </button>
        <button id="backToLoginBtn"
                style="background:transparent;border:none;color:#64748b;
                       cursor:pointer;font-size:12px;text-decoration:underline;">
          Back to Sign In
        </button>
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
    banner.style.cssText = `
        background: linear-gradient(135deg, rgba(234,179,8,0.15), rgba(234,179,8,0.05));
        border: 1px solid rgba(234,179,8,0.3);
        border-radius: 8px;
        padding: 10px 14px;
        margin: 0 0 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-size: 12px;
        color: #fbbf24;
    `;
    banner.innerHTML = `
        <span>⚠️ Please verify your email to use all features.
          <button id="resendVerifyBannerBtn"
                  style="background:transparent;border:none;color:#a78bfa;
                         cursor:pointer;font-size:12px;text-decoration:underline;padding:0;">
            Resend
          </button>
        </span>`;

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
            alert(data.detail || "Could not resend email. Please try again.");
        } else {
            alert("✅ Verification email sent! Check your inbox.");
        }
    } catch {
        alert("Network error. Please try again.");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = btn.id === "resendVerifyBtn" ? "Resend Email" : "Resend"; }
    }
}
