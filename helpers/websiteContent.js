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
    address: "H. No. 356, Vill. Nagajan, Niz Kharupetia, Kharupetiaghat, Darrang, Assam 784115, India",
    phone: "+91 70026 95990",
    phone_note: "Mon-Fri, 9AM-6PM IST",
    email: "contact@onesaas.in",
    email_note: "We'll respond within 24 hours",
    website: "https://www.onesaas.in",
    website_label: "www.onesaas.in",
    website_note: "Visit our main website",
    footer_blurb: "OneChatting is a WhatsApp Business API platform for live chat, campaigns, templates, team collaboration, and developer integrations — powered by the official WhatsApp Cloud API.",
    footer_address: "H. No. 356, Vill. Nagajan, Niz Kharupetia, Kharupetiaghat, Darrang, Assam 784115, India",
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
        subtitle: "Effective date: 13 November 2026",
        footer_label: "Business Policy",
        sort_order: 4,
        content_html: `
<h2>1. Who we are</h2>
<p>OneChatting is a product of <strong>OneSaaS Technologies Private Limited</strong>, a private limited company incorporated in India.</p>
<ul>
<li>CIN: U46512AS2024PTC026214</li>
<li>GSTIN: 18AAECO3487E1ZA</li>
<li>Registered office: H. No. 356, Vill. Nagajan, Niz Kharupetia, Kharupetiaghat, Darrang, Assam 784115, India</li>
<li>Email: contact@onesaas.in</li>
<li>Phone: +91 70026 95990</li>
</ul>
<h2>2. What OneChatting does</h2>
<p>OneChatting is a software platform that helps businesses use the official <strong>WhatsApp Business Platform (Cloud API) by Meta</strong>. Through OneChatting, our customers can:</p>
<ul>
<li>connect their own WhatsApp Business Account through Meta's Embedded Signup;</li>
<li>manage customer conversations in a shared team inbox;</li>
<li>create message templates and submit them to Meta for approval;</li>
<li>send template messages to customers who have opted in to receive them;</li>
<li>connect their own systems through our API.</li>
</ul>
<p>Each customer owns its own WhatsApp Business Account, phone number and customer data. OneChatting provides the software and does not message anyone on its own behalf for its customers.</p>
<h2>3. Who can use OneChatting</h2>
<p>We onboard only genuine, registered businesses. Before activation, every customer must:</p>
<ul>
<li>provide its legal business name and a valid registration document (for example GST, Udyam, Certificate of Incorporation or a shop licence);</li>
<li>have a working website or business profile that describes its business;</li>
<li>accept our Terms of Service, our Acceptable Use Policy, and the WhatsApp Business Terms and Policies.</li>
</ul>
<p>We may refuse or suspend any account at our discretion, including where we cannot verify the business.</p>
<h2>4. Pricing and payment</h2>
<p>OneChatting is offered on subscription plans (monthly, quarterly or annual) plus a prepaid wallet for WhatsApp conversation charges. Prices are shown on our Pricing page and include applicable GST. Payments are taken through secure payment gateways, and invoices are issued automatically.</p>
<h2>5. Refunds and cancellation</h2>
<p>You can cancel a subscription at any time before renewal. Subscription fees already paid are not refundable, except for duplicate or erroneous charges reported through a support ticket. Approved refunds are processed within 7 working days. See our Refund Policy for the full terms.</p>
<h2>6. Data and privacy</h2>
<p>We process customer and end-user data only to provide the service, as described in our Privacy Policy and in line with the Digital Personal Data Protection Act, 2023 and the IT Act, 2000. Message content is processed through Meta's WhatsApp Cloud API. We do not sell personal data.</p>
<h2>7. Compliance with WhatsApp and Meta policies</h2>
<p>All use of OneChatting must comply with the WhatsApp Business Messaging Policy, the WhatsApp Commerce Policy and Meta's Terms. Our Acceptable Use Policy sets out these rules. Accounts that break them are suspended.</p>
<h2>8. Grievance officer</h2>
<p>In line with the IT (Intermediary Guidelines) Rules, 2021:</p>
<p>Grievance Officer, OneSaaS Technologies Private Limited<br/>Email: contact@onesaas.in · Phone: +91 70026 95990</p>
<p>We acknowledge complaints within 24 hours and resolve them within 15 days.</p>
`.trim(),
    },
    {
        slug: "acceptable-use",
        title: "Acceptable Use and Opt-in Policy",
        subtitle: "Effective date: 13 November 2026",
        footer_label: "Acceptable Use",
        sort_order: 5,
        content_html: `
<p>This policy applies to every business that uses OneChatting ("you"). Using OneChatting means you agree to it. It adds to, and does not replace, the WhatsApp Business Terms of Service, the WhatsApp Business Messaging Policy and the WhatsApp Commerce Policy.</p>
<h2>1. Opt-in is mandatory</h2>
<ul>
<li>You may message only people who have <strong>given you their mobile number and agreed to receive WhatsApp messages from your business</strong>.</li>
<li>The opt-in must make clear that the person is agreeing to WhatsApp messages from your named business.</li>
<li>You must keep a record of each opt-in (date, source and wording) and show it to us on request.</li>
<li><strong>Purchased, rented, scraped or third-party contact lists are not allowed.</strong> This includes importing such lists through Excel, CSV or Google Sheets.</li>
</ul>
<h2>2. Respect opt-outs</h2>
<ul>
<li>Honour every request to stop messages ("STOP", "unsubscribe" or similar) promptly, and do not message that person again unless they opt in again.</li>
<li>Marketing templates should tell people how to opt out.</li>
</ul>
<h2>3. Message quality</h2>
<ul>
<li>Use only templates that Meta has approved, and put them in the correct category (Marketing, Utility or Authentication).</li>
<li>Do not send misleading, threatening or abusive content.</li>
<li>Do not send messages at a volume or frequency that leads to user blocks or reports. We monitor quality ratings and may limit or pause accounts with low quality.</li>
</ul>
<h2>4. Prohibited businesses and content</h2>
<p>You may not use OneChatting to buy, sell, promote or arrange anything prohibited by the WhatsApp Commerce Policy, including:</p>
<p>drugs (illegal, prescription or recreational) · tobacco and vapes · alcohol · weapons, ammunition and explosives · gambling and betting, real-money games and lotteries · adult products and services · dating · animals and animal products · medical and healthcare products where restricted · cryptocurrency and unregulated financial products · multi-level marketing and "get rich quick" schemes · counterfeit goods · fake documents · real-money or virtual currency trading · any illegal product or service.</p>
<p>You may also not use OneChatting for spam, phishing, fraud, impersonation, political messaging where restricted, or anything that breaks Indian law.</p>
<h2>5. How we enforce this</h2>
<ul>
<li>We review every new business before activation.</li>
<li>We monitor template rejections, quality ratings, blocks and reports from Meta.</li>
<li>If you break this policy, we may warn you, limit your sending, suspend your account, or remove your WhatsApp Business Account from OneChatting, <strong>without refund</strong>, and we may report you to Meta.</li>
<li>We cooperate fully with Meta and with law-enforcement requests.</li>
</ul>
<h2>6. Reporting abuse</h2>
<p>To report misuse of a number connected through OneChatting, email <a href="mailto:contact@onesaas.in">contact@onesaas.in</a> with the number and a screenshot. We review every report within 2 business days.</p>
`.trim(),
    },
];

