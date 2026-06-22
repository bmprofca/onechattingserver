import { fileTypeFromBuffer } from "file-type";
import axios from "axios";
import { GetAiSensyProjectToken, RANDOM_STRING } from "./function.js";
import { uploadChatMedia } from "./b2Storage.js";

async function SaveMedia(projectid, mediaId, keyPrefix) {
    const AiSensyToken = await GetAiSensyProjectToken(projectid);

    let obj;
    try {
        obj = await axios.post(
            "https://backend.aisensy.com/direct-apis/t1/get-media",
            { id: mediaId },
            {
                headers: {
                    Accept: "application/json",
                    Authorization: "Bearer " + AiSensyToken,
                    "Content-Type": "application/json",
                },
                timeout: 30000,
                maxRedirects: 10,
            }
        );
    } catch (error) {
        console.log(`Error on getting media: projectid=${projectid}, mediaId=${mediaId}, keyPrefix=${keyPrefix}`);
        console.error(error);
        return false;
    }

    const buffer = Buffer.from(obj.data?.data ?? obj.data);
    const type = await fileTypeFromBuffer(buffer);
    if (!type) {
        console.log(`Unknown file type: projectid=${projectid}, mediaId=${mediaId}`);
        return false;
    }

    const filename = `${RANDOM_STRING(15)}.${type.ext}`;

    try {
        await uploadChatMedia(keyPrefix, filename, buffer, type.mime);
        return filename;
    } catch (error) {
        console.error(`B2 upload failed: projectid=${projectid}, mediaId=${mediaId}`, error.message);
        return false;
    }
}

export { SaveMedia };
