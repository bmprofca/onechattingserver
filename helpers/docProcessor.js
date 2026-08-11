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
        return (data.text || "").trim();
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
 * Download a file from a URL and extract its text content.
 */
export async function fetchAndExtractDocumentText(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            maxContentLength: MAX_FILE_SIZE
        });
        
        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || '';
        
        const parsedUrl = new URL(url);
        let ext = path.extname(parsedUrl.pathname).toLowerCase();
        
        if (!ext || ext === '.txt') {
            if (contentType.includes('pdf')) ext = '.pdf';
            else if (contentType.includes('spreadsheet') || contentType.includes('excel')) ext = '.xlsx';
            else if (contentType.includes('csv')) ext = '.csv';
        }

        if (ext === '.pdf') {
            return await extractPdfText(buffer);
        } else if (['.xlsx', '.xls', '.csv'].includes(ext)) {
            return extractExcelText(buffer, ext);
        } else {
            console.warn(`[DocProcessor] Unsupported extension for text extraction: ${ext}`);
            return "Content could not be extracted (unsupported format).";
        }
    } catch (error) {
        console.error("[DocProcessor] Failed to fetch/extract document:", url, error?.message);
        return "Failed to read document.";
    }
}
