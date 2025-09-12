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
    document.getElementById('addJobBtn').addEventListener('click', handleAddJobClick);
    document.getElementById('readMoreBtn').addEventListener('click', handleReadMoreClick);
    document.getElementById('analyzeBtn').addEventListener('click', handleAnalyzeClick);
    document.getElementById('generateBtn').addEventListener('click', handleGenerateClick);
    document.getElementById('previewBtn').addEventListener('click', handlePreviewClick);
    document.getElementById('downloadBtn').addEventListener('click', handleDownloadClick);
    document.getElementById('recalculateBtn').addEventListener('click', handleRecalculateClick);

    // Textarea input listener
    document.getElementById('jobDescriptionInput').addEventListener('input', handleJobDescriptionInputChange);
}

// Event handlers
function handleLandingClick() {
    window.open('https://resumesculpt.com', '_blank');
}

function handleJobDescriptionInputChange() {
    const textarea = document.getElementById('jobDescriptionInput');
    const addJobBtn = document.getElementById('addJobBtn');

    // Enable/disable the Add Job Description button based on input
    if (textarea.value.trim().length > 0) {
        addJobBtn.disabled = false;
    } else {
        addJobBtn.disabled = true;
    }
}

function handleAddJobClick() {
    const textarea = document.getElementById('jobDescriptionInput');
    const inputText = textarea.value.trim();

    if (inputText.length === 0) {
        alert('Please paste a job description first');
        return;
    }

    if (inputText.length < 50) {
        alert('Job description seems too short. Please provide a more detailed job description.');
        return;
    }

    // Store the job description
    jobDescriptionFull = inputText;

    // Display the job description
    displayJobDescription();

    // Update progress
    updateProgress(1);

    // Enable analyze button
    document.getElementById('analyzeBtn').disabled = false;

    // Clear and hide the input section
    textarea.value = '';
    document.querySelector('.input-section').style.display = 'none';

    // Show success message briefly
    const addJobBtn = document.getElementById('addJobBtn');
    const originalText = addJobBtn.innerHTML;
    addJobBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6L9 17l-5-5"/></svg>Added Successfully';
    addJobBtn.disabled = true;

    setTimeout(() => {
        addJobBtn.innerHTML = originalText;
    }, 2000);
}

function displayJobDescription() {
    const jobContainer = document.getElementById('jobContainer');
    const jobDescription = document.getElementById('jobDescription');

    if (jobDescriptionFull && jobDescriptionFull.length > 0) {
        // Show truncated version
        jobDescription.textContent = jobDescriptionFull.substring(0, 200) + "...";
        jobContainer.style.display = 'block';

        // Scroll into view
        jobContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
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
        // For MVP: Simulate API call with mock data
        await new Promise(resolve => setTimeout(resolve, 2000)); // Simulate delay

        // Mock analysis - in real implementation, this would be an API call
        const mockScore = Math.floor(Math.random() * 40) + 40; // Random score between 40-80

        // Update the original score
        document.getElementById('originalScore').textContent = `${mockScore}%`;
        updateProgress(2);
        document.getElementById('generateBtn').disabled = false;

        // Future API call would look like this:
        /*
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
            document.getElementById('originalScore').textContent = `${data.score}%`;
            updateProgress(2);
            document.getElementById('generateBtn').disabled = false;
        } else {
            alert('Failed to analyze job description');
        }
        */
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
        // For MVP: Simulate API call with mock data
        await new Promise(resolve => setTimeout(resolve, 3000)); // Simulate delay

        // Mock resume generation - in real implementation, this would be an API call
        const originalScoreText = document.getElementById('originalScore').textContent;
        const originalScore = parseInt(originalScoreText.replace('%', ''));
        const optimizedScore = Math.min(originalScore + Math.floor(Math.random() * 30) + 15, 95); // Improve by 15-45 points

        const mockResumeData = {
            resumeId: 'mock-' + Date.now(),
            success: true,
            originalScore: originalScore,
            optimizedScore: optimizedScore,
            resumeContent: 'Mock resume content...'
        };

        // Store resume data for preview/download
        window.generatedResume = mockResumeData;
        updateProgress(3);
        document.getElementById('previewBtn').disabled = false;
        document.getElementById('downloadBtn').disabled = false;

        // Show and update the optimized score section
        showOptimizedScoreSection(mockResumeData);

        // Future API call would look like this:
        /*
        const response = await fetch('/api/generate-resume', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jobDescription: jobDescriptionFull,
                // userResumeData: getUserResumeData(),
                // preferences: getUserPreferences()
            })
        });

        const data = await response.json();

        if (data.success) {
            window.generatedResume = data;
            updateProgress(3);
            document.getElementById('previewBtn').disabled = false;
            document.getElementById('downloadBtn').disabled = false;
            showOptimizedScoreSection(data);
        } else {
            alert('Failed to generate resume');
        }
        */
    } catch (error) {
        console.error('Error generating resume:', error);
        alert('Error generating resume');
    } finally {
        btn.innerHTML = originalText;
    }
}

