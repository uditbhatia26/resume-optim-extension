// ============================
// Global variables
// ============================
let jobDescriptionFull = "";
let isExpanded = false;
let currentUser = null;

// API base URL
const API_BASE = "http://localhost:8000"; // FastAPI backend

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
// Session Persistence
// Keys: session_jd, session_ats_score, session_optimized_score,
//       session_improvements, session_progress
// ============================
async function saveSession(patch) {
    await setToStorage(patch);
}

async function restoreSession() {
    const s = await getFromStorage([
        'session_jd', 'session_ats_score',
        'session_optimized_score', 'session_improvements', 'session_progress'
    ]);

    if (!s.session_jd) return; // Nothing saved yet

    // Restore job description
    jobDescriptionFull = s.session_jd;
    displayJobDescription();
    document.querySelector('.input-section').style.display = 'none';
    updateProgress(1);

    // Restore ATS score
    if (s.session_ats_score != null) {
        document.getElementById('originalScore').textContent = `${Math.round(s.session_ats_score)}%`;
        document.getElementById('analyzeBtn').disabled = false;
        document.getElementById('generateBtn').disabled = false;
        updateProgress(2);
    } else {
        document.getElementById('analyzeBtn').disabled = false;
    }

    // Restore optimization results
    if (s.session_optimized_score != null) {
        showOptimizedScoreSection({
            originalScore: s.session_ats_score,
            optimizedScore: s.session_optimized_score,
            improvements: s.session_improvements || []
        });
        updateProgress(5);
        document.getElementById('previewBtn').style.display = 'none';
        document.getElementById('downloadBtn').style.display = 'none';
    }
}

async function clearSession() {
    await chrome.storage.local.remove([
        'session_jd', 'session_ats_score',
        'session_optimized_score', 'session_improvements', 'session_progress'
    ]);
}

