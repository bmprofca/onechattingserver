import pool from "../db.js";
import { TIMESTAMP } from "./function.js";
import {
    WEBSITE_SETTING_GROUP,
    ensureSettingsTable,
    getSettingsMap,
    upsertSetting,
} from "./settings.js";

let tablesReadyPromise = null;

export const DEFAULT_CONTACT = {
    company_name: "Onesaas Technologies Private Limited",
    legal_name: "OneSaaS Technologies Private Limited",
    cin: "U46512AS2024PTC026214",
    address: "House No. 356, Nagajan, Kharupetia, Darrang, Assam, PIN - 784115, India",
    phone: "+91-7002695990",
    phone_note: "Mon-Fri, 9AM-6PM IST",
    email: "contact@onesaas.in",
    email_note: "We'll respond within 24 hours",
    website: "https://www.onesaas.in",
    website_label: "www.onesaas.in",
    website_note: "Visit our main website",
    footer_blurb: "OneChatting is a WhatsApp Business API platform for live chat, campaigns, templates, team collaboration, and developer integrations — powered by the official WhatsApp Cloud API.",
    footer_address: "Kharupetia, Assam, India",
    copyright: "© 2026 OneChatting. All rights reserved.",
    cta_title: "Ready to Get Started?",
    cta_text: "Experience the power of OneChatting and transform your WhatsApp business communication today.",
    cta_button: "Start Free Trial",
};

const CONTACT_FIELDS = [
    { key: "company_name", label: "Company name", value_type: "text", sort_order: 1 },
    { key: "legal_name", label: "Legal name shown in footer", value_type: "text", sort_order: 2 },
    { key: "cin", label: "CIN", value_type: "text", sort_order: 3 },
    { key: "address", label: "Address", value_type: "textarea", sort_order: 4 },
    { key: "phone", label: "Phone", value_type: "text", sort_order: 5 },
    { key: "phone_note", label: "Phone note", value_type: "text", sort_order: 6 },
    { key: "email", label: "Email", value_type: "text", sort_order: 7 },
    { key: "email_note", label: "Email note", value_type: "text", sort_order: 8 },
    { key: "website", label: "Website URL", value_type: "text", sort_order: 9 },
    { key: "website_label", label: "Website label", value_type: "text", sort_order: 10 },
    { key: "website_note", label: "Website note", value_type: "text", sort_order: 11 },
    { key: "footer_address", label: "Footer address", value_type: "text", sort_order: 12 },
    { key: "copyright", label: "Copyright line", value_type: "text", sort_order: 13 },
    { key: "footer_blurb", label: "Footer description", value_type: "textarea", sort_order: 14 },
    { key: "cta_title", label: "Contact page button title", value_type: "text", sort_order: 15 },
    { key: "cta_text", label: "Contact page intro", value_type: "textarea", sort_order: 16 },
    { key: "cta_button", label: "Contact page button text", value_type: "text", sort_order: 17 },
];

