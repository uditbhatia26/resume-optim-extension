// ============================================================
// ResumeSculpt — Content Script
// Extracts job descriptions from job listing pages.
// ============================================================

// ---------------------------------------------------------------------------
// Noise strings — lines/blocks that appear in nav/footer/sidebar but NEVER
// in a real JD. Any extracted block containing ≥3 of these is rejected.
// ---------------------------------------------------------------------------
const NAV_NOISE = [
    "skip to main content", "sign in", "join now", "try premium",
    "my network", "notifications", "messaging", "advertise",
    "linkedin corporation", "help center", "privacy & terms",
    "talent solutions", "marketing solutions", "small business",
    "more jobs", "see more jobs", "easy apply", "save this job",
    "similar jobs", "people also viewed", "posted", "hours ago",
    "days ago", "weeks ago", "applicants", "reactivate premium",
    "select language", "العربية", "中文", "français", "español",
    "© 202", "cookie policy", "terms of service",
];

// ---------------------------------------------------------------------------
// Section boundary phrases — anything AFTER these lines is sidebar/footer
// and should be trimmed from the extracted text.
// ---------------------------------------------------------------------------
const TRIM_AFTER = [
    "more jobs", "see more jobs", "jobs like this",
    "interested in working with us", "privately share your profile",
    "full stack", // start of "More jobs" sidebar card titles
    "people also viewed",
    "job search smarter",
    "looking for talent",
    "about accessibility",
];

// ---------------------------------------------------------------------------
// JD must contain at least one of these to be considered a real description.
// ---------------------------------------------------------------------------
const JD_SIGNALS = [
    "responsibilities", "requirements", "qualifications",
    "you will", "we are looking for", "what you'll do",
    "about the role", "about the job", "job description",
    "experience", "skills required", "what we need",
    "stipend", "internship", "full-time", "part-time",
    "salary", "compensation", "apply",
];

// ---------------------------------------------------------------------------
// Post-process raw extracted text:
//   1. Trim everything after sidebar / footer boundary phrases
//   2. Keep only lines that look like real content
//   3. Reject the block if it contains too many nav noise strings
// ---------------------------------------------------------------------------
function cleanExtractedText(raw) {
    if (!raw) return null;

    let text = raw.trim();
    const lower = text.toLowerCase();

    // --- Step 1: find the earliest boundary and cut there ---
    let cutAt = text.length;
    for (const boundary of TRIM_AFTER) {
        const idx = lower.indexOf(boundary);
        if (idx > 200 && idx < cutAt) cutAt = idx;
    }
    text = text.slice(0, cutAt).trim();

    // --- Step 2: count nav noise hits ---
    const textLower = text.toLowerCase();
    let noiseCount = 0;
    for (const n of NAV_NOISE) {
        if (textLower.includes(n)) noiseCount++;
    }
    // Reject if more than 4 nav strings — this is almost certainly a page dump
    if (noiseCount > 4) return null;

    // --- Step 3: must contain at least one real JD signal ---
    const hasSignal = JD_SIGNALS.some((s) => textLower.includes(s));
    if (!hasSignal) return null;

    // --- Step 4: strip blank lines and deduplicate whitespace ---
    text = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join("\n")
        .trim();

    return text.length >= 100 ? text : null;
}

