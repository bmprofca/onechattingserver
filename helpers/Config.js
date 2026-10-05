const BASE_DOMAIN = process.env.BASE_DOMAIN;
const APP_DOMAIN = process.env.APP_DOMAIN;
const SITE_NAME = "OneChatting";
const SITE_LOGO = `${BASE_DOMAIN}/logo-main.png`;

const TEMPLATE_CHARGES = {
    marketing: 0.20,
    utility: 0.20,
    authentication: 0.20
};

export {
    BASE_DOMAIN,
    TEMPLATE_CHARGES,
    SITE_NAME,
    SITE_LOGO,
    APP_DOMAIN,
};
