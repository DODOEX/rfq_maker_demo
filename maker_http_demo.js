const { default: axios } = require("axios");
const { sendOrder } = require("./maker_ws_demo.js");

const httpUrl = process.env.RFQ_SERVIVE_API; //test env: https://rfq-order.gcp.dxd.ink
const marketer = "you_marketer_name";




const delay = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));

const fillOrders = async () => {
    while (1) {
        await delay(1);
        // It is equal to event: offer_result, but you can fetch it by your self
        const res = await axios.get(`${httpUrl}/api/v1/rfq/offer/result`, { params: { marketer, progress: "TAKER_SUBMIT" } });
        await Promise.all(res.data.map(async order => {
            const { inquiryId, chainId, callContract, calldata } = order;
            await sendOrder(inquiryId, chainId, callContract, calldata);
        }))
    }
}

fillOrders()