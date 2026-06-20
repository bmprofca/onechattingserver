import pool from "../../db.js";
import XLSX from "xlsx";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { RANDOM_STRING, TIMESTAMP } from "../function.js";
import { InitiateCampaignMessages } from "./sendMessage.js";
import { markCampaignSpawned } from "./spawnedCampaigns.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function validatePhone(phone) {
    // Remove all non-digit characters first
    const cleaned = phone.replace(/\D/g, "");

    // Check if the cleaned result contains only digits and is not empty
    if (cleaned === "" || !/^\d+$/.test(cleaned)) {
        throw new Error("Invalid phone number: must contain only digits");
    }

    return cleaned;
}

function processObject(obj, row) {
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => processObject(item, row));
    }

    const processed = { ...obj };

    // If this object has a 'text' property, process it
    if (typeof processed.text === 'string') {
        const matches = processed.text.match(/\{\{(\d+)\}\}/g);
        let processedText = processed.text;

        if (matches) {
            matches.forEach(match => {
                const index = parseInt(match.replace(/\{\{|\}\}/g, ""));

                // Validate column index
                if (index < 0 || index >= row.length) {
                    throw new Error(`Invalid column index: ${index}`);
                }

                const cellValue = String(row[index] || "").trim();
                if (cellValue === "") {
                    throw new Error(`Empty value at column index: ${index}`);
                }

                processedText = processedText.replace(match, cellValue);
            });
            processed.text = processedText;
        }
    }

    // Recursively process all other properties
    for (const key in processed) {
        if (processed.hasOwnProperty(key) && key !== 'text') {
            processed[key] = processObject(processed[key], row);
        }
    }

    return processed;
}

function processComponent(component, row) {
    try {
        return processObject(component, row);
    } catch (error) {
        throw new Error(`Component processing failed: ${error.message}`);
    }
}

function processObjectWithContact(obj, contact) {
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => processObjectWithContact(item, contact));
    }

    const processed = { ...obj };

    // If this object has a 'text' property, process it
    if (typeof processed.text === 'string') {
        const matches = processed.text.match(/\{\{(\w+)\}\}/g);
        let processedText = processed.text;

        if (matches) {
            matches.forEach(match => {
                const fieldName = match.replace(/\{\{|\}\}/g, "").toLowerCase();

                // Get the value from contact object (case-insensitive field matching)
                let fieldValue = "";
                if (contact) {
                    // Map common field names (case-insensitive)
                    const contactFields = {
                        'name': contact.name || "",
                        'number': contact.number || "",
                        'email': contact.email || "",
                        'firm_name': contact.firm_name || "",
                        'website': contact.website || "",
                        'remark': contact.remark || ""
                    };

                    // Try mapped field first, then direct property access (case-insensitive)
                    if (contactFields[fieldName] !== undefined) {
                        fieldValue = contactFields[fieldName];
                    } else {
                        // Try to find matching key in contact object (case-insensitive)
                        const matchingKey = Object.keys(contact).find(key => key.toLowerCase() === fieldName);
                        if (matchingKey) {
                            fieldValue = contact[matchingKey] || "";
                        }
                    }
                }

                // Replace the variable with the actual value
                processedText = processedText.replace(match, String(fieldValue || "").trim());
            });
            processed.text = processedText;
        }
    }

    // Recursively process all other properties
    for (const key in processed) {
        if (processed.hasOwnProperty(key) && key !== 'text') {
            processed[key] = processObjectWithContact(processed[key], contact);
        }
    }

    return processed;
}

function processComponentWithContact(component, contact) {
    try {
        return processObjectWithContact(component, contact);
    } catch (error) {
        throw new Error(`Component processing failed: ${error.message}`);
    }
}

