const { WebSocket } = require("ws");
const feeRouteAbiJSON = require("./dodoFeeRoute.json");
const dvmAbiJSON = require("./DVM.json");
const ethers = require("ethers");
const { default: axios } = require("axios");

const wsUrl = process.env.RFQ_SERVIVE_WEBSOCKET; //test env: wss://rfq-order.gcp.dxd.ink/maker
const httpUrl = process.env.RFQ_SERVIVE_API; //test env: https://rfq-order.gcp.dxd.ink
const maker = "you_maker_address";
const marketer = "you_marketer_name";
const makerSecret = "you_secret==";
const yourPrivateKey = "0x0000000000000x";


const isJSON = (data) => {
    try {
        if (typeof JSON.parse(data) === 'object') {
            return true;
        }
    } catch (_) {}
    return false;
}


const listenWs = () => {
    const socket = new WebSocket(`${wsUrl}?marketer=${marketer}&makersecret=${makerSecret}`);
    socket.onopen = () => {
        console.log("open")
    
        socket.onmessage = (event) => {
            if (isJSON(event.data.toString())) {
                const data = JSON.parse(event.data.toString());
                if (data["event"] === "offer") {
                    // process quote requests
                    /**
                     * event payload data structure
                     * {
                     *  inquiryId: string; //request quote id, eg: 60f0b2d3-efa8-4b60-9c2e-1ecfa3da3e6d
                     *  chainId: integer; //chain id, eg: 11155111
                     *  makerToken: string; //to token address, eg: 0x7B07164ecFaF0F0D85DFC062Bc205a4674c75Aa0
                     *  takerToken: string; //from token address, eg: 0x3b93c2f7c4e09167e7eef577c7f792af9e85d341
                     *  taker: string; //taker address, eg: 0x3c9f68e0F63541168907253acd3149b70b2F45C2
                     *  takerAmount: string; //from token amount:, eg: 10000000000000000
                     * }
                     */
                    const { inquiryId, chainId, makerToken, takerToken, taker, takerAmount } = data.payload;
                    makerOffer(inquiryId, chainId, makerToken, takerToken, taker, takerAmount, socket);
                } else if (data["event"] === "offer_result") { // you can try this function(getOfferResult) to get all offer result
                    // submit transaction to chain
                    /**
                     * event payload data structure
                     * {
                     *  inquiryId: string; //request quote id, eg: 60f0b2d3-efa8-4b60-9c2e-1ecfa3da3e6d
                     *  chainId: integer; //chain id, eg: 11155111
                     *  callContract: string; //contract address, eg: 0x9ad32e3054268B849b84a8dBcC7c8f7c52E4e69A
                     *  calldata: string; //call data, eg: 0x9ae78b5a000000000000000000000000eee13739763a1b0f062846ef4a102886673c89bd000000000000
                     * }
                     */
                    const { inquiryId, chainId, callContract, calldata } = data.payload;
                    sendOrder(inquiryId, chainId, callContract, calldata, socket)
                }
            } else {
                console.log('Client received message: ', event.data);
            }
        };

    };
}

const rpcUrls = {
    11155111: "https://api.zan.top/node/v1/eth/sepolia/public"
}

// get dodo route proxy: https://docs.dodoex.io/en/developer/contracts/dodo-v1-v2/contracts-address
// e.g: ethereum DODOFeeRouteProxy: https://docs.dodoex.io/en/developer/contracts/dodo-v1-v2/contracts-address/ethereum#proxy
const dodoFeeRoutes = {
    11155111: "0xb38D394D52A15910b8acc173b816624dc90066cd"
}

//fake dodo v2 pool
const dvms = {
    11155111: "0xFfa078bb0c246019F5C0316494651D987780Caf5"
}

/**
 * @param {string} taker        e.g: 0xeee13739763a1b0f062846ef4a103886573c89bf
 * @param {int} chainId         e.g: 11155111
 * @param {string} makerToken   e.g: 0x3b93c2f7c4e09167e7eef577c7f792af9e85d341 (e.dodo)
 * @param {string} takerToken   e.g: 0x7B07164ecFaF0F0D85DFC062Bc205a4674c75Aa0 (weth)
 * @param {string} takerAmount  e.g: 100000000000000000000
 * @param {int} expiration      e.g: 1718637768
 */
