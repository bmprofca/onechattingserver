(function () {
    "use strict";

    var script = document.currentScript;
    if (!script) return;

    var qrId = (script.getAttribute("data-qr-id") || "").trim();
    var baseUrl = (script.getAttribute("data-base-url") || window.location.origin).replace(/\/+$/, "");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(qrId)) {
        console.error("OneChatting widget requires a valid data-qr-id.");
        return;
    }

    var parsedBase;
    try {
        parsedBase = new URL(baseUrl);
    } catch (error) {
        console.error("OneChatting widget requires a valid data-base-url.");
        return;
    }
    if (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") {
        console.error("OneChatting widget base URL must use HTTP or HTTPS.");
        return;
    }

    var linkUrl = new URL("/qr/" + encodeURIComponent(qrId), parsedBase.origin);
    ["message", "campaign", "source"].forEach(function (name) {
        var value = script.getAttribute("data-" + name);
        if (value) linkUrl.searchParams.set(name, value);
    });

    var link = document.createElement("a");
    link.href = linkUrl.toString();
    link.textContent = script.getAttribute("data-label") || "Chat on WhatsApp";
    link.setAttribute("aria-label", link.textContent);
    link.style.cssText = [
        "position:fixed",
        "right:20px",
        "bottom:20px",
        "z-index:2147483000",
        "display:inline-flex",
        "align-items:center",
        "padding:12px 18px",
        "border-radius:999px",
        "background:#128C7E",
        "color:#fff",
        "font:600 14px/1.2 Arial,sans-serif",
        "text-decoration:none",
        "box-shadow:0 4px 14px rgba(0,0,0,.22)"
    ].join(";");
    document.body.appendChild(link);
})();
