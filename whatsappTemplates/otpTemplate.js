export default {
  "template_id": "a6zh31a81615122c4uyv3n12r46qzrv68l7a4qu0a8n",
  "waba_template_id": "1639063914895411",
  "category": "AUTHENTICATION",
  "language_code": "en",
  "create_date": "2026-06-22 23:44:30",
  "template_name": "login_otp",
  "status": "APPROVED",
  "reject_reason": "NONE",
  "template": {
    "name": "login_otp",
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