const DEFAULT_PAGES = [
    {
        slug: "privacy-policy",
        title: "Privacy Policy",
        subtitle: "Last Updated: January 21, 2026",
        footer_label: "Privacy",
        sort_order: 1,
        content_html: `
<h2>1. Introduction</h2>
<p>At <strong>OneChatting</strong> (a product of Onesaas Technologies Private Limited), we are deeply committed to protecting the privacy and security of our users. This Privacy Policy explains how we collect, use, store, and safeguard personal information when you use our WhatsApp Business API platform and related services.</p>
<h2>2. Information We Collect</h2>
<h3>2.1 User Account Data</h3>
<p>During registration and platform usage, we collect personal information including full name, email address, phone number, business name, billing address, and payment information.</p>
<h3>2.2 Technical and Usage Data</h3>
<p>We automatically collect technical information such as IP addresses, device types, browser information, operating system details, timestamps, and interaction patterns.</p>
<h3>2.3 End-User Communication Data</h3>
<p>As a platform facilitating WhatsApp Business communications, we may process messages, media files, and contact information transmitted through our service. <strong>You are solely responsible</strong> for obtaining proper consent from your end-users.</p>
<h2>3. How We Use Your Information</h2>
<ul>
<li><strong>Service Provision:</strong> To create and manage your account, provide access to the platform, process transactions, and deliver support.</li>
<li><strong>Platform Improvement:</strong> To analyze usage, identify issues, and improve features.</li>
<li><strong>Communication:</strong> To send service updates, security alerts, policy changes, and billing notices.</li>
<li><strong>Legal Compliance:</strong> To comply with applicable laws and Meta's WhatsApp Business API policies.</li>
<li><strong>Security and Fraud Prevention:</strong> To detect and respond to security incidents and fraud.</li>
</ul>
<h2>4. Information Sharing and Disclosure</h2>
<p><strong>We do not sell, rent, or trade your personal information.</strong> We may share information with service providers, Meta/WhatsApp, when required by law, or as part of a business transfer.</p>
<h2>5. Data Security Measures</h2>
<ul>
<li>Encryption of data in transit (SSL/TLS) and at rest</li>
<li>Secure authentication and password protection</li>
<li>Regular security audits and access controls</li>
<li>Continuous monitoring for security threats</li>
</ul>
<h2>6. Data Retention</h2>
<p>We retain personal information only for as long as necessary to fulfill the purposes in this policy, comply with legal obligations, resolve disputes, and maintain business records.</p>
<h2>7. Your Rights and Choices</h2>
<p>Subject to applicable law, you may request access, correction, deletion, data portability, objection, or withdrawal of consent.</p>
<h2>8. Changes to This Privacy Policy</h2>
<p>We may update this policy from time to time. Continued use of the platform after changes constitutes acceptance of the revised policy.</p>
<h2>9. Contact Us</h2>
<p>Company: Onesaas Technologies Private Limited<br/>Email: contact@onesaas.in<br/>Phone: +91-7002695990<br/>Address: House No. 356, Nagajan, Kharupetia, Darrang, Assam - 784115, India</p>
`.trim(),
    },
    {
        slug: "terms",
        title: "Terms & Conditions",
        subtitle: "Last Updated: January 21, 2026",
        footer_label: "Terms",
        sort_order: 2,
        content_html: `
<h2>1. Acceptance of Terms</h2>
<p>Welcome to <strong>OneChatting</strong>, a WhatsApp Business API platform operated by Onesaas Technologies Private Limited. By accessing or using our services, you agree to these Terms and Conditions.</p>
<h2>2. Service Description</h2>
<p>OneChatting provides a subscription-based web platform to access the WhatsApp Business Cloud API, manage communications, automate campaigns, deploy chatbots, and integrate via API.</p>
<h2>3. Account Registration and Security</h2>
<p>You must provide accurate information, keep credentials confidential, and be at least 18 years old to use the service.</p>
<h2>4. Subscription and Payment Terms</h2>
<p>Services are offered on subscription plans. Fees may change with prior notice. Payments are processed through secure gateways. Subscriptions renew automatically unless cancelled. Fees are exclusive of applicable taxes.</p>
<h2>5. Acceptable Use Policy</h2>
<p>You must not send spam, transmit illegal content, violate third-party rights, reverse engineer the platform, or resell access without written permission.</p>
<h2>6. Intellectual Property Rights</h2>
<p>The platform is owned by Onesaas Technologies Private Limited. You retain rights to content you submit and grant us a limited license to process it to provide the service.</p>
<h2>7. Data Protection and Privacy</h2>
<p>Your use of the service is also governed by our Privacy Policy. You are responsible for lawful collection and processing of end-user data.</p>
<h2>8. Limitation of Liability</h2>
<p>The platform is provided "AS IS". Our total liability shall not exceed the amount you paid us in the 12 months preceding a claim, to the maximum extent permitted by law.</p>
<h2>9. Indemnification</h2>
<p>You agree to indemnify Onesaas Technologies Private Limited against claims arising from your use of the platform, your content, or your violation of these Terms or applicable law.</p>
<h2>10. Termination</h2>
<p>You may cancel at any time. We may suspend or terminate accounts that violate these Terms. Termination does not relieve payment obligations already incurred.</p>
<h2>11. Dispute Resolution and Governing Law</h2>
<p>These Terms are governed by the laws of India. Disputes are subject to the exclusive jurisdiction of the courts in Guwahati, Assam, India.</p>
<h2>12. Changes to These Terms</h2>
<p>We may modify these Terms at any time. Continued use after changes constitutes acceptance.</p>
<h2>13. Contact Information</h2>
<p>Onesaas Technologies Private Limited<br/>CIN: U46512AS2024PTC026214<br/>Email: contact@onesaas.in<br/>Phone: +91-7002695990</p>
`.trim(),
    },
    {
        slug: "refund-policy",
        title: "Refund Policy",
        subtitle: "Last Updated: June 23, 2026",
        footer_label: "Refund Policy",
        sort_order: 3,
        content_html: `
<h2>1. Introduction</h2>
<p>This Refund Policy applies to all payments made for <strong>OneChatting</strong>, operated by <strong>Onesaas Technologies Private Limited</strong>. It should be read with our Terms &amp; Conditions and Business Policy.</p>
<h2>2. General Policy — No Refunds</h2>
<p><strong>We do not offer refunds</strong> on subscription fees, add-ons, wallet top-ups, message credits, or other charges under normal circumstances. All sales are final once payment is processed. Cancellation stops future billing but does not refund the current period.</p>
<h2>3. Exception — Unauthorized or Erroneous Transactions</h2>
<p>We may refund unauthorized transactions, duplicate charges, or clear billing errors attributable to OneChatting after verification. Approval is at our discretion.</p>
<h2>4. What Does Not Qualify</h2>
<ul>
<li>Change of mind, partial use, or non-use during an active period</li>
<li>Plan changes, unused features, or third-party Meta messaging fees</li>
<li>Suspension for violating the Terms or Acceptable Use Policy</li>
<li>Issues caused by third-party services or user misconfiguration</li>
</ul>
<h2>5. How to Raise a Refund Request</h2>
<p>Email <a href="mailto:contact@onesaas.in">contact@onesaas.in</a> with the subject "Refund Request — Unauthorized Transaction" within <strong>7 calendar days</strong> of the transaction. Include your account email, transaction date, reference number, amount, and supporting receipts.</p>
<h2>6. Processing Timeline</h2>
<p>If approved, the refund is initiated within <strong>7 working days</strong> from the ticket date. Banks may take an additional 5–10 working days to credit the original payment method.</p>
<h2>7. Subscription Cancellation</h2>
<p>Cancellation takes effect at the end of the current billing cycle. <strong>Cancellation is not a refund request.</strong></p>
<h2>8. Legal Rights</h2>
<p>Nothing in this policy limits rights you may have under applicable consumer protection laws.</p>
`.trim(),
    },
    {
        slug: "business-policy",
        title: "Business Policy",
        subtitle: "Effective Date: 01-07-2025",
        footer_label: "Business Policy",
        sort_order: 4,
        content_html: `
<h2>1. Company Overview</h2>
<p>OneSaaS Technologies Private Limited develops web-based CRM and office management software. Our flagship product, OneChatting, helps professional service providers manage staff, clients, tasks, and communications.</p>
<h2>2. Product and Services</h2>
<ul>
<li>Subscription-based access to the OneChatting web application.</li>
<li>Custom software development for professionals.</li>
<li>Technical support and software updates.</li>
<li>Optional integration services such as payment gateways and APIs.</li>
</ul>
<h2>3. Pricing &amp; Payment</h2>
<ul>
<li>Services are offered on a subscription basis (monthly, quarterly, or annually).</li>
<li>Payments are accepted online through integrated payment gateways.</li>
<li>Invoices and receipts are generated through the platform.</li>
<li>Pricing plans may change with prior notice.</li>
</ul>
<h2>4. Refund and Cancellation Policy</h2>
<ul>
<li>Subscriptions may be cancelled before renewal; cancellation does not entitle you to a refund.</li>
<li>Refunds may be initiated only for unauthorized or erroneous system debits after a support ticket.</li>
<li>Approved refunds are processed within 7 working days from the ticket date.</li>
</ul>
<h2>5. Privacy and Terms of Use</h2>
<p>Customer data remains confidential and is stored securely. The platform is licensed for professional use. Unauthorized reselling, reverse engineering, or hacking will result in termination and legal action.</p>
<h2>6. Compliance</h2>
<p>Our software and services comply with applicable Indian IT laws, tax laws, and data privacy norms.</p>
<h2>7. Contact Details</h2>
<p>OneSaaS Technologies Private Limited<br/>CIN: U46512AS2024PTC026214<br/>Registered Office: H. No. 356, Vill. Nagajan Niz, Kharupetiaghat, Darrang, Assam 784115<br/>Email: onesaastech@gmail.com / contact@onesaas.in<br/>Phone: +91-7002695990</p>
`.trim(),
    },
];