// ============================
// API Helpers
// ============================
async function postJSON(url, body, requiresAuth = true) {
    const headers = { "Content-Type": "application/json" };

    if (requiresAuth) {
        const { access_token } = await getFromStorage(['access_token']);
        if (!access_token) {
            throw new Error("Not authenticated");
        }
        headers["Authorization"] = `Bearer ${access_token}`;
    }

    const res = await fetch(`${API_BASE}${url}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    const data = await res.json();

    // Handle 401 - token expired or invalid
    if (res.status === 401) {
        await handleLogout();
        throw new Error("Session expired. Please login again.");
    }

    if (!res.ok) throw data;
    return data;
}

// ============================
// Initialize
// ============================
document.addEventListener("DOMContentLoaded", async function () {
    await checkAuthStatus();
    initializeEventListeners();
});

async function checkAuthStatus() {
    const { access_token, user_email, has_resume, resume_filename } = await getFromStorage(
        ['access_token', 'user_email', 'has_resume', 'resume_filename']
    );

    if (access_token) {
        currentUser = { email: user_email, has_resume: !!has_resume, resume_filename };
        showMainApp();
    } else {
        showAuthScreen();
    }
}

function showAuthScreen() {
    document.getElementById('authScreen').style.display = 'block';
    document.getElementById('mainApp').style.display = 'none';
    // Constrain popup height so it doesn't expand infinitely
    document.documentElement.style.height = '480px';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.height = '480px';
    document.body.style.overflow = 'hidden';
}

async function showMainApp() {
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'flex';

    // Force popup height — CSS alone is unreliable in Chrome extension popups
    document.documentElement.style.height = '480px';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.height = '480px';
    document.body.style.overflow = 'hidden';

    // Show user email
    const userEmailEl = document.getElementById('userEmail');
    if (userEmailEl && currentUser) {
        userEmailEl.textContent = currentUser.email;
    }

    // Show correct resume state
    updateResumeUI(currentUser?.has_resume, currentUser?.resume_filename);

    // Restore any saved session (JD, score, progress)
    await restoreSession();
}

function initializeEventListeners() {
    // Auth listeners
    const loginBtn = document.getElementById('loginBtn');
    const signupBtn = document.getElementById('signupBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const showSignupLink = document.getElementById('showSignup');
    const showLoginLink = document.getElementById('showLogin');

    if (loginBtn) loginBtn.addEventListener('click', handleLogin);
    if (signupBtn) signupBtn.addEventListener('click', handleSignup);
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    if (showSignupLink) showSignupLink.addEventListener('click', () => toggleAuthForm('signup'));
    if (showLoginLink) showLoginLink.addEventListener('click', () => toggleAuthForm('login'));

    // Header
    document.getElementById('landingBtn')?.addEventListener('click', handleLandingClick);

    // Resume upload
    document.getElementById('resumeFileInput')?.addEventListener('change', handleResumeUpload);

    // Actions
    document.getElementById('addJobBtn')?.addEventListener('click', handleAddJobClick);
    document.getElementById('readMoreBtn')?.addEventListener('click', handleReadMoreClick);
    document.getElementById('analyzeBtn')?.addEventListener('click', handleAnalyzeClick);
    document.getElementById('generateBtn')?.addEventListener('click', handleGenerateClick);
    document.getElementById('previewBtn')?.addEventListener('click', handlePreviewClick);
    document.getElementById('downloadBtn')?.addEventListener('click', handleDownloadClick);
    document.getElementById('recalculateBtn')?.addEventListener('click', handleRecalculateClick);

    // Textarea input
    const jobDescInput = document.getElementById('jobDescriptionInput');
    if (jobDescInput) jobDescInput.addEventListener('input', handleJobDescriptionInputChange);
}

// ============================
// Authentication Handlers
// ============================
function toggleAuthForm(form) {
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');

    if (form === 'signup') {
        loginForm.style.display = 'none';
        signupForm.style.display = 'block';
    } else {
        signupForm.style.display = 'none';
        loginForm.style.display = 'block';
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');

    if (!email || !password) {
        errorEl.textContent = "Please fill in all fields";
        return;
    }

    try {
        const data = await postJSON('/auth/login', { email, password }, false);

        // Store token and user info
        await setToStorage({
            access_token: data.access_token,
            user_email: data.email,
            user_id: data.user_id,
            has_resume: data.has_resume,
            resume_filename: null,
            plan: data.plan,
            weekly_usage: data.weekly_usage,
            weekly_limit: data.weekly_limit,
        });

        currentUser = { email: data.email, has_resume: data.has_resume, resume_filename: null };
        showMainApp();

    } catch (error) {
        errorEl.textContent = error.detail || "Login failed. Please try again.";
    }
}

async function handleSignup(e) {
    e.preventDefault();
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const fullName = document.getElementById('signupName').value.trim();
    const errorEl = document.getElementById('signupError');

    if (!email || !password) {
        errorEl.textContent = "Email and password are required";
        return;
    }

    if (password.length < 6) {
        errorEl.textContent = "Password must be at least 6 characters";
        return;
    }

    try {
        const data = await postJSON('/auth/signup', {
            email,
            password,
            full_name: fullName || null
        }, false);

        // Store token and user info
        await setToStorage({
            access_token: data.access_token,
            user_email: data.email,
            user_id: data.user_id,
            has_resume: data.has_resume,
            resume_filename: null,
            plan: data.plan,
            weekly_usage: data.weekly_usage,
            weekly_limit: data.weekly_limit,
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
    const noState = document.getElementById('noResumeState');
    const hasState = document.getElementById('hasResumeState');
    const nameEl = document.getElementById('resumeFilenameText');

    if (hasResume) {
        noState.style.display = 'none';
        hasState.style.display = 'block';
        if (nameEl) nameEl.textContent = filename || 'resume.pdf';
    } else {
        noState.style.display = 'block';
        hasState.style.display = 'none';
    }
}

async function handleResumeUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Reset input so same file can be re-selected later
    e.target.value = '';

    const errorEl = document.getElementById('uploadError');
    const errorEl2 = document.getElementById('uploadError2');
    [errorEl, errorEl2].forEach(el => { if (el) el.textContent = ''; });

    // Client-side validation
    if (file.type !== 'application/pdf') {
        (errorEl || errorEl2).textContent = 'Only PDF files are supported.';
        return;
    }
    if (file.size > 2 * 1024 * 1024) {
        (errorEl || errorEl2).textContent = 'File must be smaller than 2 MB.';
        return;
    }

    // Update label to show uploading state
    const label = document.getElementById('uploadResumeLabel');
    const originalLabelHTML = label ? label.innerHTML : '';
    if (label) label.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="animation:pulse 1s infinite"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>Uploading...';

    try {
        const { access_token } = await getFromStorage(['access_token']);
        if (!access_token) throw new Error('Not authenticated');

        const formData = new FormData();
        formData.append('file', file);

        const res = await fetch(`${API_BASE}/upload-resume`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${access_token}` },
            body: formData,
        });

        if (res.status === 401) { await handleLogout(); return; }

        const data = await res.json();
        if (!res.ok) throw data;

        // Persist to storage and update UI
        await setToStorage({ has_resume: true, resume_filename: file.name });
        currentUser = { ...currentUser, has_resume: true, resume_filename: file.name };
        updateResumeUI(true, file.name);

    } catch (err) {
        const msg = err.detail || err.message || 'Upload failed. Please try again.';
        if (errorEl) errorEl.textContent = msg;
        if (errorEl2) errorEl2.textContent = msg;
        if (label) label.innerHTML = originalLabelHTML;
    }
}

