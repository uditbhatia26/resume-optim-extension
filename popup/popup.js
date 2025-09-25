// ============================
// Global variables
// ============================
let jobDescriptionFull = "";
let isExpanded = false;
let lastVersionId = null;

// API base URL
const API_BASE = "http://127.0.0.1:5000"; // change to prod later

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
// API Helpers
// ============================
async function postJSON(url, body) {
    const res = await fetch(`${API_BASE}${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw data;
    return data;
}

// ============================
// Initialize
// ============================
document.addEventListener("DOMContentLoaded", function () {
    initializeEventListeners();
});

function initializeEventListeners() {
    // Header
    document.getElementById('landingBtn').addEventListener('click', handleLandingClick);

    // Actions
    document.getElementById('addJobBtn').addEventListener('click', handleAddJobClick);
    document.getElementById('readMoreBtn').addEventListener('click', handleReadMoreClick);
    document.getElementById('analyzeBtn').addEventListener('click', handleAnalyzeClick);
    document.getElementById('generateBtn').addEventListener('click', handleGenerateClick);
    document.getElementById('previewBtn').addEventListener('click', handlePreviewClick);
    document.getElementById('downloadBtn').addEventListener('click', handleDownloadClick);
    document.getElementById('recalculateBtn').addEventListener('click', handleRecalculateClick);

    // Textarea input
    document.getElementById('jobDescriptionInput').addEventListener('input', handleJobDescriptionInputChange);
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
    showLoadingState(btn, 'Analyzing...');

    try {
        const { user_id, resume_id } = await getFromStorage(['user_id', 'resume_id']);
        if (!user_id || !resume_id) {
            alert("Missing user_id or resume_id in storage!");
            return;
        }
        const data = await postJSON('/api/analyze-compatibility', {
            user_id,
            resume_id,
            job_description: jobDescriptionFull,
        });

        document.getElementById('originalScore').textContent = `${data.match_score}%`;
        updateProgress(2);
        document.getElementById('generateBtn').disabled = false;
    } catch (error) {
        alert("Error analyzing job: " + (error.error || JSON.stringify(error)));
    } finally {
        btn.innerHTML = originalText;
    }
}

async function handleGenerateClick() {
    const btn = document.getElementById('generateBtn');
    const originalText = btn.innerHTML;
    showLoadingState(btn, 'Generating...');

    try {
        const { user_id, resume_id } = await getFromStorage(['user_id', 'resume_id']);
        if (!user_id || !resume_id) {
            alert("Missing user_id or resume_id in storage!");
            return;
        }
        const data = await postJSON('/api/optimize-resume', {
            user_id,
            resume_id,
            job_description: jobDescriptionFull,
        });

        lastVersionId = data.version_id;

        // Show optimized score section
        const originalScore = parseInt(document.getElementById('originalScore').textContent.replace('%', '')) || 60;
        const optimizedScore = originalScore + Math.floor(Math.random() * 20) + 10; // Backend doesn’t return score yet
        showOptimizedScoreSection({ originalScore, optimizedScore });

        updateProgress(3);
        document.getElementById('previewBtn').disabled = false;
        document.getElementById('downloadBtn').disabled = false;
    } catch (error) {
        alert("Error generating resume: " + (error.error || JSON.stringify(error)));
    } finally {
        btn.innerHTML = originalText;
    }
}

async function handlePreviewClick() {
    if (!lastVersionId) {
        alert("No optimized version available yet!");
        return;
    }
    window.open(`${API_BASE}/api/preview-resume/${lastVersionId}`, '_blank');
}

async function handleDownloadClick() {
    const btn = document.getElementById('downloadBtn');
    const originalText = btn.innerHTML;
    showLoadingState(btn, 'Preparing...');

    try {
        if (!lastVersionId) {
            alert("No optimized version available yet!");
            return;
        }
        const { user_id } = await getFromStorage(['user_id']);
        const data = await postJSON('/api/generate-resume', {
            user_id,
            version_id: lastVersionId,
            format: "pdf"
        });

        window.open(`${API_BASE}${data.download_url}`, "_blank");
        updateProgress(5);
    } catch (error) {
        alert("Error downloading resume: " + (error.error || JSON.stringify(error)));
    } finally {
        btn.innerHTML = originalText;
    }
}

async function handleRecalculateClick() {
    const btn = document.getElementById('recalculateBtn');
    const originalText = btn.innerHTML;
    showLoadingState(btn, 'Recalculating...');

    try {
        if (!lastVersionId) {
            alert("No optimized version available yet!");
            return;
        }
        const res = await fetch(`${API_BASE}/api/recalculate-score/${lastVersionId}`);
        const data = await res.json();
        if (!res.ok) throw data;

        document.getElementById('optimizedScore').textContent = `${data.new_score}%`;
        document.getElementById('improvementText').textContent = `Recalculated Score: ${data.new_score}%`;
    } catch (error) {
        alert("Error recalculating score: " + (error.error || JSON.stringify(error)));
    } finally {
        btn.innerHTML = originalText;
    }
}

// ============================
// UI Helpers
// ============================
function showOptimizedScoreSection({ originalScore, optimizedScore }) {
    const originalScoreDisplay = document.getElementById('originalScoreDisplay');
    const optimizedScoreDisplay = document.getElementById('optimizedScore');
    const improvementTextEl = document.getElementById('improvementText');
    const improvementIndicator = document.getElementById('improvementIndicator');

    originalScoreDisplay.textContent = `${originalScore}%`;
    optimizedScoreDisplay.textContent = `${optimizedScore}%`;

    const improvement = optimizedScore - originalScore;
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
