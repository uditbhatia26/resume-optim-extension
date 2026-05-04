// ============================================================
// ResumeSculpt — Content Script
// Extracts job descriptions from job listing pages.
// ============================================================

/**
 * Attempts to extract a job description from the current page using
 * site-specific selectors, falling back to heuristic-based extraction.
 *
 * @returns {{ text: string, source: string } | null}
 */
function extractJobDescription() {

    // ---- Site-specific selectors (highest confidence) ----
    const siteSelectors = [
        // LinkedIn
        { sel: ".jobs-description__content .jobs-description-content__text",  site: "LinkedIn"   },
        { sel: ".jobs-description-content",                                    site: "LinkedIn"   },
        { sel: ".job-view-layout .description__text",                          site: "LinkedIn"   },
        // Indeed
        { sel: "#jobDescriptionText",                                          site: "Indeed"     },
        { sel: ".jobsearch-JobComponent-description",                          site: "Indeed"     },
        // Glassdoor
        { sel: "[data-test='jobDescriptionContent']",                          site: "Glassdoor"  },
        { sel: ".JobDetails_jobDescription__uW_fK",                            site: "Glassdoor"  },
        { sel: ".desc.module.padHorz",                                         site: "Glassdoor"  },
        // Naukri
        { sel: ".styles_job-desc-container__txpYf",                            site: "Naukri"     },
        { sel: ".job-desc",                                                    site: "Naukri"     },
        // Lever (many startups use this)
        { sel: ".posting-requirements",                                        site: "Lever"      },
        { sel: ".section-wrapper",                                             site: "Lever"      },
        // Greenhouse
        { sel: "#content",                                                     site: "Greenhouse" },
        // Workday
        { sel: "[data-automation-id='jobPostingDescription']",                 site: "Workday"    },
        // Generic / Semantic HTML
        { sel: "[class*='job-description']",                                   site: "Page"       },
        { sel: "[class*='jobDescription']",                                    site: "Page"       },
        { sel: "[id*='job-description']",                                      site: "Page"       },
        { sel: "[id*='jobDescription']",                                       site: "Page"       },
        { sel: "[class*='job_description']",                                   site: "Page"       },
        { sel: "article[class*='job']",                                        site: "Page"       },
    ];

    for (const { sel, site } of siteSelectors) {
        try {
            const el = document.querySelector(sel);
            if (el) {
                const text = el.innerText?.trim();
                if (text && text.length > 100) {
                    return { text, source: site };
                }
            }
        } catch (_) {
            // Ignore invalid selectors
        }
    }

    // ---- Heuristic fallback: find the longest <section>, <article>, or <div>
    //      whose text contains job-related keywords ----
    const JOB_KEYWORDS = [
        "responsibilities", "requirements", "qualifications",
        "experience", "skills", "about the role", "what you'll do",
        "you will", "we are looking for", "job description",
    ];

    const candidates = Array.from(
        document.querySelectorAll("article, section, div[class], div[id]")
    );

    let best = null;
    let bestScore = 0;

    for (const el of candidates) {
        // Skip navigation / header / footer
        const tag = el.tagName.toLowerCase();
        if (["nav", "header", "footer", "aside"].includes(tag)) continue;

        const text = el.innerText?.trim() || "";
        if (text.length < 200 || text.length > 15_000) continue;

        // Score: count how many keywords appear + favour longer text
        const lower = text.toLowerCase();
        let score = 0;
        for (const kw of JOB_KEYWORDS) {
            if (lower.includes(kw)) score += 2;
        }
        // Prefer elements that aren't wrapping the whole page (not too big)
        score += Math.min(text.length / 500, 5);

        if (score > bestScore) {
            bestScore = score;
            best = { text, source: "Page" };
        }
    }

    // Only trust the heuristic result if it scored reasonably well
    if (best && bestScore >= 4) return best;

    return null;
}

// Expose so the background / popup can call it via executeScript
window.__sculptExtractJD = extractJobDescription;
