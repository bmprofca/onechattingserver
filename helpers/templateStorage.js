import fs from "fs";
import path from "path";
import axios from "axios";
import { fileURLToPath } from "url";
import pool from "../db.js";
import { RANDOM_STRING } from "./function.js";
import {
    getContentTypeFromExtension,
    getTemplateMediaKeyPrefix,
    getTemplateMediaUrl,
    isB2Enabled,
    uploadBufferToB2,
} from "./b2Storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_TEMPLATE_DIR = path.join(__dirname, "../media/templates");
const MEDIA_HEADER_FORMATS = new Set(["IMAGE", "VIDEO", "DOCUMENT"]);

function parseJsonValue(value) {
    if (!value) {
        return {};
    }
    if (typeof value === "object") {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
}

function loadLegacyTemplateFile(template_id) {
    const filePath = path.join(LEGACY_TEMPLATE_DIR, `${template_id}.json`);
    if (!fs.existsSync(filePath)) {
        return {};
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function parseTemplateJsonFromRow(row, template_id = "") {
    const parsed = parseJsonValue(row?.template_json);
    if (parsed && Object.keys(parsed).length > 0) {
        return parsed;
    }
    if (template_id) {
        return loadLegacyTemplateFile(template_id);
    }
    return {};
}

export async function loadTemplateFromDb(project_id, template_id) {
    const [rows] = await pool.query(
        "SELECT template_json FROM templates WHERE project_id = ? AND template_id = ? LIMIT 1",
        [project_id, template_id]
    );

    if (rows.length > 0) {
        return parseTemplateJsonFromRow(rows[0], template_id);
    }

    return loadLegacyTemplateFile(template_id);
}

function isRemoteUrl(value) {
    return typeof value === "string"
        && (value.startsWith("http://") || value.startsWith("https://"));
}

function fileNameFromUrl(url) {
    try {
        const base = path.basename(new URL(url).pathname);
        if (base) {
            return base;
        }
    } catch {
        // fall through
    }
    return `${RANDOM_STRING(20)}.bin`;
}

async function downloadToBuffer(url) {
    const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 60000,
        maxRedirects: 10,
        validateStatus: (status) => status >= 200 && status < 300,
    });
    return Buffer.from(response.data);
}

function buildMediaDownloadCandidates(mediaRef) {
    if (!isRemoteUrl(mediaRef)) {
        return [];
    }

    const fileName = fileNameFromUrl(mediaRef);
    const candidates = [mediaRef];

    try {
        const parsed = new URL(mediaRef);
        const uploadBase = process.env.UPLOAD_MEDIA_BASE_URL || "https://api.w1chat.com/upload";
        candidates.push(`${uploadBase.replace(/\/$/, "")}/${fileName}`);
        candidates.push(`https://upload.onesaas.in/api/upload/${fileName}`);
    } catch {
        // ignore
    }

    return [...new Set(candidates)];
}

async function downloadToBufferWithFallback(url) {
    const candidates = buildMediaDownloadCandidates(url);
    let lastError;

    for (const candidate of candidates) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                return await downloadToBuffer(candidate);
            } catch (err) {
                lastError = err;
                if (attempt < 3) {
                    await new Promise((r) => setTimeout(r, attempt * 1000));
                }
            }
        }
    }

    throw lastError || new Error(`Failed to download media: ${url}`);
}

async function persistTemplateMedia(project_id, template_id, mediaRef) {
    if (!mediaRef || typeof mediaRef !== "string") {
        return mediaRef;
    }

    if (!isRemoteUrl(mediaRef)) {
        return mediaRef;
    }

    const buffer = await downloadToBufferWithFallback(mediaRef);
    const fileName = fileNameFromUrl(mediaRef);
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const objectKey = `${getTemplateMediaKeyPrefix(project_id, template_id)}/${fileName}`;

    if (isB2Enabled()) {
        await uploadBufferToB2(objectKey, buffer, getContentTypeFromExtension(ext));
    }

    return fileName;
}

async function mapHeaderHandles(project_id, template_id, handles, mapper) {
    if (!Array.isArray(handles)) {
        return handles;
    }

    const mapped = [];
    for (const handle of handles) {
        mapped.push(await mapper(handle));
    }
    return mapped;
}