const mapPage = (row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle || "",
    content_html: row.content_html || "",
    footer_label: row.footer_label || row.title,
    show_in_footer: row.show_in_footer == 1 || row.show_in_footer === true,
    is_published: row.is_published == 1 || row.is_published === true,
    sort_order: Number(row.sort_order) || 0,
    updated_at: row.updated_at,
});

export function ensureWebsiteTables() {
    if (!tablesReadyPromise) {
        tablesReadyPromise = setupWebsiteTables().catch((error) => {
            tablesReadyPromise = null;
            throw error;
        });
    }
    return tablesReadyPromise;
}

async function setupWebsiteTables() {
    await ensureSettingsTable();
    await migrateWebsiteSettings();

    await pool.query(`
        CREATE TABLE IF NOT EXISTS website_pages (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            slug VARCHAR(120) NOT NULL,
            title VARCHAR(255) NOT NULL,
            subtitle VARCHAR(255) NULL,
            content_html LONGTEXT NULL,
            footer_label VARCHAR(120) NULL,
            show_in_footer TINYINT(1) NOT NULL DEFAULT 1,
            is_published TINYINT(1) NOT NULL DEFAULT 1,
            sort_order INT NOT NULL DEFAULT 0,
            updated_at DATETIME NULL,
            UNIQUE KEY website_pages_slug (slug)
        )
    `);

    await seedWebsiteSettings();

    for (const page of DEFAULT_PAGES) {
        const [existing] = await pool.query(
            "SELECT id FROM website_pages WHERE slug = ? LIMIT 1",
            [page.slug]
        );
        if (existing.length > 0) continue;
        try {
            await pool.query(
                `INSERT INTO website_pages
                    (slug, title, subtitle, content_html, footer_label, show_in_footer, is_published, sort_order, updated_at)
                 VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
                [page.slug, page.title, page.subtitle, page.content_html, page.footer_label, page.sort_order, TIMESTAMP()]
            );
        } catch (error) {
            if (error?.code !== "ER_DUP_ENTRY") throw error;
        }
    }
}

async function migrateWebsiteSettings() {
    const [tables] = await pool.query("SHOW TABLES LIKE 'website_settings'");
    if (!tables.length) return;

    const [rows] = await pool.query("SELECT setting_key, setting_value FROM website_settings");
    for (const row of rows) {
        if (row.setting_key === "contact" && row.setting_value) {
            try {
                const parsed = JSON.parse(row.setting_value);
                if (parsed && typeof parsed === "object") {
                    for (const field of CONTACT_FIELDS) {
                        if (parsed[field.key] == null) continue;
                        await upsertSetting({
                            setting_group: WEBSITE_SETTING_GROUP,
                            setting_key: field.key,
                            setting_value: parsed[field.key],
                            label: field.label,
                            value_type: field.value_type,
                            is_public: 1,
                            sort_order: field.sort_order,
                        });
                    }
                }
            } catch {
                // Leave a broken JSON blob behind and seed defaults instead.
            }
            continue;
        }

        await upsertSetting({
            setting_group: WEBSITE_SETTING_GROUP,
            setting_key: row.setting_key,
            setting_value: row.setting_value,
            label: row.setting_key,
            value_type: "textarea",
            is_public: 1,
            sort_order: 100,
        });
    }

    await pool.query("DROP TABLE website_settings");
}

async function seedWebsiteSettings() {
    const existing = await getSettingsMap(WEBSITE_SETTING_GROUP);
    for (const field of CONTACT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(existing, field.key)) continue;
        await upsertSetting({
            setting_group: WEBSITE_SETTING_GROUP,
            setting_key: field.key,
            setting_value: DEFAULT_CONTACT[field.key] ?? "",
            label: field.label,
            value_type: field.value_type,
            is_public: 1,
            sort_order: field.sort_order,
        });
    }
}

export async function getWebsiteContact({ publicOnly = false } = {}) {
    await ensureWebsiteTables();
    const stored = await getSettingsMap(WEBSITE_SETTING_GROUP, { publicOnly });
    return { ...DEFAULT_CONTACT, ...stored };
}

export async function saveWebsiteContact(contact) {
    await ensureWebsiteTables();
    const next = { ...DEFAULT_CONTACT, ...contact };
    for (const field of CONTACT_FIELDS) {
        await upsertSetting({
            setting_group: WEBSITE_SETTING_GROUP,
            setting_key: field.key,
            setting_value: next[field.key] ?? "",
            label: field.label,
            value_type: field.value_type,
            is_public: 1,
            sort_order: field.sort_order,
        });
    }
    return getWebsiteContact();
}

export async function listWebsitePages({ publishedOnly = false } = {}) {
    await ensureWebsiteTables();
    const where = publishedOnly ? "WHERE is_published = 1" : "";
    const [rows] = await pool.query(
        `SELECT * FROM website_pages ${where} ORDER BY sort_order ASC, id ASC`
    );
    return rows.map(mapPage);
}

export async function getWebsitePageBySlug(slug, { publishedOnly = false } = {}) {
    await ensureWebsiteTables();
    const [rows] = await pool.query(
        `SELECT * FROM website_pages WHERE slug = ? ${publishedOnly ? "AND is_published = 1" : ""} LIMIT 1`,
        [slug]
    );
    return rows.length ? mapPage(rows[0]) : null;
}

export function normalizePageSlug(slug) {
    return String(slug || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export async function saveWebsitePage(payload, id = null) {
    await ensureWebsiteTables();
    const slug = normalizePageSlug(payload.slug);
    if (!slug) {
        return { error: "A valid page slug is required" };
    }
    if (!String(payload.title || "").trim()) {
        return { error: "Page title is required" };
    }

    const values = [
        slug,
        String(payload.title).trim(),
        String(payload.subtitle || "").trim(),
        String(payload.content_html || ""),
        String(payload.footer_label || payload.title).trim(),
        payload.show_in_footer === false || payload.show_in_footer === 0 || payload.show_in_footer === "0" ? 0 : 1,
        payload.is_published === false || payload.is_published === 0 || payload.is_published === "0" ? 0 : 1,
        Number.parseInt(payload.sort_order, 10) || 0,
        TIMESTAMP(),
    ];

    if (id) {
        const [dup] = await pool.query(
            "SELECT id FROM website_pages WHERE slug = ? AND id <> ? LIMIT 1",
            [slug, id]
        );
        if (dup.length) return { error: "Another page already uses this slug" };

        await pool.query(
            `UPDATE website_pages
             SET slug = ?, title = ?, subtitle = ?, content_html = ?, footer_label = ?,
                 show_in_footer = ?, is_published = ?, sort_order = ?, updated_at = ?
             WHERE id = ?`,
            [...values, id]
        );
        return getWebsitePageById(id);
    }

    const [dup] = await pool.query("SELECT id FROM website_pages WHERE slug = ? LIMIT 1", [slug]);
    if (dup.length) return { error: "Another page already uses this slug" };

    const [result] = await pool.query(
        `INSERT INTO website_pages
            (slug, title, subtitle, content_html, footer_label, show_in_footer, is_published, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values
    );
    return getWebsitePageById(result.insertId);
}

async function getWebsitePageById(id) {
    const [rows] = await pool.query("SELECT * FROM website_pages WHERE id = ? LIMIT 1", [id]);
    return rows.length ? mapPage(rows[0]) : null;
}

export async function deleteWebsitePage(id) {
    await ensureWebsiteTables();
    await pool.query("DELETE FROM website_pages WHERE id = ?", [id]);
}
