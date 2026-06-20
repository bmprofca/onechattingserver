import pool from "../db.js";

export function projectRoom(project_id) {
    return `project:${project_id}`;
}

export async function emitToProjectSockets(WsIo, project_id, event, payload) {
    WsIo.to(projectRoom(project_id)).emit(event, payload);

    const [room_row] = await pool.query(
        "SELECT username FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?",
        [project_id, "0"]
    );

    for (const roomObj of room_row) {
        WsIo.to(roomObj.username).emit(event, payload);
    }
}