const COMPLIANCE_PAGE_SLUGS = new Set(["business-policy", "acceptable-use"]);

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
    await refreshPublicContactDefaults();

    for (const page of DEFAULT_PAGES) {
        const [existing] = await pool.query(
            "SELECT id FROM website_pages WHERE slug = ? LIMIT 1",
            [page.slug]
        );
        if (existing.length > 0) {
            if (COMPLIANCE_PAGE_SLUGS.has(page.slug)) {
                await pool.query(
                    `UPDATE website_pages
                     SET title = ?, subtitle = ?, content_html = ?, footer_label = ?,
                         show_in_footer = 1, is_published = 1, sort_order = ?, updated_at = ?
                     WHERE slug = ?`,
                    [
                        page.title,
                        page.subtitle,
                        page.content_html,
                        page.footer_label,
                        page.sort_order,
                        TIMESTAMP(),
                        page.slug,
                    ]
                );
            }
            continue;
        }
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

async function refreshPublicContactDefaults() {
    const existing = await getSettingsMap(WEBSITE_SETTING_GROUP);
    const shortAddressValues = new Set([
        "Kharupetia, Assam, India",
        "House No. 356, Nagajan, Kharupetia, Darrang, Assam, PIN - 784115, India",
        "H. No. 356, Vill. Nagajan Niz, Kharupetiaghat, Darrang, Assam 784115",
    ]);
    const shortPhoneValues = new Set(["+91-7002695990", "+91 7002695990"]);

    const updates = [];
    if (!existing.footer_address || shortAddressValues.has(String(existing.footer_address).trim())) {
        updates.push(["footer_address", DEFAULT_CONTACT.footer_address]);
    }
    if (!existing.address || shortAddressValues.has(String(existing.address).trim())) {
        updates.push(["address", DEFAULT_CONTACT.address]);
    }
    if (!existing.phone || shortPhoneValues.has(String(existing.phone).trim())) {
        updates.push(["phone", DEFAULT_CONTACT.phone]);
    }
    if (!existing.email) {
        updates.push(["email", DEFAULT_CONTACT.email]);
    }

    for (const [key, value] of updates) {
        const field = CONTACT_FIELDS.find((item) => item.key === key);
        if (!field) continue;
        await upsertSetting({
            setting_group: WEBSITE_SETTING_GROUP,
            setting_key: key,
            setting_value: value,
            label: field.label,
            value_type: field.value_type,
            is_public: 1,
            sort_order: field.sort_order,
        });
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
