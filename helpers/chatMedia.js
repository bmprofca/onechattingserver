import pool from "../db.js";
import { GET_CHAT_MEDIA_URL } from "./function.js";
import { formatIndianMobileForSend } from "./mobile.js";
import {
    expandTemplateMediaUrls,
    loadTemplateFromDb,
    parseMessageComponent,
} from "./templateStorage.js";

const CHAT_MEDIA_TYPES = ["image", "video", "document", "audio"];
const CHAT_MEDIA_TAB_TYPES = new Set(CHAT_MEDIA_TYPES);

export const resolveChatMediaFilter = (filter) => {
    const normalized = String(filter || "all").toLowerCase();
    return CHAT_MEDIA_TAB_TYPES.has(normalized) ? normalized : "all";
};

export const normalizeChatNumber = (number) => {
    const raw = String(number ?? "").trim();
    if (!raw) return "";

    try {
        return formatIndianMobileForSend(raw);
    } catch {
        const digits = raw.replace(/\D/g, "");
        if (digits.length === 10) return `91${digits}`;
        if (digits.length === 12 && digits.startsWith("91")) return digits;
        return digits;
    }
};

export const parseMediaNumbers = (number, numbers) => {
    const normalized = [];

    const add = (raw) => {
        const value = normalizeChatNumber(raw);
        if (value && !normalized.includes(value)) {
            normalized.push(value);
        }
    };

    if (number !== undefined && number !== null && String(number).trim()) {
        add(number);
    }

    if (Array.isArray(numbers)) {
        numbers.forEach(add);
    } else if (typeof numbers === "string" && numbers.trim()) {
        numbers.split(",").forEach((part) => add(part.trim()));
    }

    return normalized;
};

async function resolveTemplateHeaderMedia(project_id, template_id, component) {
    if (!template_id) return null;

    const storedTemplate = await loadTemplateFromDb(project_id, template_id);
    if (!storedTemplate) return null;

    const template = await expandTemplateMediaUrls(project_id, template_id, storedTemplate);
    const header = (template?.components || []).find((c) => c.type === "HEADER");
    if (!header || !["IMAGE", "VIDEO", "DOCUMENT"].includes(header.format)) {
        return null;
    }

    const componentList = parseMessageComponent(component);
    const componentHeader = componentList.find(
        (c) => String(c.type || "").toLowerCase() === "header"
    );
    const param = componentHeader?.parameters?.[0];

    let media_url = null;
    let media_name = header.format;

    if (param?.image?.link) {
        media_url = param.image.link;
        media_name = "image";
    } else if (param?.video?.link) {
        media_url = param.video.link;
        media_name = "video";
    } else if (param?.document?.link) {
        media_url = param.document.link;
        media_name = param.document.filename || "document";
    } else if (Array.isArray(header.example?.header_handle) && header.example.header_handle[0]) {
        media_url = header.example.header_handle[0];
    } else if (header.example?.header_url) {
        media_url = header.example.header_url;
    }

    if (!media_url) return null;

    const message_type = header.format.toLowerCase();

    return { message_type, media_url, media_name };
}

async function buildChatMediaItem(element, project_id, number) {
    const type = element.type;
    const is_voice = element.is_voice == "1";
    let message_type = element.message_type;
    let media_url = null;
    let media_name = element.file_name || "";

    if (message_type === "image") {
        media_url = await GET_CHAT_MEDIA_URL(project_id, number, "image", element.file_path);
        media_name = element.file_name || "image";
    } else if (message_type === "document") {
        media_url = await GET_CHAT_MEDIA_URL(project_id, number, "document", element.file_path);
        media_name = element.file_name || "document";
    } else if (message_type === "video") {
        media_url = await GET_CHAT_MEDIA_URL(project_id, number, "video", element.file_path);
        media_name = element.file_name || "video";
    } else if (message_type === "audio") {
        media_url = await GET_CHAT_MEDIA_URL(project_id, number, "audio", element.file_path);
        media_name = element.file_name || "audio";
    } else if (message_type === "template") {
        const templateMedia = await resolveTemplateHeaderMedia(
            project_id,
            element.template_id,
            element.component
        );
        if (!templateMedia) return null;
        message_type = templateMedia.message_type;
        media_url = templateMedia.media_url;
        media_name = templateMedia.media_name;
    } else if (message_type === "location") {
        media_url = null;
        media_name = element.location_name || element.location_address || "Location";
    } else {
        return null;
    }

    const item = {
        message_id: element.unique_id,
        wamid: element.wamid,
        id: element.id,
        create_date: element.create_date,
        type,
        direction: type === "in" ? "incoming" : "outgoing",
        message_type,
        message: element.message || "",
        status: element.status,
        is_voice,
        media_url,
        media_name,
    };

    if (message_type === "location") {
        item.address = element.location_address;
        item.latitude = element.latitude;
        item.longitude = element.longitude;
        item.name = element.location_name;
    }

    if (type === "out") {
        item.send_by = {
            username: element.message_by,
            name: element.sender_name,
            mobile: element.sender_mobile
                ? `${element.sender_country_code || ""}${element.sender_mobile}`
                : "",
            email: element.sender_email,
            status: element.sender_status == "1",
        };
    }

    return item;
}

