import axios from "axios";
import pool from "../db.js";
import { GetAiSensyProjectToken, RANDOM_STRING, TIMESTAMP } from "./function.js";
import { WsIo } from "../server.js";
import { emitToProjectSockets } from "./socketEmit.js";

const MAX_STEPS_PER_MESSAGE = 12;
const FLOW_EXPIRY_HOURS = 24;

function parseJson(value, fallback) {
    try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

export function normalizeFlowGraph(graph) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    return { version: Number(graph?.version) || 1, nodes, edges };
}

export function validateFlowGraph(graph) {
    const value = normalizeFlowGraph(graph);
    const errors = [];
    const nodeIds = new Set();
    for (const node of value.nodes) {
        if (!node || !node.id) errors.push("Every node requires an id");
        else if (nodeIds.has(String(node.id))) errors.push(`Duplicate node id: ${node.id}`);
        else nodeIds.add(String(node.id));
        if (!node?.type) errors.push(`Node ${node?.id || "(unknown)"} requires a type`);
        if (node?.type === "message" && !String(node?.data?.text || "").trim()) errors.push(`Message node ${node.id} requires text`);
        if (["condition", "keyword"].includes(node?.type) && !String(node?.data?.value || "").trim()) errors.push(`Node ${node.id} requires a value`);
    }
    const starts = value.nodes.filter((node) => node?.type === "start");
    if (starts.length !== 1) errors.push("The flow must contain exactly one start node");
    for (const edge of value.edges) {
        if (!nodeIds.has(String(edge?.source)) || !nodeIds.has(String(edge?.target))) errors.push("Every edge must reference existing source and target nodes");
    }
    return { valid: errors.length === 0, errors, graph: value };
}

function outgoingEdges(graph, nodeId, handle) {
    return graph.edges.filter((edge) => String(edge.source) === String(nodeId) && (!handle || edge.sourceHandle === handle || edge.handle === handle));
}

function nextNode(graph, nodeId, handle) {
    return outgoingEdges(graph, nodeId, handle)[0]?.target || (!handle ? outgoingEdges(graph, nodeId)[0]?.target : null);
}

const GREETING_TRIGGERS = new Set([
    "hi", "hello", "hey", "start", "menu", "help", "/start", "/menu",
    "namaste", "hola", "bonjour", "hlo", "helo", "main menu"
]);

function isExplicitFlowStart(input, graph) {
    // 1. If user clicked an interactive list or button, it's an explicit interaction
    if (input.interaction_id) return true;

    const text = String(input.text || "").trim().toLowerCase();
    if (!text) return false;

    // 2. Standard common greetings / menu commands
    if (GREETING_TRIGGERS.has(text)) return true;

    // 3. Keyword nodes directly linked from the start node
    const startNode = graph.nodes.find((n) => n.type === "start");
    if (startNode) {
        const directEdges = outgoingEdges(graph, startNode.id);
        for (const edge of directEdges) {
            const targetNode = graph.nodes.find((n) => String(n.id) === String(edge.target));
            if (targetNode?.type === "keyword" && matches(targetNode, input)) {
                return true;
            }
        }
    }

    return false;
}

function matches(node, input) {
    const value = String(node?.data?.value || "").trim().toLowerCase();
    const text = String(input.text || "").trim().toLowerCase();
    const interactionId = String(input.interaction_id || "").trim().toLowerCase();
    const interactionTitle = String(input.interaction_title || "").trim().toLowerCase();

    if (node.type === "keyword") {
        const mode = node.data?.match || "contains";
        return mode === "exact"
            ? text === value
            : mode === "starts_with"
            ? text.startsWith(value)
            : text.includes(value);
    }

    if (node.type === "condition") {
        return (
            interactionId === value ||
            text === value ||
            interactionTitle === value ||
            (value && text.includes(value))
        );
    }

    return true;
}

