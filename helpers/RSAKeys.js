import fs from "fs";
const PUBLIC_KEY = fs.readFileSync("./public.pem", "utf8");
const PRIVATE_KEY = fs.readFileSync("./private.pem", "utf8");


export { PUBLIC_KEY, PRIVATE_KEY }