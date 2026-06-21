import "./helpers/loadEnv.js";
import mysql from "mysql2/promise";

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 5,
    maxIdle: Number(process.env.DB_MAX_IDLE) || 5,
    idleTimeout: Number(process.env.DB_IDLE_TIMEOUT) || 600000,
    queueLimit: 0,
    charset: "utf8mb4",
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
});

export default pool;
