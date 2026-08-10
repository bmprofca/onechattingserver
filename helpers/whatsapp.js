import axios from 'axios';

import { ONECHATTING_SEND_URL, ONECHATTING_SEND_TOKEN } from './Config.js';
import { formatIndianMobileForSend } from './mobile.js';

const templates = {
    otp: () => import('../whatsappTemplates/otpTemplate.js'),
};

const loadTemplate = async (name) => {
    const importer = templates[name];

    if (!importer) {
        throw new Error(`Unknown WhatsApp template: ${name}`);
    }

    const module = await importer();
    return module.default ?? module;
};

const normalizeParams = (params) => {
    if (Array.isArray(params)) {
        return params.map((value) => String(value ?? '').trim()).filter(Boolean);
    }
    return [String(params ?? '').trim()].filter(Boolean);
};

const buildComponents = (template, values, headerMedia = {}) => {
    const components = [];
    const templateComponents = template?.template?.components ?? [];

    const body = templateComponents.find(
        c => c.type === 'BODY'
    );

    if (body) {
        const count =
            (body.text?.match(/\{\{\d+\}\}/g) ?? []).length;

        components.push({
            type: 'body',
            parameters: values
                .slice(0, count || values.length)
                .map(value => ({
                    type: 'text',
                    text: String(value),
                })),
        });
    }

    return components;
};

export const formatWhatsAppMobile = formatIndianMobileForSend;

const postTemplateMessage = async (url, payload, token) =>
    axios.post(url, payload, {
        headers: {
            token,
            'Content-Type': 'application/json',
        },
    });

const sendTemplateMessage = async ({ templateName, mobile, params = [], headerMedia, }) => {
    const token = String(ONECHATTING_SEND_TOKEN ?? '').trim();

    if (!token) {
        throw new Error('ONECHATTING_TEMPLATE_TOKEN is required');
    }

    const template = await loadTemplate(templateName);
    const normalizedMobile = formatIndianMobileForSend(mobile);

    const templateParams = normalizeParams(params);
    const payload = {
        number: normalizedMobile,
        template_id: template.template_id,
        component: buildComponents(
            template,
            templateParams,
            headerMedia
        ),
    };

    let lastError = null;

    try {
        const response = await postTemplateMessage(
            ONECHATTING_SEND_URL,
            payload,
            token
        );

        return response.data;
    } catch (error) {
        console.error(error.response?.status);
        console.dir(error.response?.data, {
            depth: null
        });

        console.log(error.response?.headers);
        throw error;
    }

    throw lastError ?? new Error('Failed to send WhatsApp template message');
};

export const sendOtpWhatsApp = async (mobile, otp) => {

    return sendTemplateMessage({
        templateName: 'otp',
        mobile: mobile,
        params: [otp],
    });
};

export default {
    sendOtpWhatsApp,
};
