// ============================================================
// Sculpt: session bridge
// Runs only on the Sculpt website (see manifest.json). People sign in on the website;
// this passes that session to the extension so there is one login for both.
// ============================================================
(() => {
    const TOKEN_KEY = "sculpt_token";

    function send(token) {
        try {
            chrome.runtime.sendMessage({ type: "WEB_SESSION", token: token || null });
        } catch {
            // The extension was reloaded while this tab stayed open; the next page load reconnects.
        }
    }

    // Already signed in when the page opens. (A missing token here is not a sign-out: only an
    // explicit sign-out on the website, announced below, signs the extension out.)
    const existing = localStorage.getItem(TOKEN_KEY);
    if (existing) send(existing);

    // The website announces sign-in, token renewal and sign-out as they happen
    window.addEventListener("message", (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const msg = event.data;
        if (msg && msg.source === "sculpt-web" && msg.type === "session") send(msg.token);
    });
})();
