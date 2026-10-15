import CryptoJS from "crypto-js";
import { getRequestContext } from "./requestContext.js";

/**
 * Read a request payload.
 *
 * - Plain JSON body (current clients): returned as-is from the request context.
 * - Legacy encrypted body { data: "<AES ciphertext>", key }: decrypted as before,
 *   so installed app versions keep working.
 *
 * Returns null when the payload can't be read (callers reply "Failed to decrypt data").
 */
const Decrypt = (data, key) => {
    const isLegacyEncrypted = typeof data === "string" && data !== "" && typeof key === "string" && key !== "";

    if (!isLegacyEncrypted) {
        // Plain JSON request body for the current request
        const ctx = getRequestContext();
        if (ctx?.plainBody !== undefined) return ctx.plainBody;
        // Plain object passed directly (outside a request context)
        if (data && typeof data === "object" && !Array.isArray(data)) return data;
        return null;
    }

    try {
        const bytes = CryptoJS.AES.decrypt(data, key);
        const decrypt = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
        return decrypt;
    } catch (error) {
        return null;
    }
};

export { Decrypt };
