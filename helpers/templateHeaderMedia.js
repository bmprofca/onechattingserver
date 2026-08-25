import axios from "axios";
import fs from "fs/promises";
import os from "os";
import path from "path";
import FormData from "form-data";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import OpenAI from "openai";

const UPLOAD_URL = process.env.TEMPLATE_MEDIA_UPLOAD_URL || "https://upload.onesaas.in/api/upload";
const UPLOAD_KEY = process.env.TEMPLATE_MEDIA_UPLOAD_KEY || "onedevelopers";

function escapePdfText(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function createPdf(lines) {
    const content = ["BT", "/F1 18 Tf", "50 760 Td", ...lines.flatMap((line, index) => [index ? "0 -28 Td" : "", `(${escapePdfText(line)}) Tj`]), "ET"].join("\n");
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => { offsets[index + 1] = Buffer.byteLength(pdf, "utf8"); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf, "utf8");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf, "utf8");
}

async function uploadBuffer(buffer, filename, contentType) {
    const form = new FormData();
    form.append("file", buffer, { filename, contentType });
    const response = await axios.post(UPLOAD_URL, form, { headers: { ...form.getHeaders(), key: UPLOAD_KEY }, maxBodyLength: Infinity, maxContentLength: Infinity });
    if (!response.data?.success || !response.data?.url) throw new Error(response.data?.message || "Generated media upload failed");
    return response.data.url;
}

async function fetchImageBuffer(urlOrBase64) {
    if (!urlOrBase64) return null;
    if (urlOrBase64.startsWith("data:")) {
        const base64Data = urlOrBase64.split(",")[1] || urlOrBase64;
        const mimeMatch = urlOrBase64.match(/^data:([^;]+);base64,/);
        return {
            buffer: Buffer.from(base64Data, "base64"),
            mimeType: mimeMatch ? mimeMatch[1] : "image/png"
        };
    }
    if (urlOrBase64.startsWith("http://") || urlOrBase64.startsWith("https://")) {
        const resp = await axios.get(urlOrBase64, { responseType: "arraybuffer" });
        return {
            buffer: Buffer.from(resp.data),
            mimeType: resp.headers["content-type"] || "image/png"
        };
    }
    return null;
}

async function generateImage({ apiKey, provider, prompt, referenceImageUrl, referenceImageBuffer }) {
    if (!apiKey) throw new Error("An active AI project key is required to generate header media");
    
    // Fetch reference image if provided
    let refImage = null;
    if (referenceImageBuffer) {
        refImage = {
            buffer: Buffer.isBuffer(referenceImageBuffer) ? referenceImageBuffer : Buffer.from(referenceImageBuffer, "base64"),
            mimeType: "image/png"
        };
    } else if (referenceImageUrl) {
        try {
            refImage = await fetchImageBuffer(referenceImageUrl);
        } catch (e) {
            console.warn("[templateHeaderMedia] Failed to fetch reference image:", e.message);
        }
    }

    if (provider === "gemini") {
        const configuredModel = process.env.GEMINI_IMAGE_MODEL;
        const models = configuredModel ? [configuredModel] : ["gemini-2.5-flash-image", "gemini-3.1-flash-image"];
        let lastError;
        for (const model of models) {
            try {
                const parts = [];
                if (refImage?.buffer) {
                    parts.push({
                        inlineData: {
                            mimeType: refImage.mimeType || "image/png",
                            data: refImage.buffer.toString("base64")
                        }
                    });
                }
                parts.push({ text: prompt });

                const response = await axios.post(
                    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`,
                    {
                        contents: [{ parts }],
                        generationConfig: { responseModalities: ["IMAGE"] },
                    },
                    { headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" } },
                );
                const resParts = response.data?.candidates?.[0]?.content?.parts || [];
                const imagePart = resParts.find((part) => part.inlineData?.data || part.inline_data?.data);
                const imageData = imagePart?.inlineData?.data || imagePart?.inline_data?.data;
                if (imageData) return Buffer.from(imageData, "base64");
                lastError = new Error(`Gemini model ${model} did not return an image`);
            } catch (error) {
                lastError = error;
            }
        }
        const providerMessage = lastError?.response?.data?.error?.message;
        throw new Error(providerMessage || lastError?.message || "Gemini did not return an image");
    }
    if (provider === "openai") {
        const client = new OpenAI({ apiKey });
        const response = await client.images.generate({ model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1", prompt, size: "1024x1024", quality: "low" });
        const image = response.data?.[0];
        if (image?.b64_json) return Buffer.from(image.b64_json, "base64");
        if (image?.url) return (await axios.get(image.url, { responseType: "arraybuffer" })).data;
    }
    throw new Error(`The ${provider || "selected"} AI provider does not have image generation configured`);
}

async function createVideo(imageBuffer, directory, filename) {
    const input = path.join(directory, "header.png");
    const output = path.join(directory, filename);
    await fs.writeFile(input, imageBuffer);
    await new Promise((resolve, reject) => ffmpeg(input).setFfmpegPath(ffmpegPath).inputOptions(["-loop 1"]).videoCodec("libx264").outputOptions(["-t 4", "-pix_fmt yuv420p", "-movflags +faststart"]).size("720x720").on("end", resolve).on("error", reject).save(output));
    return fs.readFile(output);
}

export async function generateTemplateHeaderMedia({ apiKey, provider, format, prompt, headerPrompt, body, headerText, referenceImageUrl, referenceImageBuffer }) {
    const normalizedFormat = String(format || "").toUpperCase();
    if (!["IMAGE", "VIDEO", "DOCUMENT"].includes(normalizedFormat)) throw new Error("Unsupported header media format");
    
    const visualSubject = headerPrompt || prompt;
    let visualPrompt = `Create a clean, brand-safe WhatsApp header visual related to: ${visualSubject}. Message context: ${body || headerText || "customer communication"}. Centered composition, high aesthetic appeal, suitable for a WhatsApp business message header.`;
    if (referenceImageUrl || referenceImageBuffer) {
        visualPrompt += ` Seamlessly integrate and reference the provided logo / reference branding into the header image aesthetic, keeping the branding prominent and clean.`;
    }

    const imageBuffer = await generateImage({
        apiKey,
        provider,
        prompt: visualPrompt,
        referenceImageUrl,
        referenceImageBuffer
    });

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "template-header-"));
    try {
        if (normalizedFormat === "IMAGE") return { url: await uploadBuffer(imageBuffer, "ai-header.png", "image/png"), filename: "ai-header.png", mime_type: "image/png" };
        if (normalizedFormat === "VIDEO") {
            const video = await createVideo(imageBuffer, directory, "ai-header.mp4");
            return { url: await uploadBuffer(video, "ai-header.mp4", "video/mp4"), filename: "ai-header.mp4", mime_type: "video/mp4" };
        }
        const document = createPdf([headerText || "AI generated header", "", ...String(body || visualSubject).match(/.{1,78}(?:\s|$)/g)?.slice(0, 18) || []]);
        return { url: await uploadBuffer(document, "ai-header.pdf", "application/pdf"), filename: "ai-header.pdf", mime_type: "application/pdf" };
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

