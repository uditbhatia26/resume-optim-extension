# Sculpt – AI Resume Optimizer · Chrome Extension

Sculpt is a Chrome extension that analyzes your resume against a job description and generates a tailored, ATS-optimized version — without leaving your browser. It scores your resume before and after optimization, surfaces a detailed changelog of every change made, and produces a downloadable PDF in one click.

---

## Features

### Sign-in
- Accounts live on the Sculpt website: people sign up, sign in (email or Google) and set up their profile there
- The extension has no login form. A small bridge script (`content/bridge.js`), which runs only on the Sculpt website, passes the website's session to the extension, so there is one login for both; signing out on the website signs the extension out
- Until website setup is finished, the popup shows "Finish setting up" with a button to continue there (accounts that predate onboarding are not locked out; they see a reminder)
- Sessions renew silently when the token is past half its 24-hour life

### Resume Management
- The resume uploaded on the website is already there when the extension opens
- Upload a different resume as a PDF or DOCX (max 2 MB)
- The backend parses it into a structured format automatically
- One active resume per account; replaceable at any time via the Change button

### Job Description Input
- Paste a job description manually into the text area
- **Auto-detect from page:** Sculpt probes the active tab and surfaces a "Use from Page" prompt if a job description is detected — works on LinkedIn, Indeed, Glassdoor, Naukri, Greenhouse, Workday, Lever, and any page with standard job description markup
- Job descriptions can be removed and replaced at any time

### ATS Compatibility Analysis
- Scores your current resume against the loaded job description
- Score is calculated across keyword matching, skills alignment, experience relevance, and resume formatting
- Displayed as an "Original Match Score" percentage before optimization

### AI Resume Optimization
- Generates a tailored version of your resume aligned to the job description
- Rewrites bullet points, integrates missing keywords, and reorders skills by relevance
- The education section is never altered
- Takes approximately 30 seconds; a live progress bar shows estimated time remaining

### Optimization Results
- Side-by-side score comparison: original versus optimized
- **What Changed panel:** a collapsible changelog detailing every modification — skills added or removed, bullets enhanced per company, projects added or removed, summary rewrites, and section-level additions or removals
- Critical changes such as removed skills or projects are flagged and auto-expand the panel

### PDF Download
- Downloads the optimized resume as a formatted PDF
- Falls back to the base resume PDF if no optimized version has been generated yet

### Usage Meter
- Displays daily, monthly, and weekly generation counts at a glance
- Weekly limit is shown inline alongside usage (Free plan: 5/week, Pro: 30/week)

### Session Persistence
- If the popup is closed mid-analysis or mid-optimization, state is fully restored on reopen
- Job description, scores, optimized resume data, and changelog all persist in `chrome.storage.local`

---

## Application Flow

```
1. Sign up and set up your profile on the Sculpt website
         |-- resume, projects (Chisel), achievements
         |
2. Open the extension: already signed in, resume loaded
         |
3. Open a job listing page
         |-- Sculpt auto-detects the job description --> Click "Use from Page"
         |-- Or paste the job description manually  --> Click "Add Job Description"
         |
4. Click "Analyze Compatibility"
         |-- Original Match Score is displayed
         |
5. Click "Generate Optimized Resume"
         |-- AI generates a tailored resume (~30 seconds)
         |-- Optimized score and What Changed panel appear
         |
6. Click "Download Resume"
         |-- PDF is saved to your downloads folder
```

---

## Supported Job Portals

Auto-detection is supported on: LinkedIn, Indeed, Glassdoor, Naukri, Greenhouse, Workday, Lever, and any page using standard semantic job description markup.

---

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Persist session, job description, and optimization state across popup opens |
| `activeTab` + `scripting` | Extract job descriptions from the current browser tab |
| `tabs` | Open the Sculpt website in a new tab; find an open Sculpt tab to pick up its session |
| Host access to the Sculpt website | Run the session bridge there (one login for website and extension) |

---

## Architecture

The extension is built as a Manifest V3 extension with three distinct layers.

**`popup/`** — The user interface (HTML, CSS, JavaScript). Handles all rendering, user interaction, and state display.

**`background.js`** — Service worker. Owns all long-running API calls (resume upload, ATS analysis, optimization) so they survive a closed popup. Writes results to `chrome.storage.local` and pushes status notifications to the popup when it is open.

**`content/content.js`** — Content script injected into every tab. Extracts job descriptions using an ordered list of site-specific selectors, with a heuristic scoring fallback for unsupported pages.

Communication follows a one-way flow: the popup sends a message to the background worker, the background performs the API call and writes the result to storage, and the popup reads from storage directly or receives a push notification if it is open.