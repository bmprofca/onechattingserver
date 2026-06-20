import { Encrypt } from "./Encrypt.js";
import { Decrypt } from "./Decrypt.js";

import { generateKeyPairSync } from "crypto";
import fs from "fs";

const TestMe = () => {


    const plain = "This is SOURAV";
    const encrypted = Encrypt(plain);


    const decrypted = Decrypt(encrypted.data, encrypted.key);


}

export { TestMe }