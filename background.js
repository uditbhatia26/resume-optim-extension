// ============================================================
// ResumeSculpt — Background Service Worker
// Owns all long-running API calls so they survive a closed popup.
// ============================================================

importScripts("config.js"); // defines SCULPT_CONFIG
const API_BASE = SCULPT_CONFIG.API_BASE;
const DASHBOARD_ORIGIN = new URL(SCULPT_CONFIG.DASHBOARD_URL).origin;
const MAX_JD_CHARS = 10000; // keep in sync with MAX_JD_CHARS in backend/schema/schema.py
const clampJD = (t) => (t || "").slice(0, MAX_JD_CHARS);

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
    const stored = await getFromStorage(["access_token", "ai_provider", "ai_api_key", "ai_model", "is_byok_allowed"]);
    const { access_token, ai_provider, ai_api_key, ai_model, is_byok_allowed } = stored;
    if (!access_token) throw new Error("Not authenticated");

    const headers = { Authorization: `Bearer ${access_token}` };
    if (!isFormData) headers["Content-Type"] = "application/json";

    // Attach BYOK config to JSON bodies only if user is entitled and has credentials saved
    let finalBody = body;
    if (!isFormData && body && typeof body === "object") {
        if (is_byok_allowed && ai_provider && ai_api_key) {
            finalBody = {
                ...body,
                ai_config: {
                    provider: ai_provider,
                    api_key:  ai_api_key,
                    model:    ai_model || null,
                },
            };
        } else {
            finalBody = {
                ...body,
                ai_config: null,
            };
        }
    }

    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: finalBody ? (isFormData ? finalBody : JSON.stringify(finalBody)) : undefined,
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
            return true;

        case "ANALYZE_ATS":
            handleAnalyzeATS(message.payload)
                .then(() => sendResponse({ started: true }))
                .catch(() => sendResponse({ started: true }));
            return true; // ← changed from false

        case "OPTIMIZE_RESUME":
            handleOptimizeResume(message.payload)
                .then(() => sendResponse({ started: true }))
                .catch(() => sendResponse({ started: true }));
            return true; // ← changed from false

        case "UPLOAD_RESUME":
            handleUploadResume(message.payload)
                .then(() => sendResponse({ started: true }))
                .catch(() => sendResponse({ started: true }));
            return true; // ← changed from false

        // The website's session bridge (content/bridge.js): sign-in, renewal or sign-out there
        case "WEB_SESSION":
            if (_sender?.id !== chrome.runtime.id || !(_sender.url || "").startsWith(DASHBOARD_ORIGIN)) return false;
            adoptWebSession(message.token).then(sendResponse).catch(() => sendResponse({ signed_in: false }));
            return true;

        // The popup opened with no session: look for one in an open Sculpt website tab
        case "PULL_WEB_SESSION":
            pullWebSession().then(sendResponse).catch(() => sendResponse({ signed_in: false }));
            return true;

        case "FETCH_JD":
            handleFetchJD(message.payload)
                .then(sendResponse)
                .catch((err) => {
                    sendResponse({ error: err?.message || String(err) });
                });
            return true;

        default:
            return false;
    }
});

// ============================================================
// One login: the session comes from the Sculpt website
// ============================================================

/**
 * Take the website's token as this extension's session.
 *   - null: the user signed out on the website, so sign out here too.
 *   - a token we already hold, or the one the user signed out of here: nothing to do.
 *   - anything else: check it with the API, then store the session.
 */
async function adoptWebSession(token) {
    const stored = await getFromStorage(["access_token", "user_email", "ignored_web_token"]);

    if (!token) {
        if (stored.access_token) await chrome.storage.local.clear();
        return { signed_in: false };
    }
    if (token === stored.access_token) return { signed_in: true };
    if (token === stored.ignored_web_token) return { signed_in: false, reason: "ignored" };

    let res;
    try {
        res = await fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
        return { signed_in: !!stored.access_token, reason: "offline" };
    }
    if (!res.ok) return { signed_in: !!stored.access_token, reason: res.status === 401 ? "rejected" : "offline" };
    const me = await res.json();

    // A different account: drop the previous one's job, scores and saved key first
    if (stored.user_email && stored.user_email !== me.email) await chrome.storage.local.clear();

    await setToStorage({
        access_token:        token,
        ignored_web_token:   null,
        user_email:          me.email,
        user_id:             me.user_id,
        has_resume:          !!me.has_resume,
        resume_filename:     me.resume_filename || null,
        plan:                me.plan ?? "free",
        email_verified:      !!me.email_verified,
        is_byok_allowed:     me.is_byok_allowed ?? false,
        is_admin:            me.is_admin ?? false,
        weekly_usage:        me.weekly_usage ?? 0,
        weekly_limit:        me.weekly_limit ?? 5,
        daily_usage:         me.daily_usage ?? 0,
        monthly_usage:       me.monthly_usage ?? 0,
        onboarding_complete: !!me.onboarding_complete,
        setup_required:      !!me.setup_required,
    });
    return { signed_in: true };
}

/**
 * Read the token from an open Sculpt website tab, if there is one, and adopt it.
 * When nothing is adopted, `reason` says why, so the popup can tell the person what to do:
 *   no_tab     no tab open at the Sculpt website's address (DASHBOARD_ORIGIN)
 *   signed_out a Sculpt tab is open but signed out
 *   rejected   the tab's sign-in has expired or was revoked
 *   offline    the Sculpt server couldn't be reached
 */