function showOptimizedScoreSection(resumeData) {
    // Get the current original score from the first section
    const originalScoreText = document.getElementById('originalScore').textContent;
    const originalScore = originalScoreText !== '--' ? parseInt(originalScoreText.replace('%', '')) : (resumeData.originalScore ?? 60);

    // Use optimized score from API response or fallback
    const optimizedScore = resumeData.optimizedScore ?? 90;

    // Show the optimized score section
    const optimizedScoreSection = document.getElementById('optimizedScoreSection');
    optimizedScoreSection.style.display = 'block';

    // Add slide-in animation
    optimizedScoreSection.style.animation = 'slideIn 0.5s ease-out';

    // Update the score displays
    document.getElementById('originalScoreDisplay').textContent = `${originalScore}%`;
    document.getElementById('optimizedScore').textContent = `${optimizedScore}%`;

    // Calculate and display improvement
    const improvement = optimizedScore - originalScore;
    const improvementTextEl = document.getElementById('improvementText');
    const improvementIndicator = document.getElementById('improvementIndicator');

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

    // Update progress to show optimization completed
    updateProgress(3);

    // Scroll to show the new section
    setTimeout(() => {
        optimizedScoreSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
}

async function handleRecalculateClick() {
    const btn = document.getElementById('recalculateBtn');
    const originalText = btn.innerHTML;
    showLoadingState(btn, 'Recalculating...');

    try {
        // For MVP: Simulate recalculation
        await new Promise(resolve => setTimeout(resolve, 1500));

        const originalScoreText = document.getElementById('originalScore').textContent;
        const originalScore = parseInt(originalScoreText.replace('%', ''));
        const newOptimizedScore = Math.min(originalScore + Math.floor(Math.random() * 35) + 10, 98);

        const updatedData = {
            success: true,
            originalScore: originalScore,
            optimizedScore: newOptimizedScore
        };

        showOptimizedScoreSection(updatedData);

        // Future API call would look like this:
        /*
        const response = await fetch(`/api/recalculate-score/${window.generatedResume.resumeId}`);
        const data = await response.json();
        
        if (data.success) {
            showOptimizedScoreSection(data);
        } else {
            alert('Failed to recalculate score');
        }
        */
    } catch (error) {
        console.error('Error recalculating score:', error);
        alert('Error recalculating score');
    } finally {
        btn.innerHTML = originalText;
    }
}

async function handlePreviewClick() {
    // For MVP: Show a simple alert
    alert('Preview feature will be available soon! This will show you a preview of your optimized resume.');

    // Future implementation:
    /*
    try {
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
    */
}

async function handleDownloadClick() {
    // For MVP: Simulate download
    const btn = document.getElementById('downloadBtn');
    const originalText = btn.innerHTML;

    showLoadingState(btn, 'Preparing...');

    try {
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Create a mock PDF download
        const mockPdfContent = `ResumeSculpt Optimized Resume
Generated on: ${new Date().toLocaleDateString()}
Job Match Score: ${document.getElementById('optimizedScore').textContent}

This is a mock resume file for MVP testing.
Your actual optimized resume will be generated here.

Based on the job description you provided:
${jobDescriptionFull.substring(0, 200)}...

Thank you for using ResumeSculpt!`;

        const blob = new Blob([mockPdfContent], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'resumesculpt_optimized_resume.txt';
        link.click();
        window.URL.revokeObjectURL(url);

        updateProgress(5);

        // Future implementation:
        /*
        const response = await fetch(`/api/download-resume/${window.generatedResume.resumeId}`);

        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'optimized_resume.pdf';
            link.click();
            window.URL.revokeObjectURL(url);
            updateProgress(5);
        } else {
            alert('Failed to download resume');
        }
        */
    } catch (error) {
        console.error('Error downloading resume:', error);
        alert('Error downloading resume');
    } finally {
        btn.innerHTML = originalText;
    }
}

// Utility functions
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

// Helper functions for future implementation
// function getUserResumeData() {
//     // Get user's current resume data from storage/form
//     return {};
// }

// function getUserPreferences() {
//     // Get user's formatting preferences
//     return {};
// }