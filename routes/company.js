import express from "express";

const router = express.Router();

router.get("/support", async (req, res) => {

    return res.status(200).json({
        error: false,
        data: {
            phone: [
                {
                    number: "917364076458",
                    type: "Technical Support"
                },
                {
                    number: "917364076458",
                    type: "Sales Support"
                }
            ],
            whatsapp: [
                {
                    number: "917364076458",
                    type: "Technical Support"
                },
                {
                    number: "917364076458",
                    type: "Sales Support"
                }
            ],
            email: [
                {
                    email: "souravadhikary1916@gmail.com",
                    type: "Technical Support"
                },
                {
                    email: "souravadhikary1916@gmail.com",
                    type: "Sales Support"
                }
            ]
        },
        msg: "Support details fetch successfully"
    })
});

export default router;