async function saveToDatabase(data) {
    const { phone, component, row, campaign_id, username, template_id, template_name, language_code, project_id } = data;

    try {
        const validatedPhone = validatePhone(phone);

        // Process component with row data
        let processedComponent;
        try {
            processedComponent = processComponent(component, row);
        } catch (error) {
            return {
                ok: false,
                error: error.message
            };
        }

        const string_component = JSON.stringify(processedComponent);
        const unique_id = RANDOM_STRING(30);

        await pool.query("INSERT INTO `campaign_messages`(`unique_id`, `campaign_id`, `number`, `create_date`, `create_by`, `template_id`, `template_name`, `language_code`, `component`,`project_id`) VALUES (?,?,?,?,?,?,?,?,?,?)", [unique_id, campaign_id, validatedPhone, TIMESTAMP(), username, template_id, template_name, language_code, string_component, project_id]);

        return { ok: true };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

export async function processInBackgroundExcel(data) {
    const {
        url,
        end_row,
        component,
        campaign_id,
        username,
        template_id,
        template_name,
        language_code,
        project_id,
        isScheduled = false
    } = data;

    markCampaignSpawned(campaign_id);

    let start_row = Number(data?.start_row);
    let phone_index = data?.phone_index;

    try {
        let finalUrl = url;

        const gsMatch = String(url || "").match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/]+)/i);
        if (gsMatch && gsMatch[1]) {
            const sheetId = gsMatch[1];
            const gidMatch = String(url || "").match(/gid=(\d+)/i);
            const gid = gidMatch ? gidMatch[1] : null;

            finalUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
            if (gid) finalUrl += `&gid=${gid}`;
        }

        const fileResp = await fetch(finalUrl, { redirect: "follow" });

        if (!fileResp.ok) {
            const status = fileResp.status;

            return;
        }

        const arrayBuffer = await fileResp.arrayBuffer();
        const buf = Buffer.from(arrayBuffer);

        const contentType = String(fileResp.headers.get("content-type") || "").toLowerCase();
        const head = buf.slice(0, 200).toString("utf8").trim().toLowerCase();
        const looksLikeHtml =
            contentType.includes("text/html") ||
            head.startsWith("<!doctype") ||
            head.startsWith("<html") ||
            head.startsWith("<");

        if (looksLikeHtml) {
            return;
        }


        const workbook = XLSX.read(buf, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });


        const failedRows = [];

        for (let r = start_row; r <= end_row; r++) {
            const row = rows[r] || [];


            const phone = String(row[phone_index] || "").trim();

            if (!phone) {
                failedRows.push([...row, "Empty phone"]);
                continue;
            }



            const result = await saveToDatabase({
                phone,
                component,
                row,
                campaign_id,
                username,
                template_id,
                template_name,
                language_code,
                project_id
            });

            if (!result.ok) {
                failedRows.push([...row, result.error]);
            }
        }

        if (failedRows.length > 0) {
            const errorDir = path.join(process.cwd(), "media", "error");
            if (!fs.existsSync(errorDir)) fs.mkdirSync(errorDir, { recursive: true });

            const errorWB = XLSX.utils.book_new();
            const headerRow = rows[0] || [];
            const errorWS = XLSX.utils.aoa_to_sheet([
                [...headerRow, "Error"],
                ...failedRows
            ]);
            XLSX.utils.book_append_sheet(errorWB, errorWS, "FailedRows");
            const filename = `${RANDOM_STRING(30)}.xlsx`;
            const filePath = path.join(errorDir, filename);
            XLSX.writeFile(errorWB, filePath);

            await pool.query(
                "UPDATE `campaigns` SET `has_error`=?,`error_file`=? WHERE `campaign_id` = ?",
                ['1', filename, campaign_id]
            );
        }

        await pool.query(
            "UPDATE `campaigns` SET `entry_complete`=? WHERE campaign_id = ?",
            ['1', campaign_id]
        );

        // Only initiate messages if campaign is NOT scheduled
        // Scheduled campaigns will be initiated by the scheduler when it's time
        if (!isScheduled) {
            InitiateCampaignMessages({ campaign_id }).catch(err => console.error('[processInBackgroundExcel] InitiateCampaignMessages failed:', err?.message || err));
        }
    } catch (error) {
        console.error('[processInBackgroundExcel] Background processing failed:', error?.message || error);
    }
}

