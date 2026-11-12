export function buildWhatsAppQrLink({ phoneNumber }) {
    const phone = String(phoneNumber || "").replace(/\D/g, "");
    if (!/^\d{7,15}$/.test(phone)) return "";

    const message = "Hello! I'd like to connect.";
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}
