export default {
  "template_id": "rpple7765ukk28l14gaio3v8nrzlh5o861zic11qtmb",
  "waba_template_id": "2438481639966661",
  "category": "AUTHENTICATION",
  "language_code": "en",
  "create_date": "2026-06-26 00:52:00",
  "template_name": "otp",
  "status": "APPROVED",
  "reject_reason": "NONE",
  "template": {
    "name": "otp",
    "language": "en",
    "category": "AUTHENTICATION",
    "components": [
      {
        "type": "BODY",
        "add_security_recommendation": true
      },
      {
        "type": "FOOTER",
        "code_expiration_minutes": 10
      },
      {
        "type": "BUTTONS",
        "buttons": [
          {
            "type": "OTP",
            "otp_type": "COPY_CODE",
            "text": "Copy code"
          }
        ]
      }
    ]
  }
};
