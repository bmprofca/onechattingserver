import express from "express";
import { auth } from "../middleware/auth.js";
import { RANDOM_STRING } from "../helpers/function.js";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { BASE_DOMAIN } from "../helpers/Config.js";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

const router = express.Router();

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SINGLE folder for everything
const uploadPath = path.join(__dirname, "../media/upload/temp");
fs.mkdirSync(uploadPath, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadPath); // Save here only
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, RANDOM_STRING(30) + ext);
    }
});

const allowedExtensions = [
    "jpg",
    "jpeg",
    "png",
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "txt",
    "csv",
    "mp4",
    "mp3",
    "aac",
    "amr",
    "wav",
    "ogg",
    "opus",
    "webm"
];

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(".", "");
    if (allowedExtensions.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error("Unsupported file type for WhatsApp: " + ext));
    }
};

const upload = multer({ storage, fileFilter });

// ---- ffmpeg helpers ----
const getFileMetadata = (filePath) => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata);
        });
    });
};

const convertFile = (inputPath, outputPath, format) => {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .toFormat(format)
            .on("end", () => resolve(outputPath))
            .on("error", (err) => reject(err))
            .save(outputPath);
    });
};

// Decide if WebM is audio or video
const checkWebMType = async (filePath) => {
    const metadata = await getFileMetadata(filePath);

    const hasVideo = metadata.streams.some((s) => s.codec_type === "video");
    const hasAudio = metadata.streams.some((s) => s.codec_type === "audio");

    if (hasVideo) return "video";
    if (hasAudio) return "audio";

    throw new Error("Unable to determine WebM file type");
};

// Process WebM inside SAME folder
const processWebMFile = async (filePath, tempFilename, mimetype) => {
    // First use mimetype (JS-only check)
    let fileType = null;
    if (mimetype && mimetype.startsWith("audio/")) {
        fileType = "audio";
    } else if (mimetype && mimetype.startsWith("video/")) {
        fileType = "video";
    }

    // Fallback to ffprobe if mimetype is not clear
    if (!fileType) {
        fileType = await checkWebMType(filePath);
    }

    const baseName = path.parse(tempFilename).name; // remove .webm
    let targetExt, targetFormat;

    if (fileType === "audio") {
        targetExt = ".mp3";
        targetFormat = "mp3";
    } else {
        targetExt = ".mp4";
        targetFormat = "mp4";
    }

    const newFilename = baseName + targetExt;
    const outputPath = path.join(uploadPath, newFilename);

    // Convert .webm -> .mp3 / .mp4 in SAME folder
    await convertFile(filePath, outputPath, targetFormat);

    // Delete original .webm
    fs.unlinkSync(filePath);

    return newFilename;
};

router.post("/upload-media", auth, (req, res) => {
    upload.single("file")(req, res, async (err) => {
        if (err) {
            console.error("Multer error:", err);
            return res.status(200).json({ error: "Invalid file type or upload failed" });
        }

        if (!req.file) {
            return res.status(200).json({ error: "File not set" });
        }

        try {
            let finalFilename = req.file.filename;
            const filePath = req.file.path; // ../media/upload/temp/<rand>.ext
            const ext = path.extname(req.file.originalname).toLowerCase();

            // If original file is .webm
            if (ext === ".webm") {
                try {
                    finalFilename = await processWebMFile(
                        filePath,
                        req.file.filename,
                        req.file.mimetype
                    );
                } catch (conversionError) {
                    console.error("WebM processing error:", conversionError);
                    // On failure, keep original .webm (already in same folder)
                    finalFilename = req.file.filename;
                }
            }

            return res.status(200).json({
                error: false,
                // adjust this URL if your static path includes /temp/
                link: `${BASE_DOMAIN}/upload/${finalFilename}`
                // or: `${BASE_DOMAIN}/upload/temp/${finalFilename}` if that's how you serve it
            });
        } catch (error) {
            console.error("Upload processing error:", error);
            return res.status(200).json({ error: "File processing failed" });
        }
    });
});

export default router;
