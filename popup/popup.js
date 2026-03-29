// ============================
// Global variables
// ============================
let jobDescriptionFull = "";
let isExpanded = false;
let currentUser = null;

// ============================
// Storage Helpers
// ============================
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
    ]);

    if (!s.session_jd) return; // Nothing saved yet

    // Restore job description
    jobDescriptionFull = s.session_jd;
    displayJobDescription();
    document.querySelector(".input-section").style.display = "none";
    updateProgress(1);

    // Restore ATS score
    if (s.session_ats_score != null) {
        document.getElementById("originalScore").textContent = `${Math.round(s.session_ats_score)}%`;
        document.getElementById("analyzeBtn").disabled = false;
        document.getElementById("generateBtn").disabled = false;
        updateProgress(2);
    } else {
        document.getElementById("analyzeBtn").disabled = false;
    }

    // Restore optimization result (or show "still running" state)
    if (s.optimization_status === "running") {
        // Popup reopened while background is still working — show spinner
        setGenerateButtonRunning(true);
    } else if (s.optimization_status === "error") {
        const errMsg = s.optimization_error || "Unknown error during optimization.";
        showError(`Optimization failed: ${errMsg}`);
        setGenerateButtonRunning(false);
    } else if (s.session_optimized_score != null) {
        showOptimizedScoreSection({
            originalScore:  s.session_ats_score,
            optimizedScore: s.session_optimized_score,
            improvements:   s.session_improvements || [],
        });
        updateProgress(5);
        document.getElementById("previewBtn").style.display = "none";
        document.getElementById("downloadBtn").style.display = "inline-flex";
        document.getElementById("downloadBtn").disabled = false;
    }
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

/** Listen for progress / result messages pushed by the background worker. */
function listenToBackground() {
    chrome.runtime.onMessage.addListener((message) => {
        switch (message.type) {
            case "OPTIMIZE_PROGRESS":
                // Currently only "started" — extend for granular steps later
                setGenerateButtonRunning(true);
                break;

            case "OPTIMIZE_DONE":
                handleOptimizeDone(message.payload);
                break;

            case "OPTIMIZE_ERROR":
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

    if (!email || !password) { errorEl.textContent = "Please fill in all fields"; return; }

    try {
        // Auth calls are short and safe to run directly from the popup
        const res = await fetch("http://localhost:8000/auth/login", {
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
        errorEl.textContent = error.detail || "Login failed. Please try again.";
    }
}

async function handleSignup(e) {
    e.preventDefault();
    const email    = document.getElementById("signupEmail").value.trim();
    const password = document.getElementById("signupPassword").value;
    const fullName = document.getElementById("signupName").value.trim();
    const errorEl  = document.getElementById("signupError");

    if (!email || !password) { errorEl.textContent = "Email and password are required"; return; }
    if (password.length < 6)  { errorEl.textContent = "Password must be at least 6 characters"; return; }

    try {
        const res = await fetch("http://localhost:8000/auth/signup", {
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
        errorEl.textContent = error.detail || "Signup failed. Please try again.";
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

    const label = document.getElementById("uploadResumeLabel");
    const originalLabelHTML = label ? label.innerHTML : "";
    if (label)
        label.innerHTML =
            '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="animation:pulse 1s infinite"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>Uploading...';

    try {
        const { access_token } = await getFromStorage(["access_token"]);
        if (!access_token) throw new Error("Not authenticated");

        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch("http://localhost:8000/upload-resume", {
            method: "POST",
            headers: { Authorization: `Bearer ${access_token}` },
            body: formData,
        });

        if (res.status === 401) { await handleLogout(); return; }
        const data = await res.json();
        if (!res.ok) throw data;

        await setToStorage({ has_resume: true, resume_filename: file.name });
        currentUser = { ...currentUser, has_resume: true, resume_filename: file.name };
        updateResumeUI(true, file.name);
    } catch (err) {
        const msg = err.detail || err.message || "Upload failed. Please try again.";
        if (errorEl)  errorEl.textContent  = msg;
        if (errorEl2) errorEl2.textContent = msg;
        if (label) label.innerHTML = originalLabelHTML;
    }
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
    const originalText = btn.innerHTML;
    btn.disabled = true;
    showLoadingState(btn, "Analyzing...");

    try {
        // Read cached JD parse ID (background warmed this when user added the JD)
        const { session_jd_cache_id } = await getFromStorage(["session_jd_cache_id"]);

        const data = await sendToBackground({
            type: "ANALYZE_ATS",
            payload: {
                job_desc:    jobDescriptionFull,
                jd_cache_id: session_jd_cache_id || null,
            },
        });

        const atsScore = data.overall_score;
        document.getElementById("originalScore").textContent = `${Math.round(atsScore)}%`;
        updateProgress(2);
        document.getElementById("generateBtn").disabled = false;

        // Persist score so it survives popup close + generate step can reuse it
        await saveSession({ session_ats_score: atsScore, session_progress: 2 });

        setTimeout(() => {
            document.getElementById("originalScore")?.scrollIntoView({
                behavior: "smooth",
                block: "center",
            });
        }, 100);
    } catch (error) {
        if (error?.message === "SESSION_EXPIRED") {
            await handleLogout();
            return;
        }
        showError("Error analyzing: " + (error?.detail || error?.message || JSON.stringify(error)));
    } finally {
        btn.innerHTML = originalText;
        btn.disabled  = false;
    }
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

    // Fire-and-forget — background manages the 30-second request
    chrome.runtime.sendMessage({
        type: "OPTIMIZE_RESUME",
        payload: {
            job_desc:           jobDescriptionFull,
            jd_cache_id:        session_jd_cache_id || null,
            original_ats_score: session_ats_score   || null,
        },
    });
    // sendResponse will be called with { started: true } — we don't need it here
}

function handleOptimizeDone(data) {
    setGenerateButtonRunning(false);

    showOptimizedScoreSection({
        originalScore:  data.original_score,
        optimizedScore: data.optimized_score,
        improvements:   data.improvements_made || [],
    });

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
    setGenerateButtonRunning(false);
    showError("Optimization failed: " + errMsg);
}

async function handlePreviewClick() {
    alert("Preview feature coming soon!");
}

async function handleDownloadClick() {
    const s = await getFromStorage(["session_optimized_yaml"]);
    if (!s.session_optimized_yaml) {
        alert("No optimized resume found. Please generate one first.");
        return;
    }

    const blob = new Blob([s.session_optimized_yaml], { type: "text/yaml" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "optimized_resume.yaml";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
