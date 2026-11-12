import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const widgetScript = fs.readFileSync(new URL("../public/onechatting-widget.js", import.meta.url), "utf8");

function runWidget(attributes) {
    const appended = [];
    const logs = [];
    const script = {
        getAttribute(name) {
            return attributes[name] || "";
        },
    };
    const context = {
        document: {
            currentScript: script,
            body: { appendChild(element) { appended.push(element); } },
            createElement() {
                return {
                    style: { cssText: "" },
                    setAttribute(name, value) { this[name] = value; },
                };
            },
        },
        window: { location: { origin: "https://business.example" } },
        URL,
        console: { error(message) { logs.push(message); } },
    };
    vm.runInNewContext(widgetScript, context);
    return { appended, logs };
}

test("widget creates a QR landing link with message and attribution parameters", () => {
    const { appended } = runWidget({
        "data-qr-id": "1234567890",
        "data-base-url": "https://chat.example/",
        "data-message": "Hi there",
        "data-campaign": "spring sale",
        "data-source": "footer",
        "data-label": "Talk to us",
    });

    assert.equal(appended.length, 1);
    const link = appended[0];
    const url = new URL(link.href);
    assert.equal(url.origin, "https://chat.example");
    assert.equal(url.pathname, "/qr/1234567890");
    assert.equal(url.searchParams.get("message"), "Hi there");
    assert.equal(url.searchParams.get("campaign"), "spring sale");
    assert.equal(url.searchParams.get("source"), "footer");
    assert.equal(link.textContent, "Talk to us");
});

test("widget refuses malformed QR identifiers", () => {
    const { appended, logs } = runWidget({ "data-qr-id": "bad/identifier" });
    assert.equal(appended.length, 0);
    assert.equal(logs.length, 1);
});