async function sendFlowMessage(connection, projectId, number, text, type = "text", options = {}) {
    const token = await GetAiSensyProjectToken(projectId);
    if (!token) throw new Error("Project messaging token is unavailable");
    const uniqueId = RANDOM_STRING(30);
    const interactiveType = options.interactiveType === "button" ? "button" : "list";
    const items = (options.items || []).slice(0, interactiveType === "button" ? 3 : 10).map((item, index) => ({
        id: String(item.id || `option_${index + 1}`).slice(0, 200),
        title: String(item.title || item).slice(0, 24),
        ...(item.description ? { description: String(item.description).slice(0, 72) } : {})
    }));
    const interactive = interactiveType === "button"
        ? { type: "button", body: { text }, action: { buttons: items.map(({ id, title }) => ({ type: "reply", reply: { id, title } })) } }
        : { type: "list", body: { text }, action: { button: options.button || "Choose an option", sections: [{ title: options.title || "Options", rows: items }] } };
    const payload = type === "interactive" ? { to: number, type: "interactive", recipient_type: "individual", interactive } : { to: number, type: "text", recipient_type: "individual", text: { body: text } };
    const storedType = type === "interactive" ? "interactive" : "text";
    await connection.query("INSERT INTO messages (unique_id, project_id, create_date, message_by, type, message_type, message, number, status, raw_json, is_reply, reply_wamid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [uniqueId, projectId, TIMESTAMP(), "FLOW_BUILDER", "out", storedType, text, number, "pending", JSON.stringify(payload), "0", null]);
    try {
        const { data } = await axios.post("https://backend.aisensy.com/direct-apis/t1/messages", payload, { headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` } });
        await connection.query("UPDATE messages SET wamid=?, status='sent', message_type=?, raw_json=? WHERE unique_id=?", [data?.messages?.[0]?.id || null, storedType, JSON.stringify(payload), uniqueId]);
    } catch (error) {
        await connection.query("UPDATE messages SET status='failed', failed_reason=? WHERE unique_id=?", [error?.response?.data?.message || error.message || "Flow message failed", uniqueId]);
        throw error;
    }
    await emitToProjectSockets(WsIo, projectId, "chat", { project_id: projectId, message: { message_id: uniqueId, message: text, type: "out", message_type: storedType, status: "sent", interactive: type === "interactive" ? interactive : null, interactive_reply: null, send_by: { username: "FLOW_BUILDER", name: "Flow Builder Bot", status: true } }, contact: { number } });
}

export async function handleFlowBuilder(projectId, number, input, messageUniqueId) {
    const connection = await pool.getConnection();
    let flowAnswered = false;

    try {
        const [[settings]] = await connection.query(
            "SELECT flow_builder_enabled, active_flow_id FROM aisensy_projects WHERE project_id=? LIMIT 1",
            [projectId]
        );
        if (!settings || settings.flow_builder_enabled !== "1" || !settings.active_flow_id) {
            return false;
        }

        const [[flow]] = await connection.query(
            "SELECT flow_id, published_json FROM flows WHERE flow_id=? AND project_id=? AND status='published' AND is_deleted='0' LIMIT 1",
            [settings.active_flow_id, projectId]
        );
        if (!flow) return false;

        const graph = parseJson(flow.published_json, null);
        if (!validateFlowGraph(graph).valid) return false;

        // Check active conversation session
        const [[state]] = await connection.query(
            "SELECT * FROM flow_conversations WHERE flow_id=? AND project_id=? AND number=? AND status='active' AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
            [flow.flow_id, projectId, number]
        );

        let context = parseJson(state?.context_json, {});
        let current = null;
        const rawText = String(input.text || "").trim().toLowerCase();

        // 1. If user explicitly wants to restart menu/flow, clear previous state
        const isResetKeyword = rawText === "menu" || rawText === "main menu" || rawText === "/start" || rawText === "/menu";

        if (state && !isResetKeyword) {
            current = state.current_node_id;
        } else {
            // No active state (or user typed menu). Only trigger new flow if explicit trigger
            if (!isExplicitFlowStart(input, graph)) {
                // Not a flow trigger -> Pass to AI Auto Reply
                return false;
            }
            current = graph.nodes.find((node) => node.type === "start")?.id;
        }

        if (!current) {
            return false;
        }

        let steps = 0;
        let pausedAtInteractive = false;

        while (current && steps++ < MAX_STEPS_PER_MESSAGE) {
            const node = graph.nodes.find((item) => String(item.id) === String(current));
            if (!node) {
                current = null;
                break;
            }

            // Evaluation for condition / keyword nodes
            if (["start", "keyword", "condition"].includes(node.type) && node.type !== "start") {
                const isMatch = matches(node, input);
                if (!isMatch) {
                    const fallbackTarget = nextNode(graph, node.id, "fallback") || nextNode(graph, node.id, "false");
                    if (fallbackTarget) {
                        current = fallbackTarget;
                        continue;
                    } else {
                        // Check if there are other sibling condition edges from the previous node
                        break;
                    }
                }
            }

            let action = node.type;

            if (node.type === "message") {
                flowAnswered = true;
                await sendFlowMessage(
                    connection,
                    projectId,
                    number,
                    String(node.data.text),
                    node.data.interactive ? "interactive" : "text",
                    node.data
                );

                // If message is interactive, we pause execution waiting for user's next input
                if (node.data?.interactive) {
                    pausedAtInteractive = true;
                    // Next step will evaluate branches leading out of this message node
                    const nextOut = outgoingEdges(graph, node.id);
                    if (nextOut.length === 1 && !nextOut[0].sourceHandle) {
                        current = nextOut[0].target;
                    } else {
                        // Keep current at this node or target branches
                        current = node.id;
                    }
                    break;
                }
            } else if (node.type === "set_context") {
                context[String(node.data.key || "value")] = node.data.value;
            } else if (node.type === "end" || node.type === "stop") {
                if (state) {
                    await connection.query(
                        "UPDATE flow_conversations SET status=?, current_node_id=NULL, updated_at=? WHERE id=?",
                        [node.type === "stop" ? "paused" : "completed", TIMESTAMP(), state.id]
                    );
                }
                await connection.query(
                    "INSERT INTO flow_execution_logs (flow_id,project_id,number,message_unique_id,node_id,action,input_json,output_json,status,create_date) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    [flow.flow_id, projectId, number, messageUniqueId, node.id, action, JSON.stringify(input), JSON.stringify(context), "success", TIMESTAMP()]
                );
                return flowAnswered;
            }

            // Find next node in sequence
            // If current node has multiple condition branches outgoing, check matching condition
            const outEdges = outgoingEdges(graph, node.id);
            if (outEdges.length > 1) {
                let matchedNext = null;
                for (const edge of outEdges) {
                    const target = graph.nodes.find((n) => String(n.id) === String(edge.target));
                    if (target && target.type === "condition" && matches(target, input)) {
                        matchedNext = target.id;
                        break;
                    }
                }
                current = matchedNext || nextNode(graph, node.id, node.data?.nextHandle);
            } else {
                current = nextNode(graph, node.id, node.data?.nextHandle);
            }

            // If no next node is found after sending message
            if (!current && node.type === "message" && !node.data?.interactive) {
                // Reached end of sequence without explicit end node
                if (state) {
                    await connection.query(
                        "UPDATE flow_conversations SET status='completed', current_node_id=NULL, updated_at=? WHERE id=?",
                        [TIMESTAMP(), state.id]
                    );
                }
                break;
            }
        }

        // If flow did not send any answer and could not match the user's input:
        if (!flowAnswered) {
            // Mark existing state as completed / handed off so user isn't trapped
            if (state) {
                await connection.query(
                    "UPDATE flow_conversations SET status='completed', updated_at=? WHERE id=?",
                    [TIMESTAMP(), state.id]
                );
            }
            // Return false -> Allows AI Auto Reply to immediately handle the query
            return false;
        }

        const now = TIMESTAMP();
        const expires = new Date(Date.now() + FLOW_EXPIRY_HOURS * 3600000).toISOString().slice(0, 19).replace("T", " ");

        if (state) {
            await connection.query(
                "UPDATE flow_conversations SET current_node_id=?, context_json=?, last_message_unique_id=?, updated_at=?, expires_at=? WHERE id=?",
                [current || null, JSON.stringify(context), messageUniqueId, now, expires, state.id]
            );
        } else {
            await connection.query(
                "INSERT INTO flow_conversations (flow_id,project_id,number,current_node_id,status,context_json,last_message_unique_id,started_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                [flow.flow_id, projectId, number, current || null, "active", JSON.stringify(context), messageUniqueId, now, now, expires]
            );
        }

        await connection.query(
            "INSERT INTO flow_execution_logs (flow_id,project_id,number,message_unique_id,node_id,action,input_json,output_json,status,create_date) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [flow.flow_id, projectId, number, messageUniqueId, current || null, "message", JSON.stringify(input), JSON.stringify(context), "success", now]
        );

        return flowAnswered;
    } catch (error) {
        console.error("[FlowBuilder] execution failed:", error?.message || error);
        return flowAnswered;
    } finally {
        connection.release();
    }
}
