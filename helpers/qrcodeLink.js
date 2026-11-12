export function buildWhatsAppQrLink({ phoneNumber, projectId, qrId }) {
    const phone = String(phoneNumber || "").replace(/\D/g, "");
    const project = String(projectId || "").trim();
    const qr = String(qrId || "").trim();
    if (!/^\d{7,15}$/.test(phone) || !project || !qr) return "";

    const message = `Hello! I'd like to connect. (Project ID: ${project}) [Ref: ${qr}]`;
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}