const matchesChatMediaFilter = (item, filter) => {
    if (filter === "all") return true;
    return item.message_type === filter;
};

const getMediaTypeSqlCondition = (filter) => {
    switch (filter) {
        case "image":
            return "messages.message_type IN ('image', 'template')";
        case "video":
            return "messages.message_type IN ('video', 'template')";
        case "document":
            return "messages.message_type IN ('document', 'template')";
        case "audio":
            return "messages.message_type = 'audio'";
        case "all":
        default:
            return "messages.message_type IN ('image', 'video', 'document', 'audio', 'location', 'template')";
    }
};

const buildMediaListFromRows = async (rows, project_id, filter, options = {}) => {
    const { includeContact = false } = options;

    const results = await Promise.all(
        rows.map(async (element) => {
            const rowNumber = normalizeChatNumber(element.number);
            if (!rowNumber) return null;

            const item = await buildChatMediaItem(element, project_id, rowNumber);
            if (!item || !matchesChatMediaFilter(item, filter)) return null;

            const payload = { ...item, number: rowNumber };
            if (includeContact) {
                payload.contact_name = element.contact_name || null;
            }
            return payload;
        })
    );

    return results.filter(Boolean);
};

const parseMediaDateFrom = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} 00:00:00`;
    return raw;
};

const parseMediaDateTo = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} 23:59:59`;
    return raw;
};

export async function queryPaginatedMedia({
    project_id,
    number,
    numbers,
    filter,
    page_no,
    limit,
    includeContact = false,
    search = "",
    date_from = "",
    date_to = "",
}) {
    const typeCondition = getMediaTypeSqlCondition(filter);
    const offset = (page_no - 1) * limit;
    const searchTerm = String(search || "").trim();
    const parsedDateFrom = parseMediaDateFrom(date_from);
    const parsedDateTo = parseMediaDateTo(date_to);
    const normalizedNumbers = parseMediaNumbers(number, numbers);

    if (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) {
        return { error: "Start date cannot be after end date" };
    }

    const whereParts = ["messages.project_id = ?", typeCondition];
    const queryParams = [project_id];

    if (normalizedNumbers.length === 1) {
        whereParts.push("messages.number = ?");
        queryParams.push(normalizedNumbers[0]);
    } else if (normalizedNumbers.length > 1) {
        whereParts.push(`messages.number IN (${normalizedNumbers.map(() => "?").join(", ")})`);
        queryParams.push(...normalizedNumbers);
    }

    if (searchTerm) {
        whereParts.push("(messages.number LIKE ? OR messages.file_name LIKE ? OR contacts.name LIKE ?)");
        const pattern = `%${searchTerm}%`;
        queryParams.push(pattern, pattern, pattern);
    }

    if (parsedDateFrom) {
        whereParts.push("messages.create_date >= ?");
        queryParams.push(parsedDateFrom);
    }

    if (parsedDateTo) {
        whereParts.push("messages.create_date <= ?");
        queryParams.push(parsedDateTo);
    }

    const whereClause = whereParts.join(" AND ");
    const needsContactJoin = includeContact || Boolean(searchTerm);

    const countJoin = needsContactJoin
        ? `LEFT JOIN contacts ON contacts.number = messages.number
            AND contacts.project_id = messages.project_id
            AND contacts.is_deleted = '0'`
        : "";

    const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total FROM messages ${countJoin} WHERE ${whereClause}`,
        queryParams
    );
    const total = Number(countRows[0]?.total) || 0;

    const contactJoin = needsContactJoin
        ? `LEFT JOIN contacts ON contacts.number = messages.number
            AND contacts.project_id = messages.project_id
            AND contacts.is_deleted = '0'`
        : "";
    const contactSelect = needsContactJoin ? "contacts.name AS contact_name," : "";

    const [rows] = await pool.query(
        `SELECT messages.*,
            ${contactSelect}
            users.name AS sender_name,
            users.email AS sender_email,
            users.country_code AS sender_country_code,
            users.mobile AS sender_mobile,
            users.status AS sender_status
         FROM messages
         ${contactJoin}
         LEFT JOIN users ON users.username = messages.message_by
         WHERE ${whereClause}
         ORDER BY messages.id DESC
         LIMIT ? OFFSET ?`,
        [...queryParams, limit, offset]
    );

    const mediaList = await buildMediaListFromRows(rows, project_id, filter, { includeContact: needsContactJoin });
    const total_page = total ? Math.ceil(total / limit) : 0;
    const is_last_page = total_page === 0 ? true : page_no >= total_page;

    return {
        mediaList,
        total,
        total_page,
        is_last_page,
        page_no,
        limit,
        filter,
        search: searchTerm,
        date_from: parsedDateFrom,
        date_to: parsedDateTo,
        numbers: normalizedNumbers,
    };
}
