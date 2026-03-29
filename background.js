// ============================================================
// ResumeSculpt — Background Service Worker
// Owns all long-running API calls so they survive a closed popup.
// ============================================================

const API_BASE = "http://localhost:8000";

// ---- Storage helpers ----
function getFromStorage(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function setToStorage(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

// ---- Notify the popup if it is currently open (best-effort, no-throw) ----
function notifyPopup(message) {
    chrome.runtime
        .sendMessage(message)
        .catch(() => {
            // Popup is closed — that's fine. State is persisted in chrome.storage.
        });
}

// ---- Generic authenticated fetch ----
async function apiFetch(path, { method = "POST", body = null } = {}) {
    const { access_token } = await getFromStorage(["access_token"]);
    if (!access_token) throw new Error("Not authenticated");

    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
    };

    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json();
    if (res.status === 401) {
        // Token expired — clear storage so popup shows login on next open
        await chrome.storage.local.clear();
        throw new Error("SESSION_EXPIRED");
    }
    if (!res.ok) throw data; // forward the error payload to the caller
    return data;
}

// ============================================================
// Message dispatcher
// ============================================================
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
        case "PARSE_JD":
            handleParseJD(message.payload).then(sendResponse).catch((err) => {
                sendResponse({ error: err?.detail || err?.message || String(err) });
            });
            return true; // keep port open for async sendResponse

        case "ANALYZE_ATS":
            handleAnalyzeATS(message.payload).then(sendResponse).catch((err) => {
                sendResponse({ error: err?.detail || err?.message || String(err) });
            });
            return true;

        case "OPTIMIZE_RESUME":
            // Fire-and-forget — result is persisted + popup notified separately
            handleOptimizeResume(message.payload);
            sendResponse({ started: true });
            return false;

        default:
            return false;
    }
});

// ============================================================
// Handlers
// ============================================================

/**
 * PARSE_JD
 * Parses a raw job description (cache-aware) and saves the cache_id to storage.
 * The popup should call this when the user submits a JD, then store the returned
 * jd_cache_id for use in ANALYZE_ATS and OPTIMIZE_RESUME.
 */
async function handleParseJD({ job_desc }) {
    const data = await apiFetch("/parse-jd", {
        body: { job_desc },
    });
    // Persist so popup can re-read after being closed/reopened
    await setToStorage({ session_jd_cache_id: data.jd_cache_id });
    return data; // { jd_cache_id, job_title, skills }
}

/**
 * ANALYZE_ATS
 * Runs /calculate-ats-detailed using the cached JD parse.
 * Returns the full DetailedATS object to the caller.
 */
async function handleAnalyzeATS({ job_desc, jd_cache_id }) {
    const data = await apiFetch("/calculate-ats-detailed", {
        body: { job_desc, jd_cache_id },
    });
    // Persist so session restore works after popup closed
    await setToStorage({ session_ats_score: data.overall_score });
    return data; // full DetailedATS
}

/**
 * OPTIMIZE_RESUME  (fire-and-forget from popup perspective)
 * Runs /optimize-resume, which owns the two slowest LLM calls.
 * Progress is broadcast back to the popup as it becomes available.
 * Final result is written to chrome.storage so it survives a closed popup.
 */
async function handleOptimizeResume({ job_desc, jd_cache_id, original_ats_score }) {
    // Mark as in-progress immediately so the popup can show a spinner on reopen
    await setToStorage({ optimization_status: "running" });
    notifyPopup({ type: "OPTIMIZE_PROGRESS", step: "started" });

    try {
        const data = await apiFetch("/optimize-resume", {
            body: { job_desc, jd_cache_id, original_ats_score },
        });

        // Persist result — popup reads this on open or via notification
        await setToStorage({
            optimization_status:        "done",
            session_optimized_score:    data.optimized_score,
            session_improvements:       data.improvements_made,
            session_optimized_yaml:     data.optimized_resume_yaml,
            session_progress:           5,
            weekly_usage:               data.weekly_usage,
            weekly_limit:               data.weekly_limit,
        });

        notifyPopup({ type: "OPTIMIZE_DONE", payload: data });
    } catch (err) {
        const errMsg = err?.detail || err?.message || String(err);
        await setToStorage({ optimization_status: "error", optimization_error: errMsg });
        notifyPopup({ type: "OPTIMIZE_ERROR", error: errMsg });
    }
}
