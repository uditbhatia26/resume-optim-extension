// Global variables
let jobDescriptionFull = "";
let isExpanded = false;

// Event listeners
document.addEventListener('DOMContentLoaded', function () {
    initializeEventListeners();
});

function initializeEventListeners() {
    // Header buttons
    document.getElementById('landingBtn').addEventListener('click', handleLandingClick);

    // Action buttons
    document.getElementById('getJobBtn').addEventListener('click', handleGetJobClick);
    document.getElementById('readMoreBtn').addEventListener('click', handleReadMoreClick);
    document.getElementById('analyzeBtn').addEventListener('click', handleAnalyzeClick);
    document.getElementById('generateBtn').addEventListener('click', handleGenerateClick);
    document.getElementById('previewBtn').addEventListener('click', handlePreviewClick);
    document.getElementById('downloadBtn').addEventListener('click', handleDownloadClick);
}

// Event handlers
function handleLandingClick() {
    window.open('https://resumeforge.ai', '_blank');
}

async function handleGetJobClick() {
    const btn = document.getElementById('getJobBtn');
    const originalText = btn.innerHTML;

    showLoadingState(btn, 'Fetching...');

    try {
        // API CALL: GET /api/job-description
        // This should extract job description from current page/URL
        // Expected response: { jobDescription: string, success: boolean }

        const response = await fetch('/api/job-description', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                url: window.location.href, // or get from active tab
                pageContent: document.body.innerHTML // if needed
            })
        });

        const data = await response.json();

        if (data.success) {
            jobDescriptionFull = data.jobDescription;
            displayJobDescription();
            updateProgress(1);
            document.getElementById('analyzeBtn').disabled = false;
        } else {
            alert('Failed to extract job description');
        }
    } catch (error) {
        console.error('Error fetching job description:', error);
        alert('Error fetching job description');
    } finally {
        btn.innerHTML = originalText;
    }
}

function displayJobDescription() {
    const jobContainer = document.getElementById('jobContainer');
    const jobDescription = document.getElementById('jobDescription');

    // Show truncated version
    jobDescription.textContent = jobDescriptionFull.substring(0, 200) + "...";
    jobContainer.style.display = 'block';
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

async function handleAnalyzeClick() {
    const btn = document.getElementById('analyzeBtn');
    const originalText = btn.innerHTML;

    showLoadingState(btn, 'Analyzing...');

    try {
        // API CALL: POST /api/analyze-job
        // This should analyze the job description and return optimization score
        // Expected response: { score: number, insights: array, success: boolean }

        const response = await fetch('/api/analyze-job', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jobDescription: jobDescriptionFull
            })
        });

        const data = await response.json();

        if (data.success) {
            document.getElementById('optimizationScore').textContent = `${data.score}%`;
            updateProgress(2);
            document.getElementById('generateBtn').disabled = false;
        } else {
            alert('Failed to analyze job description');
        }
    } catch (error) {
        console.error('Error analyzing job:', error);
        alert('Error analyzing job description');
    } finally {
        btn.innerHTML = originalText;
    }
}

async function handleGenerateClick() {
    const btn = document.getElementById('generateBtn');
    const originalText = btn.innerHTML;

    showLoadingState(btn, 'Generating...');

    try {
        // API CALL: POST /api/generate-resume
        // This should generate optimized resume based on job description
        // You might need to include user's current resume data
        // Expected response: { resumeContent: string, resumeId: string, success: boolean }

        const response = await fetch('/api/generate-resume', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jobDescription: jobDescriptionFull,
                // userResumeData: getUserResumeData(), // implement this function
                // preferences: getUserPreferences() // implement this function
            })
        });

        const data = await response.json();

        if (data.success) {
            // Store resume data for preview/download
            window.generatedResume = data;
            updateProgress(3);
            document.getElementById('previewBtn').disabled = false;
            document.getElementById('downloadBtn').disabled = false;
        } else {
            alert('Failed to generate resume');
        }
    } catch (error) {
        console.error('Error generating resume:', error);
        alert('Error generating resume');
    } finally {
        btn.innerHTML = originalText;
    }
}

async function handlePreviewClick() {
    try {
        // API CALL: GET /api/preview-resume/:resumeId
        // This should return preview URL or HTML content
        // Expected response: { previewUrl: string, success: boolean }

        const response = await fetch(`/api/preview-resume/${window.generatedResume.resumeId}`);
        const data = await response.json();

        if (data.success) {
            window.open(data.previewUrl, '_blank');
        } else {
            alert('Failed to generate preview');
        }
    } catch (error) {
        console.error('Error previewing resume:', error);
        alert('Error generating preview');
    }
}

async function handleDownloadClick() {
    try {
        // API CALL: GET /api/download-resume/:resumeId
        // This should return the resume file (PDF/DOCX)
        // Expected response: Binary file data

        const response = await fetch(`/api/download-resume/${window.generatedResume.resumeId}`);

        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'optimized_resume.pdf';
            link.click();
            window.URL.revokeObjectURL(url);

            updateProgress(4);
        } else {
            alert('Failed to download resume');
        }
    } catch (error) {
        console.error('Error downloading resume:', error);
        alert('Error downloading resume');
    }
}

// Utility functions
function updateProgress(step) {
    for (let i = 1; i <= step; i++) {
        const stepIcon = document.getElementById(`step${i}`);
        const stepItem = stepIcon.parentElement;

        stepIcon.classList.remove('pending');
        stepIcon.classList.add('completed');
        stepIcon.innerHTML = '✓';
        stepItem.classList.add('completed');
    }
}

function showLoadingState(button, loadingText) {
    const loadingIcon = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="animation: pulse 1s infinite;"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
    button.innerHTML = `${loadingIcon}${loadingText}`;
}

// TODO: Implement these helper functions based on your data structure
// function getUserResumeData() {
//     // Get user's current resume data from storage/form
//     return {};
// }

// function getUserPreferences() {
//     // Get user's formatting preferences
//     return {};
// }