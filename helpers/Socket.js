import { Server } from "socket.io";
import pool from "../db.js";
import { projectRoom } from "./socketEmit.js";

async function authenticateAppUser(username, token) {
    if (!username || !token) {
        return null;
    }

    const [rows] = await pool.query(
        "SELECT login_token.id, users.status AS user_status FROM login_token JOIN users ON users.username = login_token.username WHERE login_token.token = ? AND login_token.username = ? AND login_token.status = '1'",
        [token, username]
    );

    if (rows.length !== 1 || rows[0]?.user_status !== "1") {
        return null;
    }

    return { auth_type: "app", username };
}

async function authenticateDeveloper(token) {
    if (!token) {
        return null;
    }

    const [rows] = await pool.query(
        `SELECT pm.project_id, pm.username
         FROM project_mapping pm
         INNER JOIN aisensy_projects ap ON ap.project_id = pm.project_id
         WHERE pm.developer_token = ?
           AND pm.is_deleted = '0'
           AND ap.developer_access = '1'
           AND ap.status = '1'`,
        [token]
    );

    if (rows.length !== 1) {
        return null;
    }

    return {
        auth_type: "developer",
        username: rows[0].username,
        project_id: rows[0].project_id,
    };
}

export function setupSocketIO(server) {
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
        },
        transports: ["websocket", "polling"],
        pingTimeout: 60000,
        pingInterval: 25000,
    });

    io.on("connection", (socket) => {
        socket.on("auth", async (payload = {}) => {
            try {
                const token = (payload.token || "").toString().trim();
                const username = (payload.username || "").toString().trim();
                const authType =
                    payload.auth_type === "developer"
                        ? "developer"
                        : payload.auth_type === "app" || username
                            ? "app"
                            : "developer";

                const session =
                    authType === "developer"
                        ? await authenticateDeveloper(token)
                        : await authenticateAppUser(username, token);

                if (!session) {
                    socket.emit("auth_status", false);
                    socket.disconnect();
                    return;
                }

                if (session.auth_type === "developer") {
                    socket.join(projectRoom(session.project_id));
                } else {
                    socket.join(session.username);
                }
                socket.data.auth = session;

                socket.emit("auth_status", true);

                if (session.auth_type === "developer") {
                    socket.emit("auth_profile", {
                        auth_type: "developer",
                        project_id: session.project_id,
                        username: session.username,
                    });
                }
            } catch (err) {
                console.error("Socket auth error:", err);
                socket.emit("auth_status", false);
                socket.disconnect();
            }
        });

        socket.on("disconnect", () => { });
    });

    return io;
}
