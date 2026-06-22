import fs from "fs";
import path from "path";
import crypto from "crypto";
import mime from "mime";
import axios from "axios";
import { BASE_DOMAIN } from "./Config.js";

let authCache = null;
let bucketIdCache = null;
const downloadAuthCache = new Map();

const DEFAULT_DOWNLOAD_AUTH_TTL_SECONDS = 86400; // 24 hours
const MAX_DOWNLOAD_AUTH_TTL_SECONDS = 604800; // 7 days (B2 limit)

export function isB2Enabled() {
    return !!(
        process.env.B2_BUCKET &&
        process.env.B2_ACCESS_KEY &&
        process.env.B2_SECRET_KEY
    );
}

export function assertB2Configured() {
    if (!isB2Enabled()) {
        throw new Error("Backblaze B2 storage is not configured. Set B2_BUCKET, B2_ACCESS_KEY, and B2_SECRET_KEY in .env");
    }
}

async function authorizeB2() {
    if (authCache && authCache.expires > Date.now()) {
        return authCache;
    }

    const credentials = Buffer.from(
        `${process.env.B2_ACCESS_KEY}:${process.env.B2_SECRET_KEY}`
    ).toString("base64");

    const { data } = await axios.get(
        "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
        { headers: { Authorization: `Basic ${credentials}` } }
    );

    const downloadUrl = String(data.downloadUrl || "").replace(/\/$/, "");

    authCache = {
        apiUrl: data.apiUrl,
        authToken: data.authorizationToken,
        downloadUrl,
        accountId: data.accountId,
        expires: Date.now() + 22 * 60 * 60 * 1000,
    };

    return authCache;
}

async function getBucketId() {
    if (bucketIdCache) {
        return bucketIdCache;
    }

    const auth = await authorizeB2();
    const { data } = await axios.post(
        `${auth.apiUrl}/b2api/v2/b2_list_buckets`,
        {
            accountId: auth.accountId,
            bucketName: process.env.B2_BUCKET,
        },
        { headers: { Authorization: auth.authToken } }
    );

    const bucket = data.buckets?.find((item) => item.bucketName === process.env.B2_BUCKET)
        || data.buckets?.[0];

    if (!bucket?.bucketId) {
        throw new Error(`B2 bucket not found: ${process.env.B2_BUCKET}`);
    }

    bucketIdCache = bucket.bucketId;
    return bucketIdCache;
}

/** B2 object key prefix for chat media, e.g. chat/{project_id}/{number}/image */
export function getChatMediaKeyPrefix(project_id, number, mediaType) {
    return `chat/${project_id}/${number}/${mediaType}`;
}

