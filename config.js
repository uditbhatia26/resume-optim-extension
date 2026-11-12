// ============================================================
// ResumeSculpt - shared extension config (popup + service worker)
// Change these two values before publishing to the Chrome Web Store.
// Remember to also update host_permissions in manifest.json, and the session bridge's
// "matches" entry there (it must be the DASHBOARD_URL origin).
// ============================================================
const SCULPT_CONFIG = {
    API_BASE: "http://localhost:8000",
    DASHBOARD_URL: "http://localhost:5173",
};
