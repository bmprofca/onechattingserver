import test from "node:test";
import assert from "node:assert/strict";
import { buildWhatsAppQrLink } from "../helpers/qrcodeLink.js";

test("builds a WhatsApp-recognized link with the QR and project references", () => {
    const link = buildWhatsAppQrLink({
        phoneNumber: "+1 (555) 123-4567",
        projectId: "697469d9e381880dc5a9dd54",
        qrId: "4253250956",
    });
    const url = new URL(link);

    assert.equal(url.origin, "https://wa.me");
    assert.equal(url.pathname, "/15551234567");
    assert.equal(
        url.searchParams.get("text"),
        "Hello! I'd like to connect. (Project ID: 697469d9e381880dc5a9dd54) [Ref: 4253250956]"
    );
});

test("does not produce a direct WhatsApp link without a valid phone and QR mapping", () => {
    assert.equal(buildWhatsAppQrLink({ phoneNumber: "123", projectId: "project", qrId: "qr" }), "");
    assert.equal(buildWhatsAppQrLink({ phoneNumber: "15551234567", projectId: "", qrId: "qr" }), "");
});