async function pullWebSession() {
    const tabs = await chrome.tabs.query({ url: `${DASHBOARD_ORIGIN}/*` });
    if (tabs.length === 0) return { signed_in: false, reason: "no_tab", origin: DASHBOARD_ORIGIN };
    // Site access can be withheld in chrome://extensions ("On click"); then no tab can be read
    const access = await chrome.permissions.contains({ origins: [`${DASHBOARD_ORIGIN}/*`] }).catch(() => true);
    if (!access) return { signed_in: false, reason: "no_access", origin: DASHBOARD_ORIGIN };

    let reason = null;
    let readAny = false;
    for (const tab of tabs) {
        const token = await readTabToken(tab.id);
        if (token === undefined) continue;          // this tab couldn't be read
        readAny = true;
        if (!token) continue;                       // read fine: signed out in that tab
        const outcome = await adoptWebSession(token);
        if (outcome.signed_in) return outcome;
        if (outcome.reason) reason = outcome.reason;
    }
    return { signed_in: false, reason: reason || (readAny ? "signed_out" : "unreadable"), origin: DASHBOARD_ORIGIN };
}

/** The Sculpt token stored in a tab: a string, null when signed out, undefined if unreadable. */
async function readTabToken(tabId) {
    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => localStorage.getItem("sculpt_token"),
        });
        return result?.result ?? null;
    } catch (err) {
        console.warn("Sculpt: couldn't read the website tab directly:", err?.message || err);
    }
    // Second way: ask the bridge script running on the page
    try {
        const reply = await chrome.tabs.sendMessage(tabId, { type: "GET_WEB_SESSION" });
        return reply ? (reply.token ?? null) : undefined;
    } catch {
        return undefined;
    }
}

// ============================================================
// Handlers
// ============================================================

/** PARSE_JD — cache-warming, request-response (fast, <1s) */
async function handleParseJD({ job_desc }) {
    const data = await apiFetch("/parse-jd", { body: { job_desc: clampJD(job_desc) } });
    await setToStorage({ session_jd_cache_id: data.jd_cache_id });
    return data;
}

/** ANALYZE_ATS — fire-and-forget, result persisted to storage */
async function handleAnalyzeATS({ job_desc, jd_cache_id }) {
    await setToStorage({ analyze_status: "running" });
    notifyPopup({ type: "ANALYZE_PROGRESS" });

    try {
        const data = await apiFetch("/calculate-ats-detailed", {
            body: { job_desc: clampJD(job_desc), jd_cache_id },
        });
        await setToStorage({
            analyze_status: "done",
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
async function handleOptimizeResume({ job_desc, jd_cache_id, original_ats_score, template }) {
    await setToStorage({ optimization_status: "running" });
    notifyPopup({ type: "OPTIMIZE_PROGRESS", step: "started" });

    try {
        const data = await apiFetch("/optimize-resume", {
            body: { job_desc: clampJD(job_desc), jd_cache_id, original_ats_score, template: template || undefined },
        });
        await setToStorage({
            optimization_status: "done",
            selected_template: data.selected_template || template || "jakes_resume",
            session_optimized_score: data.optimized_score,
            session_improvements: data.improvements_made,
            session_optimized_yaml: data.optimized_resume_yaml,
            session_resume_changes: data.resume_changes || [],
            session_progress: 5,
            weekly_usage:  data.weekly_usage,
            weekly_limit:  data.weekly_limit,
            daily_usage:   data.daily_usage  ?? 0,
            monthly_usage: data.monthly_usage ?? 0,
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
 * Popup converts the PDF File to base64, sends it here with BYOK fields.
 * We reconstruct the binary blob and POST to /upload-resume.
 */
async function handleUploadResume({ base64, filename, ai_provider, ai_api_key, ai_model }) {
    await setToStorage({ upload_status: "running", upload_filename: filename });
    notifyPopup({ type: "UPLOAD_PROGRESS" });

    try {
        // Reconstruct binary from base64
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const isDocx = (filename || "").toLowerCase().endsWith(".docx");
        const mime = isDocx
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : "application/pdf";
        const blob = new Blob([bytes], { type: mime });

        const formData = new FormData();
        formData.append("file", blob, filename);
        // Attach BYOK fields as form fields
        if (ai_provider) formData.append("ai_provider", ai_provider);
        if (ai_api_key)  formData.append("ai_api_key",  ai_api_key);
        if (ai_model)    formData.append("ai_model",    ai_model);

        await apiFetch("/upload-resume", { isFormData: true, body: formData });

        await setToStorage({
            upload_status: "done",
            has_resume: true,
            resume_filename: filename,
        });
        notifyPopup({ type: "UPLOAD_DONE", payload: { filename } });
    } catch (err) {
        const errMsg = err?.detail || err?.message || String(err);
        await setToStorage({ upload_status: "error", upload_error: errMsg });
        notifyPopup({ type: "UPLOAD_ERROR", error: errMsg });
    }
}

// ============================================================
// FETCH_JD — extract job description from the active tab
// ============================================================

/**
 * Injects extractJobDescription() into the active tab via chrome.scripting
 * and returns { text, source } or throws if extraction fails / no tab found.
 */
async function handleFetchJD({ tabId } = {}) {
    const id = tabId ?? (await getActiveTabId());
    if (!id) throw new Error("No active tab found.");

    const results = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => {
            // Call the function registered by content.js.
            if (typeof window.__sculptExtractJD === "function") {
                return window.__sculptExtractJD();
            }
            return null;
        },
    });

    const result = results?.[0]?.result;
    if (!result || !result.text) {
        throw new Error("No job description found on this page.");
    }
    return result; // { text, source }
}

async function getActiveTabId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
}
