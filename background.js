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
async function apiFetch(path, { method = "POST", body = null, isFormData = false } = {}) {
    const { access_token } = await getFromStorage(["access_token"]);
    if (!access_token) throw new Error("Not authenticated");

    const headers = { Authorization: `Bearer ${access_token}` };
    if (!isFormData) headers["Content-Type"] = "application/json";

    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? (isFormData ? body : JSON.stringify(body)) : undefined,
    });

    if (res.status === 401) {
        await chrome.storage.local.clear();
        throw new Error("SESSION_EXPIRED");
    }

    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await res.json() : { detail: await res.text() };
    if (!res.ok) throw data;
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
            // Fire-and-forget — result written to storage + popup notified
            handleAnalyzeATS(message.payload);
            sendResponse({ started: true });
            return false;

        case "OPTIMIZE_RESUME":
            handleOptimizeResume(message.payload);
            sendResponse({ started: true });
            return false;

        case "UPLOAD_RESUME":
            // PDF passed as base64 string (serializable across message boundary)
            handleUploadResume(message.payload);
            sendResponse({ started: true });
            return false;

        default:
            return false;
    }
});

// ============================================================
// Handlers
// ============================================================

/** PARSE_JD — cache-warming, request-response (fast, <1s) */
async function handleParseJD({ job_desc }) {
    const data = await apiFetch("/parse-jd", { body: { job_desc } });
    await setToStorage({ session_jd_cache_id: data.jd_cache_id });
    return data;
}

/** ANALYZE_ATS — fire-and-forget, result persisted to storage */
async function handleAnalyzeATS({ job_desc, jd_cache_id }) {
    await setToStorage({ analyze_status: "running" });
    notifyPopup({ type: "ANALYZE_PROGRESS" });

    try {
        const data = await apiFetch("/calculate-ats-detailed", {
            body: { job_desc, jd_cache_id },
        });
        await setToStorage({
            analyze_status:    "done",
            session_ats_score: data.overall_score,
        });
        notifyPopup({ type: "ANALYZE_DONE", payload: data });
    } catch (err) {
        const errMsg = err?.detail || err?.message || String(err);
        await setToStorage({ analyze_status: "error", analyze_error: errMsg });
        notifyPopup({ type: "ANALYZE_ERROR", error: errMsg });
    }
}

/** OPTIMIZE_RESUME — fire-and-forget */
async function handleOptimizeResume({ job_desc, jd_cache_id, original_ats_score }) {
    await setToStorage({ optimization_status: "running" });
    notifyPopup({ type: "OPTIMIZE_PROGRESS", step: "started" });

    try {
        const data = await apiFetch("/optimize-resume", {
            body: { job_desc, jd_cache_id, original_ats_score },
        });
        await setToStorage({
            optimization_status:     "done",
            session_optimized_score: data.optimized_score,
            session_improvements:    data.improvements_made,
            session_optimized_yaml:  data.optimized_resume_yaml,
            session_progress:        5,
            weekly_usage:            data.weekly_usage,
            weekly_limit:            data.weekly_limit,
        });
        notifyPopup({ type: "OPTIMIZE_DONE", payload: data });
    } catch (err) {
        const errMsg = err?.detail || err?.message || String(err);
        await setToStorage({ optimization_status: "error", optimization_error: errMsg });
        notifyPopup({ type: "OPTIMIZE_ERROR", error: errMsg });
    }
}

/**
 * UPLOAD_RESUME — fire-and-forget.
 * Popup converts the PDF File to base64, sends it here.
 * We reconstruct the binary blob and POST to /upload-resume.
 */
async function handleUploadResume({ base64, filename }) {
    await setToStorage({ upload_status: "running", upload_filename: filename });
    notifyPopup({ type: "UPLOAD_PROGRESS" });

    try {
        // Reconstruct binary from base64
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const blob = new Blob([bytes], { type: "application/pdf" });

        const formData = new FormData();
        formData.append("file", blob, filename);

        await apiFetch("/upload-resume", { isFormData: true, body: formData });

        await setToStorage({
            upload_status:   "done",
            has_resume:      true,
            resume_filename: filename,
        });
        notifyPopup({ type: "UPLOAD_DONE", payload: { filename } });
    } catch (err) {
        const errMsg = err?.detail || err?.message || String(err);
        await setToStorage({ upload_status: "error", upload_error: errMsg });
        notifyPopup({ type: "UPLOAD_ERROR", error: errMsg });
    }
}
