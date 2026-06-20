const AISENSY_PARTNER_ID = process.env.AISENSY_PARTNER_ID;
const AISENSY_API_KEY = process.env.AISENSY_API_KEY;
const BASE_DOMAIN = process.env.BASE_DOMAIN;
const APP_DOMAIN = process.env.APP_DOMAIN;
const SITE_NAME = "OneChatting";
const SITE_LOGO = `${BASE_DOMAIN}/logo-main.png`;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const TEMPLATE_CHARGES = {
    marketing: 0.20,
    utility: 0.20,
    authentication: 0.20
};

const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY;
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT;
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM;

export { AISENSY_PARTNER_ID, AISENSY_API_KEY, BASE_DOMAIN, GOOGLE_CLIENT_ID, TEMPLATE_CHARGES, TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM, SITE_NAME, SITE_LOGO, APP_DOMAIN };
