import axios from "axios";
import { PDFParse } from "pdf-parse";
import XLSX from "xlsx";
import path from "path";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Extract plain text from a PDF buffer.
 */
async function extractPdfText(buffer) {
    let parser;
    try {
        parser = new PDFParse({ data: buffer });
        const data = await parser.getText();
        const text = (data.text || "").trim();
        console.log(`[DocProcessor] PDF text extracted: ${text.length} chars`);
        if (text.length > 0) {
            console.log(`[DocProcessor] PDF text preview: "${text.substring(0, 200)}..."`);
        }
        return text;
    } catch (error) {
        console.error("[DocProcessor] PDF text extraction failed:", error?.message || error);
        return "";
    } finally {
        await parser?.destroy();
    }
}

/**
 * Extract plain text from an Excel / CSV buffer.
 */
function extractExcelText(buffer, ext) {
    try {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const textParts = [];

        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            if (!sheet) continue;

            const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
            if (rows.length === 0) continue;

            textParts.push(`[Sheet: ${sheetName}]`);

            for (const row of rows) {
                const line = row.map((cell) => String(cell ?? "").trim()).join(" | ");
                if (line.replace(/[| ]/g, "").length > 0) {
                    textParts.push(line);
                }
            }
            textParts.push("");
        }

        return textParts.join("\n").trim();
    } catch (error) {
        console.error("[DocProcessor] Excel text extraction failed:", error?.message || error);
        return "";
    }
}

/**
 * Detect file extension from multiple sources: URL path, content-type header,
 * original fileName hint, and raw buffer magic bytes. Returns a normalised
 * lowercase extension like ".pdf", ".xlsx", etc.
 */
function detectExtension(urlString, contentType, fileNameHint, buffer) {
    // 1. Try URL path extension
    try {
        const parsedUrl = new URL(urlString);
        const urlExt = path.extname(parsedUrl.pathname).toLowerCase();
        if (urlExt && urlExt !== '.txt' && urlExt.length <= 5) {
            return urlExt;
        }
    } catch (_) { /* ignore URL parse errors */ }

    // 2. Try the original fileName hint (from the context JSON metadata)
    if (fileNameHint) {
        const hintExt = path.extname(fileNameHint).toLowerCase();
        if (hintExt && hintExt !== '.txt' && hintExt.length <= 5) {
            return hintExt;
        }
    }

    // 3. Try content-type header
    const ct = (contentType || "").toLowerCase();
    if (ct.includes("pdf")) return ".pdf";
    if (ct.includes("spreadsheet") || ct.includes("excel") || ct.includes("officedocument.spreadsheet")) return ".xlsx";
    if (ct.includes("csv") || ct.includes("comma-separated")) return ".csv";

    // 4. Fallback: check PDF magic bytes (%PDF)
    if (buffer && buffer.length >= 4) {
        const magic = buffer.slice(0, 5).toString("ascii");
        if (magic.startsWith("%PDF")) {
            console.log("[DocProcessor] Detected PDF via magic bytes");
            return ".pdf";
        }
    }

    // 5. Check for Excel/ZIP magic bytes (PK header)
    if (buffer && buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B) {
        // Could be xlsx (which is a ZIP archive)
        return ".xlsx";
    }

    return "";
}

/**
 * Download a file from a URL and extract its text content.
 * @param {string} url - The URL to download the file from
 * @param {string} [fileNameHint] - Optional original file name for extension detection
 */
export async function fetchAndExtractDocumentText(url, fileNameHint) {
    try {
        console.log(`[DocProcessor] Fetching document: ${url} (hint: ${fileNameHint || "none"})`);

        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            maxContentLength: MAX_FILE_SIZE
        });
        
        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || '';

        console.log(`[DocProcessor] Downloaded ${buffer.length} bytes, content-type: "${contentType}"`);
        
        const ext = detectExtension(url, contentType, fileNameHint, buffer);
        console.log(`[DocProcessor] Detected extension: "${ext}"`);

        if (ext === '.pdf') {
            return await extractPdfText(buffer);
        } else if (['.xlsx', '.xls', '.csv'].includes(ext)) {
            return extractExcelText(buffer, ext);
        } else {
            console.warn(`[DocProcessor] Unsupported or undetected extension: "${ext}" for URL: ${url}`);
            // Last resort: try PDF parsing anyway if we couldn't determine the type
            // Many document URLs don't have proper extensions
            const magicStr = buffer.slice(0, 5).toString("ascii");
            if (magicStr.startsWith("%PDF")) {
                console.log("[DocProcessor] Attempting PDF extraction as last resort (magic bytes match)");
                return await extractPdfText(buffer);
            }
            return "Content could not be extracted (unsupported format).";
        }
    } catch (error) {
        console.error("[DocProcessor] Failed to fetch/extract document:", url, error?.message);
        return "Failed to read document.";
    }
}
