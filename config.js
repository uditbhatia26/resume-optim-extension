// ============================================================
// ResumeSculpt - shared extension config (popup + service worker)
// Production addresses. If either changes, update manifest.json too: host_permissions
// (both origins) and the session bridge's "matches" (must be exactly the DASHBOARD_URL
// origin, or the extension can't pick up the website's sign-in).
// For local development, temporarily use http://localhost:8000 and http://localhost:5173
// here and in manifest.json; never upload a package with localhost in it.
// ============================================================
const SCULPT_CONFIG = {
    API_BASE: "https://api.resumesculpt.app",
    DASHBOARD_URL: "https://resumesculpt.app",
};