// ============================
// Event Handlers
// ============================
function handleLandingClick() {
    window.open('https://resumesculpt.com', '_blank');
}

function handleJobDescriptionInputChange() {
    const textarea = document.getElementById('jobDescriptionInput');
    const addJobBtn = document.getElementById('addJobBtn');
    addJobBtn.disabled = textarea.value.trim().length === 0;
}

function handleAddJobClick() {
    const textarea = document.getElementById('jobDescriptionInput');
    const inputText = textarea.value.trim();

    if (!inputText) {
        alert('Please paste a job description first');
        return;
    }
    if (inputText.length < 50) {
        alert('Job description seems too short. Please provide a more detailed one.');
        return;
    }

    jobDescriptionFull = inputText;
    displayJobDescription();
    updateProgress(1);

    // Persist to session storage
    saveSession({ session_jd: inputText, session_ats_score: null, session_optimized_score: null, session_progress: 1 });

    document.getElementById('analyzeBtn').disabled = false;

    textarea.value = '';
    document.querySelector('.input-section').style.display = 'none';

    const addJobBtn = document.getElementById('addJobBtn');
    const originalText = addJobBtn.innerHTML;
    addJobBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6L9 17l-5-5"/></svg>Added Successfully';
    addJobBtn.disabled = true;
    setTimeout(() => { addJobBtn.innerHTML = originalText; }, 2000);
}

