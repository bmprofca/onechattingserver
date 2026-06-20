import crypto from "crypto";
import { PUBLIC_KEY } from "./RSAKeys.js";

function Encrypt(payload) {
    const plainText = JSON.stringify(payload);

    // ✅ Generate AES key (128-bit)
    const aesKey = crypto.randomBytes(16); // 16 bytes = 128-bit

    // ✅ AES encryption (ECB + PKCS7)
    const cipher = crypto.createCipheriv("aes-128-ecb", aesKey, null);
    let encryptedData = cipher.update(plainText, "utf8", "base64");
    encryptedData += cipher.final("base64");

    // ✅ Encrypt AES key with RSA public key
    const encryptedKey = crypto.publicEncrypt(
        {
            key: PUBLIC_KEY,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
        },
        aesKey
    ).toString("base64");

    return { data: encryptedData, key: encryptedKey };
}

export { Encrypt };