// ---------------------------------------------------------------------------
// Site-specific selectors — ordered from highest to lowest confidence.
// We prefer stable IDs and data-* attributes over generated class names.
// ---------------------------------------------------------------------------
const SITE_SELECTORS = [
    // ---- LinkedIn ----
    // "About the job" section — the most reliable LinkedIn target
    { sel: "#job-details",                                          site: "LinkedIn"   },
    { sel: "[data-job-id] .jobs-description",                       site: "LinkedIn"   },
    { sel: ".jobs-description__content",                            site: "LinkedIn"   },
    { sel: ".jobs-description-content__text",                       site: "LinkedIn"   },
    { sel: ".jobs-unified-top-card__job-description",               site: "LinkedIn"   },
    { sel: "[class*='job-details'][class*='description']",          site: "LinkedIn"   },
    { sel: "[class*='jobs-description']",                           site: "LinkedIn"   },
    // ---- Indeed ----
    { sel: "#jobDescriptionText",                                   site: "Indeed"     },
    { sel: "[data-testid='jobsearch-JobComponent-description']",    site: "Indeed"     },
    { sel: ".jobsearch-JobComponent-description",                   site: "Indeed"     },
    // ---- Glassdoor ----
    { sel: "[data-test='jobDescriptionContent']",                   site: "Glassdoor"  },
    { sel: "[class*='JobDetails_jobDescription']",                  site: "Glassdoor"  },
    // ---- Naukri ----
    { sel: "[class*='job-desc-container']",                         site: "Naukri"     },
    { sel: ".job-desc",                                             site: "Naukri"     },
    // ---- Lever (startup ATS) ----
    { sel: ".posting-requirements",                                 site: "Lever"      },
    // ---- Greenhouse ----
    { sel: "#content .body",                                        site: "Greenhouse" },
    // ---- Workday ----
    { sel: "[data-automation-id='jobPostingDescription']",          site: "Workday"    },
    // ---- Generic semantic ----
    { sel: "[id='job-description']",                                site: "Page"       },
    { sel: "[id='jobDescription']",                                 site: "Page"       },
    { sel: "[class*='job-description']:not(body):not(html)",        site: "Page"       },
    { sel: "[class*='jobDescription']:not(body):not(html)",         site: "Page"       },
    { sel: "article[class*='job']",                                 site: "Page"       },
];

// ---------------------------------------------------------------------------
// Heuristic fallback — scores every sizeable block and picks the best one.
// ---------------------------------------------------------------------------
function heuristicExtract() {
    const candidates = Array.from(
        document.querySelectorAll("section, article, div[class], div[id], main")
    );

    let best = null;
    let bestScore = 0;

    for (const el of candidates) {
        // Skip layout wrappers that are too high in the DOM
        if (["body", "html", "nav", "header", "footer", "aside"].includes(
            el.tagName.toLowerCase()
        )) continue;

        // Skip elements that contain most of the page (probably a root wrapper)
        const docLen = document.body.innerText?.length || 1;
        const elLen  = el.innerText?.length || 0;
        if (elLen / docLen > 0.6) continue; // skip if > 60% of the page
        if (elLen < 200 || elLen > 12_000) continue;

        const text  = el.innerText.trim();
        const lower = text.toLowerCase();

        // Count positive JD signals
        let score = 0;
        for (const s of JD_SIGNALS)  { if (lower.includes(s)) score += 3; }

        // Penalise nav noise
        let noise = 0;
        for (const n of NAV_NOISE)   { if (lower.includes(n)) noise++; }
        score -= noise * 2;

        // Prefer moderate length (not too short, not a page dump)
        score += Math.min(elLen / 600, 4);

        if (score > bestScore) {
            bestScore = score;
            best = { el, text };
        }
    }

    if (!best || bestScore < 3) return null;

    const cleaned = cleanExtractedText(best.text);
    return cleaned ? { text: cleaned, source: "Page" } : null;
}

// ---------------------------------------------------------------------------
// Main extraction entry-point
// ---------------------------------------------------------------------------
function extractJobDescription() {

    // 1️⃣  Try each site-specific selector
    for (const { sel, site } of SITE_SELECTORS) {
        try {
            const el = document.querySelector(sel);
            if (!el) continue;

            const raw     = el.innerText?.trim();
            const cleaned = cleanExtractedText(raw);
            if (cleaned) return { text: cleaned, source: site };
        } catch (_) {
            // ignore invalid selectors in older Chrome builds
        }
    }

    // 2️⃣  Fall back to heuristic scoring
    return heuristicExtract();
}

// Expose for popup to call via chrome.scripting.executeScript
window.__sculptExtractJD = extractJobDescription;
