import nodemailer from "nodemailer";
import { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM, SITE_NAME, SITE_LOGO, APP_DOMAIN } from "./Config.js";

const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: !!SMTP_SECURE,
    auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
    }
});

/**
 * Get HTML template for password reset email
 */
function getPasswordResetEmailHtml(resetLink, userName = "User") {
    const siteName = SITE_NAME || "OneChatting";
    const siteLogo = SITE_LOGO || "";
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reset Your Password - ${siteName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f5; padding: 40px 20px;">
        <tr>
            <td align="center">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 480px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);">
                    <tr>
                        <td style="padding: 40px 40px 32px;">
                            <div style="text-align: center; margin-bottom: 24px;">
                                ${siteLogo ? `<img src="${siteLogo}" alt="${siteName}" style="max-width: 160px; max-height: 48px; margin-bottom: 16px;" />` : ""}
                                <h1 style="margin: 0; font-size: 24px; font-weight: 600; color: #18181b;">Reset Your Password</h1>
                            </div>
                            <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #3f3f46;">
                                Hi ${userName},
                            </p>
                            <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #3f3f46;">
                                We received a request to reset your password. Click the button below to choose a new password. This link will expire in <strong>5 minutes</strong>.
                            </p>
                            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                                <tr>
                                    <td align="center" style="padding: 8px 0 24px;">
                                        <a href="${resetLink}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; border-radius: 8px; box-shadow: 0 2px 4px rgba(37, 99, 235, 0.3);">Reset Password</a>
                                    </td>
                                </tr>
                            </table>
                            <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #71717a;">
                                If you didn't request this, you can safely ignore this email. Your password will remain unchanged.
                            </p>
                            <p style="margin: 16px 0 0; font-size: 12px; line-height: 1.5; color: #a1a1aa;">
                                If the button doesn't work, copy and paste this link into your browser:<br>
                                <a href="${resetLink}" style="color: #2563eb; word-break: break-all;">${resetLink}</a>
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 24px 40px; background-color: #fafafa; border-radius: 0 0 12px 12px;">
                            <p style="margin: 0; font-size: 12px; color: #a1a1aa; text-align: center;">
                                &copy; ${new Date().getFullYear()} ${siteName}. All rights reserved.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
`;
}

/**
 * Send password reset email
 * @param {string} to - Recipient email
 * @param {string} resetToken - Token for reset link
 * @param {string} [userName] - User's name for personalization
 * @returns {Promise<boolean>}
 */
export async function sendPasswordResetEmail(to, resetToken, userName = "User") {
    const resetLink = `${APP_DOMAIN.replace(/\/$/, "")}/reset-password/${resetToken}`;
    const html = getPasswordResetEmailHtml(resetLink, userName);

    const siteName = SITE_NAME || "OneChatting";
    const from = SMTP_FROM || (SMTP_USER ? `"${siteName}" <${SMTP_USER}>` : `"${siteName}"`);

    try {
        await transporter.sendMail({
            from,
            to,
            subject: `Reset Your Password - ${siteName}`,
            text: `Hi ${userName}, reset your password by visiting: ${resetLink}. This link expires in 5 minutes.`,
            html
        });
        return true;
    } catch (error) {
        console.error("[email] Failed to send password reset:", error?.message || error);
        return false;
    }
}