export function folderPathToB2KeyPrefix(folderPath) {
    const normalized = folderPath
        .replace(/^\.\//, "")
        .replace(/\\/g, "/")
        .replace(/^media\/chat\//, "chat/")
        .replace(/\/$/, "");

    return normalized.startsWith("chat/") ? normalized : `chat/${normalized}`;
}

export function buildB2ObjectKey(folderPath, fileName) {
    return `${folderPathToB2KeyPrefix(folderPath)}/${fileName}`;
}

export function buildChatMediaObjectKey(project_id, number, mediaType, fileName) {
    return `${getChatMediaKeyPrefix(project_id, number, mediaType)}/${fileName}`;
}

export function getB2PublicBaseUrl() {
    if (process.env.B2_PUBLIC_URL) {
        return process.env.B2_PUBLIC_URL.replace(/\/$/, "");
    }

    if (authCache?.downloadUrl) {
        return `${authCache.downloadUrl}/file/${process.env.B2_BUCKET}`;
    }

    return "";
}

function getDownloadAuthTtlSeconds() {
    const configured = Number(process.env.B2_DOWNLOAD_AUTH_TTL_SECONDS);
    const ttl = Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_DOWNLOAD_AUTH_TTL_SECONDS;

    return Math.min(Math.max(Math.floor(ttl), 60), MAX_DOWNLOAD_AUTH_TTL_SECONDS);
}

function encodeB2FilePath(objectKey) {
    return objectKey.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

async function getDownloadAuthorization(fileNamePrefix) {
    const cacheKey = fileNamePrefix;
    const cached = downloadAuthCache.get(cacheKey);
    if (cached && cached.expires > Date.now() + 60_000) {
        return cached.token;
    }

    const validDurationInSeconds = getDownloadAuthTtlSeconds();
    const auth = await authorizeB2();
    const bucketId = await getBucketId();

    const { data } = await axios.post(
        `${auth.apiUrl}/b2api/v2/b2_get_download_authorization`,
        {
            bucketId,
            fileNamePrefix,
            validDurationInSeconds,
        },
        { headers: { Authorization: auth.authToken } }
    );

    downloadAuthCache.set(cacheKey, {
        token: data.authorizationToken,
        expires: Date.now() + validDurationInSeconds * 1000,
    });

    return data.authorizationToken;
}

async function getSignedB2FileUrl(objectKey) {
    const auth = await authorizeB2();
    const downloadToken = await getDownloadAuthorization(objectKey);
    const encodedPath = encodeB2FilePath(objectKey);

    return `${auth.downloadUrl}/file/${process.env.B2_BUCKET}/${encodedPath}?Authorization=${encodeURIComponent(downloadToken)}`;
}

export function getContentTypeFromExtension(ext) {
    return mime.getType(ext) || "application/octet-stream";
}

export async function uploadBufferToB2(objectKey, buffer, contentType) {
    assertB2Configured();

    const auth = await authorizeB2();
    const bucketId = await getBucketId();

    const { data: uploadData } = await axios.post(
        `${auth.apiUrl}/b2api/v2/b2_get_upload_url`,
        { bucketId },
        { headers: { Authorization: auth.authToken } }
    );

    const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");

    await axios.post(uploadData.uploadUrl, buffer, {
        headers: {
            Authorization: uploadData.authorizationToken,
            "X-Bz-File-Name": encodeURIComponent(objectKey),
            "Content-Type": contentType || "application/octet-stream",
            "X-Bz-Content-Sha1": sha1,
            "Content-Length": buffer.length,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });

    return objectKey;
}

export async function uploadChatMedia(keyPrefix, fileName, buffer, contentType) {
    const objectKey = `${folderPathToB2KeyPrefix(keyPrefix)}/${fileName}`;
    await uploadBufferToB2(objectKey, buffer, contentType);
    return fileName;
}

export async function getTemplateMediaUrl(project_id, template_id, fileName) {
    if (!fileName) {
        return null;
    }

    if (fileName.startsWith("http://") || fileName.startsWith("https://")) {
        return fileName;
    }

    if (!isB2Enabled()) {
        return fileName;
    }

    const objectKey = `${getTemplateMediaKeyPrefix(project_id, template_id)}/${fileName}`;
    return getSignedB2FileUrl(objectKey);
}

export function getTemplateMediaKeyPrefix(project_id, template_id) {
    return `templates/${project_id}/${template_id}`;
}

export async function getChatMediaUrl(project_id, number, mediaType, file_path) {
    if (!file_path) {
        return null;
    }

    if (file_path.startsWith("http://") || file_path.startsWith("https://")) {
        return file_path;
    }

    if (isB2Enabled()) {
        const objectKey = `chat/${project_id}/${number}/${mediaType}/${file_path}`;
        return getSignedB2FileUrl(objectKey);
    }

    const localPath = path.join(process.cwd(), "media", "chat", project_id, String(number), mediaType, file_path);
    if (fs.existsSync(localPath)) {
        return `${BASE_DOMAIN}/chat-media/${project_id}/${number}/${mediaType}/${file_path}`;
    }

    return `${BASE_DOMAIN}/chat-media/${project_id}/${number}/${mediaType}/${file_path}`;
}

/** Warm B2 auth on server startup so public URLs resolve immediately. */
export async function initB2Storage() {
    if (!isB2Enabled()) {
        return false;
    }

    await authorizeB2();
    return true;
}