function displayJobDescription() {
    const jobContainer = document.getElementById('jobContainer');
    const jobDescription = document.getElementById('jobDescription');
    jobDescription.textContent = jobDescriptionFull.substring(0, 200) + "...";
    jobContainer.style.display = 'block';
    jobContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function handleReadMoreClick() {
    const jobDescription = document.getElementById('jobDescription');
    const readMoreBtn = document.getElementById('readMoreBtn');
    const fadeOverlay = document.getElementById('fadeOverlay');

    if (!isExpanded) {
        jobDescription.textContent = jobDescriptionFull;
        jobDescription.classList.add('expanded');
        readMoreBtn.textContent = 'Show Less';
        fadeOverlay.style.display = 'none';
        isExpanded = true;
    } else {
        jobDescription.textContent = jobDescriptionFull.substring(0, 200) + "...";
        jobDescription.classList.remove('expanded');
        readMoreBtn.textContent = 'Show Full Description';
        fadeOverlay.style.display = 'block';
        isExpanded = false;
    }
}

// ============================
// API Integration
// ============================
async function handleAnalyzeClick() {
    const btn = document.getElementById('analyzeBtn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    showLoadingState(btn, 'Analyzing...');

    try {
        const data = await postJSON('/calculate-ats-detailed', {
            job_desc: jobDescriptionFull,
        });

        document.getElementById('originalScore').textContent = `${Math.round(data.overall_score)}%`;
        updateProgress(2);
        document.getElementById('generateBtn').disabled = false;

        // Persist ATS score so it survives popup close
        await saveSession({ session_ats_score: data.overall_score, session_progress: 2 });

        // Scroll to score card so user can see the result
        setTimeout(() => {
            document.getElementById('originalScore')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);

    } catch (error) {
        alert('Error analyzing: ' + (error.detail || error.message || JSON.stringify(error)));
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function handleGenerateClick() {
    const btn = document.getElementById('generateBtn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    showLoadingState(btn, 'Generating... (this takes ~30s)');

    try {
        const data = await postJSON('/optimize-resume', {
            job_desc: jobDescriptionFull,
        });

        // Show optimized score section with actual backend data
        const originalScore = data.original_score;
        const optimizedScore = data.optimized_score;
        showOptimizedScoreSection({ originalScore, optimizedScore, improvements: data.improvements_made });

        // Persist optimization results so they survive popup close
        await saveSession({
            session_optimized_score: optimizedScore,
            session_improvements: data.improvements_made || [],
            session_progress: 5,
        });

        updateProgress(3);
        // Preview/Download not yet supported — hide buttons to avoid confusing stubs
        document.getElementById('previewBtn').style.display = 'none';
        document.getElementById('downloadBtn').style.display = 'none';
        updateProgress(5); // Mark complete since download isn't available yet

        // Scroll to optimization results
        setTimeout(() => {
            document.getElementById('optimizedScoreSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 200);

    } catch (error) {
        alert('Error generating resume: ' + (error.detail || error.message || JSON.stringify(error)));
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function handlePreviewClick() {
    alert("Preview feature coming soon!");
}

async function handleDownloadClick() {
    alert("Download feature coming soon!");
}

async function handleRecalculateClick() {
    // Re-run analysis with the current job description
    if (!jobDescriptionFull) {
        alert("No job description loaded.");
        return;
    }
    await handleAnalyzeClick();
}

// ============================
// UI Helpers
// ============================
function showOptimizedScoreSection({ originalScore, optimizedScore, improvements }) {
    const originalScoreDisplay = document.getElementById('originalScoreDisplay');
    const optimizedScoreDisplay = document.getElementById('optimizedScore');
    const improvementTextEl = document.getElementById('improvementText');
    const improvementIndicator = document.getElementById('improvementIndicator');

    originalScoreDisplay.textContent = `${Math.round(originalScore)}%`;
    optimizedScoreDisplay.textContent = `${Math.round(optimizedScore)}%`;

    const improvement = Math.round(optimizedScore - originalScore);
    if (improvement > 0) {
        improvementTextEl.textContent = `Improved by ${improvement}%! 🎉`;
        improvementTextEl.className = 'improvement-text positive';
        improvementIndicator.style.background = 'rgba(0, 212, 170, 0.1)';
    } else if (improvement === 0) {
        improvementTextEl.textContent = 'Score maintained';
        improvementTextEl.className = 'improvement-text neutral';
        improvementIndicator.style.background = 'rgba(136, 146, 176, 0.1)';
    } else {
        improvementTextEl.textContent = `Score decreased by ${Math.abs(improvement)}%`;
        improvementTextEl.className = 'improvement-text negative';
        improvementIndicator.style.background = 'rgba(255, 107, 107, 0.1)';
    }

    document.getElementById('optimizedScoreSection').style.display = 'block';
    document.getElementById('optimizedScoreSection').style.animation = 'slideIn 0.5s ease-out';

    setTimeout(() => {
        document.getElementById('optimizedScoreSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
}

function updateProgress(step) {
    for (let i = 1; i <= step; i++) {
        const stepIcon = document.getElementById(`step${i}`);
        if (stepIcon) {
            const stepItem = stepIcon.parentElement;
            stepIcon.classList.remove('pending');
            stepIcon.classList.add('completed');
            stepIcon.innerHTML = '✓';
            stepItem.classList.add('completed');
        }
    }
}

function showLoadingState(button, loadingText) {
    const loadingIcon = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="animation: pulse 1s infinite;"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
    button.innerHTML = `${loadingIcon}${loadingText}`;
}