/** Download remote header media and store on B2; DB JSON keeps filenames only. */
export async function processTemplateMediaForStorage(project_id, template_id, template) {
    const storageTemplate = JSON.parse(JSON.stringify(template || {}));
    const components = storageTemplate.components;

    if (!Array.isArray(components)) {
        return storageTemplate;
    }

    for (const component of components) {
        if (component?.type !== "HEADER" || !MEDIA_HEADER_FORMATS.has(component?.format)) {
            continue;
        }

        if (component.example?.header_handle) {
            component.example.header_handle = await mapHeaderHandles(
                project_id,
                template_id,
                component.example.header_handle,
                (handle) => persistTemplateMedia(project_id, template_id, handle)
            );
        }

        if (component.example?.header_url) {
            component.example.header_url = await persistTemplateMedia(
                project_id,
                template_id,
                component.example.header_url
            );
        }
    }

    return storageTemplate;
}

/** Convert remote header media URLs to filenames only (no download). */
export function normalizeTemplateMediaToFilenames(template) {
    const normalized = JSON.parse(JSON.stringify(template || {}));
    const components = normalized.components;

    if (!Array.isArray(components)) {
        return normalized;
    }

    for (const component of components) {
        if (component?.type !== "HEADER" || !MEDIA_HEADER_FORMATS.has(component?.format)) {
            continue;
        }

        if (Array.isArray(component.example?.header_handle)) {
            component.example.header_handle = component.example.header_handle.map((handle) =>
                isRemoteUrl(handle) ? fileNameFromUrl(handle) : handle
            );
        }

        if (isRemoteUrl(component.example?.header_url)) {
            component.example.header_url = fileNameFromUrl(component.example.header_url);
        }
    }

    return normalized;
}

/** Replace stored filenames with signed B2 URLs for API responses / Meta. */
export async function expandTemplateMediaUrls(project_id, template_id, template) {
    const expanded = JSON.parse(JSON.stringify(template || {}));
    const components = expanded.components;

    if (!Array.isArray(components)) {
        return expanded;
    }

    for (const component of components) {
        if (component?.type !== "HEADER" || !MEDIA_HEADER_FORMATS.has(component?.format)) {
            continue;
        }

        if (component.example?.header_handle) {
            component.example.header_handle = await mapHeaderHandles(
                project_id,
                template_id,
                component.example.header_handle,
                (handle) => getTemplateMediaUrl(project_id, template_id, handle)
            );
        }

        if (component.example?.header_url) {
            component.example.header_url = await getTemplateMediaUrl(
                project_id,
                template_id,
                component.example.header_url
            );
        }
    }

    return expanded;
}

export function serializeTemplateJson(template) {
    return JSON.stringify(template || {});
}

export function parseMessageComponent(component) {
    if (!component) {
        return [];
    }
    if (Array.isArray(component)) {
        return component;
    }
    if (typeof component === "string") {
        try {
            const parsed = JSON.parse(component);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

function applyBodyParameters(bodyText, bodyParams) {
    const text = String(bodyText || "");
    if (!text) {
        return "";
    }

    const matches = text.match(/\{\{\d+\}\}/g) || [];
    return matches.reduce((acc, ph, idx) => {
        const val = bodyParams[idx]?.text ?? "";
        return acc.replace(ph, val);
    }, text);
}

export function buildTemplateDisplayMessage(template, component) {
    const templateData = template && typeof template === "object" ? template : {};
    const components = templateData.components;

    if (!Array.isArray(components)) {
        return "";
    }

    const componentList = parseMessageComponent(component);
    const category = String(templateData.category || "").toUpperCase();
    const bodyComponent = components.find((c) => c.type === "BODY");
    const bodyParams = componentList.find(
        (c) => String(c.type || "").toLowerCase() === "body"
    )?.parameters || [];

    if (category === "AUTHENTICATION") {
        if (bodyComponent?.text) {
            return applyBodyParameters(bodyComponent.text, bodyParams);
        }

        const code = bodyParams[0]?.text ?? "";
        if (!code) {
            return "";
        }

        let text = `${code} is your verification code.`;
        if (bodyComponent?.add_security_recommendation) {
            text += " For your security, do not share this code.";
        }
        return text;
    }

    return applyBodyParameters(bodyComponent?.text || "", bodyParams);
}

export function buildTemplateDisplayFooter(template) {
    const components = template?.components;
    if (!Array.isArray(components)) {
        return "";
    }

    const footerComponent = components.find((c) => c.type === "FOOTER");
    if (!footerComponent) {
        return "";
    }

    if (footerComponent.text) {
        return String(footerComponent.text);
    }

    if (footerComponent.code_expiration_minutes != null) {
        const minutes = Number(footerComponent.code_expiration_minutes);
        if (Number.isFinite(minutes) && minutes >= 1) {
            return `This code expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
        }
    }

    return "";
}