const buildCalldata = async (taker, chainId, makerToken, takerToken, takerAmount, expiration) => {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrls[chainId]);

    const dodoFeeRoute = dodoFeeRoutes[chainId]; //dodo fee route proxy
    const dodoFeeRouteAbi = new ethers.Contract(dodoFeeRoute, feeRouteAbiJSON, provider);


    // note: replace this steps, it used to build externalCalldata
    const dvm = dvms[chainId];
    const dvmAbi = new ethers.Contract(dvm, dvmAbiJSON, provider);
    const approveTarget = dodoFeeRoute;
    const swapTarget = dodoFeeRoute;

    const externalCalldata = dvmAbi.interface.encodeFunctionData("sellBase", [taker]);
    // build externalCalldata end

    // note: this step is an example to calc how much makerToken you will return
    const queryResult = await dvmAbi.callStatic.querySellBase(taker, takerAmount);
    const receiveQuoteAmount = queryResult.receiveQuoteAmount.toString();
    // calc receiveQuoteAmount end

    const minReturnAmount = receiveQuoteAmount;

    const calldata = dodoFeeRouteAbi.interface.encodeFunctionData(
        "externalSwap",
        [
            takerToken, //fromTokenAddress
            makerToken, //toTokenAddress
            approveTarget, //approveTarget
            swapTarget, //swapTarget
            takerAmount, //fromAmount
            minReturnAmount, //minReturnAmount
            "0x00", //feeData
            externalCalldata, //callDataConcat
            expiration, //deadLine
        ]
    )

    return { calldata, to: dodoFeeRoutes[chainId], minReturnAmount }
}

const makerOffer = async (inquiryId, chainId, makerToken, takerToken, taker, takerAmount, socket = undefined) => {
    // you can replace this to change tx deadline
    const expiration = Math.floor(new Date().getTime() / 1000 + 300);

    const { calldata, to, minReturnAmount } = await buildCalldata(taker, chainId, makerToken, takerToken, takerAmount, expiration);
    if (socket) {
        socket.send(JSON.stringify({
            event: "offer",
            payload: {
                inquiryId,
                maker, 
                marketer, 
                makerAmount: minReturnAmount, 
                expiration, 
                data: calldata, 
                to
            }
        }));
    } else {
        try {
            const res = await axios.post(`${httpUrl}/api/v1/rfq/offer`, {
                inquiryId,
                maker, 
                marketer, 
                makerAmount: minReturnAmount, 
                expiration, 
                data: calldata, 
                to
            }, { headers: { makersecret: makerSecret } });
            console.log(res.data)
            /*
                {
                    "data": "success"
                }
            */
        } catch (e) {
            console.log(e.message)
        }
    }
}

const sendOrder = async (inquiryId, chainId, callContract, calldata, socket = undefined) => {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrls[chainId]);
    const gasPrice = await provider.getGasPrice();

    const signer = new ethers.Wallet(yourPrivateKey, provider);
    const nonce = await provider.getTransactionCount(signer.address, "pending");
    const tx = {
        from: signer.address,
        to: callContract,
        data: calldata,
        chainId,
        nonce,
        gasPrice: gasPrice.toString(),
        gasLimit: 8000000
    }

    const rawTx = await signer.signTransaction(tx);
    const hash = await provider.send("eth_sendRawTransaction", [rawTx]);

    if (socket) {
        socket.send(JSON.stringify({
            event: "fill",
            payload: {
                inquiryId,
                marketer: config.makerter, 
                hash,
                maker: config.maker,
                status: fillResult ? "success": "fail"
            }
        }));
    } else {
        try {
            const res = await axios.post(`${httpUrl}/api/v1/rfq/order/update`, {
                inquiryId,
                marketer: config.makerter, 
                hash,
                maker: config.maker
            }, { headers: { makersecret: config.makerSecret } });
            console.log(res.data)
            /*
                {
                    "data": "success"
                }
            */
        } catch (e) {
            console.log(e.message)
        }
    }
}


listenWs()