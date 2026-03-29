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
    document.getElementById("readMoreBtn")?.addEventListener("click", handleReadMoreClick);
    document.getElementById("analyzeBtn")?.addEventListener("click", handleAnalyzeClick);
    document.getElementById("generateBtn")?.addEventListener("click", handleGenerateClick);
    document.getElementById("previewBtn")?.addEventListener("click", handlePreviewClick);
    document.getElementById("downloadBtn")?.addEventListener("click", handleDownloadClick);
    document.getElementById("recalculateBtn")?.addEventListener("click", handleRecalculateClick);

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
            access_token:  data.access_token,
            user_email:    data.email,
            user_id:       data.user_id,
            has_resume:    data.has_resume,
            resume_filename: null,
            plan:          data.plan,
            weekly_usage:  data.weekly_usage,
            weekly_limit:  data.weekly_limit,
        });
        currentUser = { email: data.email, has_resume: data.has_resume, resume_filename: null };
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
            access_token:  data.access_token,
            user_email:    data.email,
            user_id:       data.user_id,
            has_resume:    data.has_resume,
            resume_filename: null,
            plan:          data.plan,
            weekly_usage:  data.weekly_usage,
            weekly_limit:  data.weekly_limit,
        });
        currentUser = { email: data.email, has_resume: data.has_resume, resume_filename: null };
        showMainApp();
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
    const jobContainer  = document.getElementById("jobContainer");
    const jobDescription = document.getElementById("jobDescription");
    jobDescription.textContent = jobDescriptionFull.substring(0, 200) + "...";
    jobContainer.style.display = "block";
    jobContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
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

    showOptimizedScoreSection({
        originalScore:  origScore,
        optimizedScore: optScore,
        improvements,
    });

    // Persist so the safety-net in restoreSession also finds YAML
    saveSession({
        optimization_status:     "done",
        session_optimized_score: optScore,
        session_improvements:    improvements,
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
