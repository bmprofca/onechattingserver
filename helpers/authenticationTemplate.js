import { parseMessageComponent } from "./templateStorage.js";

export function normalizeAuthenticationTemplate(template) {
    const bodySource = template.components?.find((c) => c.type === "BODY") || {};
    const footerSource = template.components?.find((c) => c.type === "FOOTER");
    const buttonsSource = template.components?.find((c) => c.type === "BUTTONS");
    const otpBtn = buttonsSource?.buttons?.find(
        (b) => b.type === "OTP" || b.type === "otp" || b.otp_type
    ) || {};

    const otpType = String(otpBtn.otp_type || "COPY_CODE").toUpperCase();
    const normalizedOtp = {
        type: "OTP",
        otp_type: otpType,
    };

    if (otpType === "COPY_CODE" && otpBtn.text) {
        normalizedOtp.text = String(otpBtn.text).trim();
    }
    if ((otpType === "ONE_TAP" || otpType === "ZERO_TAP") && Array.isArray(otpBtn.supported_apps)) {
        normalizedOtp.supported_apps = otpBtn.supported_apps;
    }

    const components = [];
    const body = { type: "BODY" };

    if (bodySource.add_security_recommendation) {
        body.add_security_recommendation = true;
    }
    components.push(body);

    if (footerSource?.code_expiration_minutes != null) {
        const minutes = Number(footerSource.code_expiration_minutes);
        if (minutes >= 1 && minutes <= 90) {
            components.push({
                type: "FOOTER",
                code_expiration_minutes: minutes,
            });
        }
    }

    components.push({
        type: "BUTTONS",
        buttons: [normalizedOtp],
    });

    return {
        name: template.name,
        language: template.language,
        category: "AUTHENTICATION",
        components,
    };
}

export function validateAuthenticationTemplate(template) {
    if (template?.category !== "AUTHENTICATION") {
        return { valid: true, template };
    }

    if (!Array.isArray(template.components) || template.components.length === 0) {
        return { valid: false, error: "Authentication template requires components" };
    }

    if (template.components.some((c) => c.type === "HEADER")) {
        return { valid: false, error: "Authentication templates cannot include a HEADER component" };
    }

    if (!template.components.some((c) => c.type === "BODY")) {
        return { valid: false, error: "Authentication template requires a BODY component" };
    }

    const bodyComponent = template.components.find((c) => c.type === "BODY");
    const bodyText = String(bodyComponent?.text || "").trim();

    if (bodyText) {
        return { valid: false, error: "Authentication templates use a predefined message format and cannot include custom body text" };
    }

    if (bodyComponent?.example?.body_text?.length) {
        return { valid: false, error: "Authentication templates cannot include custom body variable samples" };
    }

    const footerComponent = template.components.find((c) => c.type === "FOOTER");
    if (footerComponent?.text) {
        return { valid: false, error: "Authentication templates cannot include custom footer text; use code expiration instead" };
    }
    if (footerComponent?.code_expiration_minutes != null) {
        const minutes = Number(footerComponent.code_expiration_minutes);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 90) {
            return { valid: false, error: "Code expiration must be between 1 and 90 minutes" };
        }
    }

    const buttonsComponent = template.components.find((c) => c.type === "BUTTONS");
    const otpButtons = (buttonsComponent?.buttons || []).filter(
        (b) => b.type === "OTP" || b.type === "otp" || b.otp_type
    );

    if (otpButtons.length !== 1) {
        return { valid: false, error: "Authentication template must have exactly one OTP button" };
    }

    const otpType = String(otpButtons[0].otp_type || "COPY_CODE").toUpperCase();
    if (otpType === "COPY_CODE" && !String(otpButtons[0].text || "").trim()) {
        return { valid: false, error: "Copy Code button label is required" };
    }

    return { valid: true, template: normalizeAuthenticationTemplate(template) };
}

export function normalizeAuthenticationSendComponents(component, template) {
    const list = parseMessageComponent(component);

    if (!Array.isArray(list) || list.length === 0) {
        return { valid: false, error: "Authentication template requires component array with OTP code" };
    }

    const bodyComp = list.find((c) => String(c.type || "").toLowerCase() === "body");
    if (!bodyComp) {
        return { valid: false, error: "Authentication template requires a body component" };
    }

    const params = bodyComp.parameters;
    if (!Array.isArray(params) || params.length === 0) {
        return { valid: false, error: "Authentication template requires OTP code in body.parameters" };
    }

    const code = String(params[0]?.text ?? "").trim();
    if (!code) {
        return { valid: false, error: "OTP code is required in body.parameters[0].text" };
    }
    if (!/^\d{4,8}$/.test(code)) {
        return { valid: false, error: "OTP code must be 4–8 digits" };
    }

    const normalized = list.map((item) => {
        if (String(item.type || "").toLowerCase() !== "body") {
            return item;
        }
        return {
            ...item,
            type: "body",
            parameters: [{ type: "text", text: code }],
        };
    });

    const buttonsComponent = template?.components?.find((c) => c.type === "BUTTONS");
    const otpBtn = buttonsComponent?.buttons?.find(
        (b) => b.type === "OTP" || b.type === "otp" || b.otp_type
    );
    const otpType = String(otpBtn?.otp_type || "COPY_CODE").toUpperCase();

    if (otpType === "COPY_CODE") {
        const hasButton = normalized.some((c) => String(c.type || "").toLowerCase() === "button");
        if (!hasButton) {
            normalized.push({
                type: "button",
                sub_type: "url",
                index: "0",
                parameters: [{ type: "text", text: code }],
            });
        }
    }

    return { valid: true, component: normalized };
}