async function saveContactToDatabase(data) {
    const { phone, component, contact, campaign_id, username, template_id, template_name, language_code, project_id } = data;

    try {
        const validatedPhone = validatePhone(phone);

        // Process component with contact data to replace variables like {{name}}, {{email}}, etc.
        let processedComponent;
        try {
            processedComponent = processComponentWithContact(component, contact || {});
        } catch (error) {
            return {
                ok: false,
                error: error.message
            };
        }

        const string_component = JSON.stringify(processedComponent);
        const unique_id = RANDOM_STRING(30);

        await pool.query("INSERT INTO `campaign_messages`(`unique_id`, `campaign_id`, `number`, `create_date`, `create_by`, `template_id`, `template_name`, `language_code`, `component`,`project_id`) VALUES (?,?,?,?,?,?,?,?,?,?)", [unique_id, campaign_id, validatedPhone, TIMESTAMP(), username, template_id, template_name, language_code, string_component, project_id]);

        return { ok: true };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

export async function processInBackgroundContacts(data) {
    const {
        contact_ids,
        numbers,
        component,
        campaign_id,
        username,
        template_id,
        template_name,
        language_code,
        project_id,
        isScheduled = false
    } = data;

    if (!template_name || !language_code) {
        return;
    }

    markCampaignSpawned(campaign_id);

    try {
        const failedRows = [];
        const processedContacts = new Set();
        let totalProcessed = 0;

        // Process contact_ids if provided
        if (contact_ids && Array.isArray(contact_ids) && contact_ids.length > 0) {
            const placeholders = contact_ids.map(() => '?').join(',');
            const [contactRows] = await pool.query(
                `SELECT * FROM contacts WHERE contact_id IN (${placeholders}) AND project_id = ? AND is_deleted = ?`,
                [...contact_ids, project_id, '0']
            );

            for (const contact of contactRows) {
                const phone = String(contact.number || "").trim();
                const name = String(contact.name || "").trim();

                if (!phone) {
                    failedRows.push([phone, name, "Empty phone number"]);
                    continue;
                }

                // Skip if already processed (duplicate number)
                if (processedContacts.has(phone)) {
                    continue;
                }

                const result = await saveContactToDatabase({
                    phone,
                    component,
                    contact, // Pass full contact object for variable replacement
                    campaign_id,
                    username,
                    template_id,
                    template_name,
                    language_code,
                    project_id
                });

                if (!result.ok) {
                    failedRows.push([phone, name, result.error]);
                } else {
                    processedContacts.add(phone);
                    totalProcessed++;
                }
            }
        }

        // Process numbers if provided
        if (numbers && Array.isArray(numbers) && numbers.length > 0) {
            for (const number of numbers) {
                const phone = String(number || "").trim();

                if (!phone) {
                    failedRows.push([phone, "", "Empty phone number"]);
                    continue;
                }

                // Skip if already processed
                if (processedContacts.has(phone)) {
                    continue;
                }

                // Check if contact exists in database
                const [contactRows] = await pool.query(
                    "SELECT * FROM contacts WHERE number = ? AND project_id = ? AND is_deleted = ?",
                    [phone, project_id, '0']
                );

                const contactName = contactRows.length > 0 ? String(contactRows[0].name || "").trim() : "";
                const contactData = contactRows.length > 0 ? contactRows[0] : null;

                const result = await saveContactToDatabase({
                    phone,
                    component,
                    contact: contactData, // Pass contact data for variable replacement (null if not found)
                    campaign_id,
                    username,
                    template_id,
                    template_name,
                    language_code,
                    project_id
                });

                if (!result.ok) {
                    failedRows.push([phone, contactName, result.error]);
                } else {
                    processedContacts.add(phone);
                    totalProcessed++;
                }
            }
        }

        // Generate error file if there are failures
        if (failedRows.length > 0) {
            const errorDir = path.join(process.cwd(), "media", "error");
            if (!fs.existsSync(errorDir)) fs.mkdirSync(errorDir, { recursive: true });

            const errorWB = XLSX.utils.book_new();
            const errorWS = XLSX.utils.aoa_to_sheet([
                ["Number", "Name", "Error"],
                ...failedRows
            ]);
            XLSX.utils.book_append_sheet(errorWB, errorWS, "FailedRows");
            const filename = `${RANDOM_STRING(30)}.xlsx`;
            const filePath = path.join(errorDir, filename);
            XLSX.writeFile(errorWB, filePath);

            await pool.query(
                "UPDATE `campaigns` SET `has_error`=?,`error_file`=? WHERE `campaign_id` = ?",
                ['1', filename, campaign_id]
            );
        }

        await pool.query(
            "UPDATE `campaigns` SET `entry_complete`=? WHERE campaign_id = ?",
            ['1', campaign_id]
        );

        // Only initiate messages if campaign is NOT scheduled
        // Scheduled campaigns will be initiated by the scheduler when it's time
        if (!isScheduled) {
            InitiateCampaignMessages({ campaign_id }).catch(err => console.error('[processInBackgroundContacts] InitiateCampaignMessages failed:', err?.message || err));
        }
    } catch (error) {
        console.error('[processInBackgroundContacts] Background processing failed:', error?.message || error);
    }
}

export async function processInBackgroundGroups(data) {
    const {
        group_ids,
        component,
        campaign_id,
        username,
        template_id,
        template_name,
        language_code,
        project_id,
        isScheduled = false
    } = data;

    if (!template_name || !language_code) {
        return;
    }

    markCampaignSpawned(campaign_id);

    try {
        const failedRows = [];
        const processedContacts = new Set();
        let totalProcessed = 0;

        // Process group_ids if provided
        if (group_ids && Array.isArray(group_ids) && group_ids.length > 0) {
            // Get all contact_ids from all groups
            const placeholders = group_ids.map(() => '?').join(',');
            const [mappingRows] = await pool.query(
                `SELECT DISTINCT cgm.contact_id 
                 FROM contact_group_mapping cgm 
                 WHERE cgm.group_id IN (${placeholders}) 
                 AND cgm.is_deleted = ?`,
                [...group_ids, '0']
            );

            // Extract unique contact_ids
            const contactIds = mappingRows.map(row => row.contact_id);

            if (contactIds.length > 0) {
                // Get all contacts by contact_ids
                const contactPlaceholders = contactIds.map(() => '?').join(',');
                const [contactRows] = await pool.query(
                    `SELECT * FROM contacts 
                     WHERE contact_id IN (${contactPlaceholders}) 
                     AND project_id = ? 
                     AND is_deleted = ?`,
                    [...contactIds, project_id, '0']
                );

                // Process each contact, deduplicating by phone number
                for (const contact of contactRows) {
                    const phone = String(contact.number || "").trim();
                    const name = String(contact.name || "").trim();

                    if (!phone) {
                        failedRows.push([phone, name, "Empty phone number"]);
                        continue;
                    }

                    // Skip if already processed (deduplicate by phone number)
                    if (processedContacts.has(phone)) {
                        continue;
                    }

                    const result = await saveContactToDatabase({
                        phone,
                        component,
                        contact, // Pass full contact object for variable replacement
                        campaign_id,
                        username,
                        template_id,
                        template_name,
                        language_code,
                        project_id
                    });

                    if (!result.ok) {
                        failedRows.push([phone, name, result.error]);
                    } else {
                        processedContacts.add(phone);
                        totalProcessed++;
                    }
                }
            }
        }

        // Generate error file if there are failures
        if (failedRows.length > 0) {
            const errorDir = path.join(process.cwd(), "media", "error");
            if (!fs.existsSync(errorDir)) fs.mkdirSync(errorDir, { recursive: true });

            const errorWB = XLSX.utils.book_new();
            const errorWS = XLSX.utils.aoa_to_sheet([
                ["Number", "Name", "Error"],
                ...failedRows
            ]);
            XLSX.utils.book_append_sheet(errorWB, errorWS, "FailedRows");
            const filename = `${RANDOM_STRING(30)}.xlsx`;
            const filePath = path.join(errorDir, filename);
            XLSX.writeFile(errorWB, filePath);

            await pool.query(
                "UPDATE `campaigns` SET `has_error`=?,`error_file`=? WHERE `campaign_id` = ?",
                ['1', filename, campaign_id]
            );
        }

        await pool.query(
            "UPDATE `campaigns` SET `entry_complete`=? WHERE campaign_id = ?",
            ['1', campaign_id]
        );

        // Only initiate messages if campaign is NOT scheduled
        // Scheduled campaigns will be initiated by the scheduler when it's time
        if (!isScheduled) {
            InitiateCampaignMessages({ campaign_id }).catch(err => console.error('[processInBackgroundGroups] InitiateCampaignMessages failed:', err?.message || err));
        }
    } catch (error) {
        console.error('[processInBackgroundGroups] Background processing failed:', error?.message || error);
    }
}
