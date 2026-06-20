
import fs from "fs";
import path from "path";
import { fileTypeFromBuffer } from "file-type";
import { GetAiSensyProjectToken, RANDOM_STRING } from "./function.js";
import axios from "axios";

async function SaveMedia(projectid, mediaId, folderPath) {

    const AiSensyToken = await GetAiSensyProjectToken(projectid);

    try {
        var obj = await axios.post(
            "https://backend.aisensy.com/direct-apis/t1/get-media",
            {
                id: mediaId
            },
            {
                headers: {
                    Accept: "application/json",
                    Authorization: "Bearer " + AiSensyToken,
                    "Content-Type": "application/json"
                },
                timeout: 30000, // optional, same as CURLOPT_TIMEOUT
                maxRedirects: 10 // same as CURLOPT_MAXREDIRS
            }
        );
    } catch (error) {
        console.log(`Error on getting buffer image of projectid ${projectid}, mediaId ${mediaId}, folder path ${folderPath}`);
        console.error(error)
        return false;
    }

    const buffer = Buffer.from(obj.data);

    // Detect file type
    const type = await fileTypeFromBuffer(buffer);
    if (!type) {
        console.log(`Unknown file type of projectid ${projectid}, mediaId ${mediaId}, folder path ${folderPath}`);
        return false;
    }

    // Ensure folder exists
    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
    }

    // Generate unique filename with timestamp
    const filename = `${RANDOM_STRING(15)}.${type.ext}`;
    const filePath = path.join(folderPath, filename);

    // Save file
    await fs.promises.writeFile(filePath, buffer);

    return filename;
}

export { SaveMedia };