import CryptoJS from "crypto-js";

const Decrypt = (data, key) => {

    if (!data || !key) {
        return null;
    }

    try {
        const bytes = CryptoJS.AES.decrypt(data, key);
        const decrypt = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
        return decrypt;
    } catch (error) {
        return null;
    }
}



export { Decrypt };