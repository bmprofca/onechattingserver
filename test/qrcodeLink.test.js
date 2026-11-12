import test from "node:test";
import assert from "node:assert/strict";
import { buildWhatsAppQrLink } from "../helpers/qrcodeLink.js";

test("builds a WhatsApp-recognized link with a clean, customer-friendly message", () => {
    const link = buildWhatsAppQrLink({
        phoneNumber: "+1 (555) 123-4567",
        projectId: "697469d9e381880dc5a9dd54",
        qrId: "4253250956",
    });
    const url = new URL(link);

    assert.equal(url.origin, "https://wa.me");
    assert.equal(url.pathname, "/15551234567");
    assert.equal(url.searchParams.get("text"), "Hello! I'd like to connect.");
    assert.equal(url.searchParams.get("text").includes("Project ID"), false);
    assert.equal(url.searchParams.get("text").includes("[Ref:"), false);
});

test("does not produce a direct WhatsApp link without a valid phone number", () => {
    assert.equal(buildWhatsAppQrLink({ phoneNumber: "123" }), "");
    assert.equal(buildWhatsAppQrLink({ phoneNumber: "" }), "");
});
