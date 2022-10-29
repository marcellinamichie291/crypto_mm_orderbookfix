import ccxt from 'ccxt';
import express from 'express'
import {MongoClient, ServerApiVersion} from 'mongodb'
import fs from 'fs'


const MONGO_DB_USERNAME = 'cryptomm';
const MONGO_DB_PASSWORD = 'JC4o7utaG8Si7ALu';


const app = express();
const port = process.env.PORT || 10000;
let whitebit;
let storyMarket;
let mongoClient;
let minimumAmount;
let minimumCost;
let storyBalance;
let STORY_SYMBOL = 'STORY/USDT';
let STORY_ID = 'STORY_USDT';
let STORY_TICKER = 'STORY';
let USDT_TICKER = 'USDT';
let minOrdersEachSide = 30;
let minSpread = 0.03;
let spreadletiation = 5;
let fakeOrderVariationAmount = 0.02;
let nextOrderMin = 10;
let nextOrderMax = 30;
let minimumCostMultiplier = 1;
let fixBookEveryHours = 24;
let localSettings;
// app.listen(port, async () => {
//     console.log('Server started on ' + port);
//     await main();
// });
app.listen(port, async () => {

    await initMangoDb();
    console.log(`Server listening on port ${port}`)
    localSettings = await getSettings();
    localSettings.hostPort = port;
    await updateSettings(localSettings);
    await setLocalSettings(localSettings);
    initExchange();
    await initMarketAndSetLimits();
    await init();
});

async function fixBooks() {
    await cancelAllOrders();
    await sleep(10000);
    await fixAskBook();
    await fixBidBook();
}

app.get('/', async (req, res) => {
    initExchange();
    await initMarketAndSetLimits();
    await initMangoDb();
    await log('Triggered at ' + new Date());
    localSettings = await getSettings();
    localSettings.hostPort = port;
    await updateSettings(localSettings);
    await setLocalSettings(localSettings);
    await main();
    res.set('Success');
})

async function cancelAllOrders() {
    let myOrders = await fetchOpenOrders();
    for (const myOrder in myOrders) {
        var results = await cancelOrder(myOrders[myOrder].id);
        await sleep(10000);
    }
}

async function cancelOrder(orderId) {
    var result = await whitebit.cancelOrder(orderId, STORY_SYMBOL);
    return result;
}

async function getSettings() {
    // const collection = (await mongoClient.db("crypto_mm").collection("Orders")).find().limit(1).sort({$natural:-1});
    const settings = await mongoClient
        .db('crypto_mm')
        .collection('Settings')
        .find().limit(1).next();
    return settings;
}

async function setLocalSettings(settings) {
    nextOrderMin = settings?.nextOrderMin ?? 10;
    nextOrderMax = settings?.nextOrderMax ?? 30;
    minimumCostMultiplier = settings?.minimumCostMultiplier ?? 1;
    fixBookEveryHours = settings?.fixBookEveryHours ?? 24;
}

async function updateSettings(settings) {
    var currentSettings = (await mongoClient.db("crypto_mm").collection("Settings")).find().limit(1).sort({$natural: -1});
    const result = await mongoClient
        .db('crypto_mm')
        .collection('Settings').update({_id: settings._id}, {$set: {hostPort: settings.hostPort}});
    return result;
}

async function checkAndFixBooks() {
    try {
        let lastFixBook = await getLastFixBook();
        await log('Checking order books at ' + new Date());
        if (!lastFixBook) {
            await log('Fixing books at ' + new Date());
            await fixBooks();
            await addNewFixBook(fixBookEveryHours * 60, new Date());
            await log('Books fixed at ' + new Date());

        } else {
            if (lastFixBook.nextFixBookAt > new Date()) {
                await log('Fixing books at ' + new Date());
                await fixBooks();
                await addNewFixBook(fixBookEveryHours * 60, new Date());
                await log('Books fixed at ' + new Date());
            } else {
                await log('Skipping fix order books at ' + new Date());
            }
        }
    } catch (e) {
        await log('Error fixing books ' + e);
        await addNewFixBook(0, new Date());
    }
}

async function init() {
    await checkAndFixBooks();
}


function addMinutes(date, minutes) {
    return new Date(new Date(date.getTime() + minutes * 60000));
}

async function fetchOpenOrders() {
    return await whitebit.fetchOpenOrders(STORY_SYMBOL);
}

async function fixAskBook() {
    let myOrders = await fetchOpenOrders();
    let orders = [];
    let minAsk = await getMinNextAsk();
    for (let i = 0; i < minOrdersEachSide; i++) {
        let tempNextAsk;
        if (orders[i - 1]) {
            tempNextAsk = orders[i - 1].ask + (orders[i - 1].ask * (minSpread / spreadletiation));
        } else {
            tempNextAsk = minAsk + (minAsk * (minSpread / spreadletiation));
        }
        let skip = false;
        for (let i = 0; i < myOrders.length; i++) {
            let tempOrder = myOrders[i];
            let withinPriceRange = await askWithinPriceRange(tempOrder.price, tempNextAsk);
            skip = (tempOrder.side === "sell" && withinPriceRange === true);
        }
        orders.push({ask: tempNextAsk, skip});

    }
    for (let i = 0; i < orders.length; i++) {
        if (orders[i].skip) {

        } else {
            await sleep(10000);
            let order = await placeAsk(minimumAmount, orders[i].ask);
            orders[i].order = order;
        }
    }
}

async function fixBidBook() {
    let myOrders = await fetchOpenOrders();
    let orders = [];
    let bid = await getStoryPriceBid();
    for (let i = 0; i < minOrdersEachSide; i++) {
        let tempNextBid;
        if (orders[i - 1]) {
            tempNextBid = orders[i - 1].bid - (orders[i - 1].bid * (minSpread / spreadletiation));
        } else {
            tempNextBid = bid - (bid * (minSpread / spreadletiation));
        }
        let skip = false;
        for (let i = 0; i < myOrders.length; i++) {
            let tempOrder = myOrders[i];
            let withinPriceRange = await askWithinPriceRange(tempOrder.price, tempNextBid);
            skip = (tempOrder.side === "buy" && withinPriceRange === true);
        }
        orders.push({bid: tempNextBid, skip});

    }
    for (let i = 0; i < orders.length; i++) {
        if (orders[i].skip) {

        } else {
            await sleep(10000);
            let order = await placeBid(minimumAmount, orders[i].bid);
            orders[i].order = order;
        }
    }
}

async function askWithinPriceRange(currentPrice, newPrice) {
    return Math.abs(currentPrice - newPrice) > (minSpread / spreadletiation);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function placeBid(bidAmount, bidPrice) {
    if (bidPrice * bidAmount < minimumCost) {
        bidAmount = (minimumCost + 0.01) / bidPrice;
    }
    await log('Waiting.');
    let successOrder = (await whitebit.createLimitBuyOrder(STORY_SYMBOL, bidAmount, bidPrice));
    await log('Bid Order Placed. - ' + bidPrice);
    return successOrder;
}

async function placeAsk(askAmount, askPrice) {
    if ((askPrice * askAmount) < minimumCost) {
        askAmount = (minimumCost + 0.01) / askPrice;
    }
    await log('Waiting.');
    let successOrder = (await whitebit.createLimitSellOrder(STORY_SYMBOL, askAmount, askPrice));
    await log('Ask Order Placed. - ' + askPrice);
    return successOrder;
}

async function placeNextAsk(askAmount, startAsk) {
    let orderBook = await getStoryOrderBook();
    if (askAmount == null) {
        askAmount = minimumAmount;
    }
    let storyPriceBid = await getStoryPriceBid();
    if (!startAsk) {
        startAsk = await getStoryPriceAsk();
    }
    let minNextAsk = parseFloat((storyPriceBid + (storyPriceBid * minSpread)).toFixed(8));
    let nextAsk;

    if (startAsk === minNextAsk || minNextAsk > startAsk) {
        nextAsk = startAsk + (startAsk * minSpread);
    } else {
        nextAsk = minNextAsk;
    }
    if (nextAsk * askAmount < minimumCost) {
        askAmount = (minimumCost + 0.01) / nextAsk;
    }
    let successOrder = (await whitebit.createLimitSellOrder(STORY_SYMBOL, askAmount, nextAsk));
    return successOrder;
}

async function placeNextBid(bidAmount) {

    if (bidAmount == null) {
        bidAmount = minimumAmount;
    }
    let storyPrice = await getStoryPriceBid();
    let nextAsk = storyPrice - (storyPrice * minSpread);
    if (nextAsk * bidAmount < minimumCost) {
        bidAmount = (minimumCost + 0.01) / nextAsk;
    }
    let successOrder = (await whitebit.createLimitBuyOrder(STORY_SYMBOL, bidAmount, nextAsk));
    return successOrder;
}

async function initMarketAndSetLimits() {
    storyMarket = await getStoryMarket();
    minimumAmount = storyMarket.limits.amount.min;
    minimumCost = storyMarket.limits.cost.min;
}

async function initMangoDb() {
    const uri = "mongodb+srv://cryptomm:" + MONGO_DB_PASSWORD + "@cluster0.krtsnjs.mongodb.net/?retryWrites=true&w=majority";
    mongoClient = new MongoClient(uri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverApi: ServerApiVersion.v1
    });
    await mongoClient.connect();
    // const collection = (await mongoClient.db("crypto_mm").collection("Orders")).find().limit(1).sort({$natural:-1});
}

async function addNewOrder(nextOrderInMinutes, lastOrderPlacedAt) {
    const orderTemp = {nextOrderAt: addMinutes(new Date(), nextOrderInMinutes), lastOrderPlacedAt};
    const result = await mongoClient
        .db('crypto_mm')
        .collection('Orders').insertOne(orderTemp);
    return result;
}

async function addNewFixBook(nextFixBookInMinutes, lastFixBookPlacedAt) {
    const fixbookTemp = {nextFixBookAt: addMinutes(new Date(), nextFixBookInMinutes), lastFixBookPlacedAt};
    const result = await mongoClient
        .db('crypto_mm')
        .collection('FixBooks').insertOne(fixbookTemp);
    return result;
}

async function getLastFixBook() {
    const fixbook = await mongoClient
        .db('crypto_mm')
        .collection('FixBooks')
        .find().limit(1).sort({$natural: -1}).next();
    return fixbook;
}

async function getLastOrder() {
    // const collection = (await mongoClient.db("crypto_mm").collection("Orders")).find().limit(1).sort({$natural:-1});
    const latestOrder = await mongoClient
        .db('crypto_mm')
        .collection('Orders')
        .find().limit(1).sort({$natural: -1}).next();
    return latestOrder;
}

function initExchange() {
    whitebit = new ccxt.whitebit({
        apiKey: '221342a58d53de69321e62a034994653',
        secret: '266ccd5332d19da7489821fb2d8efb13',
    })
}

function getRandomNumberBetween(maximum, minimum) {
    let randomnumber = Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
    return randomnumber;
}

async function getMinNextAsk() {
    let storyPriceBid = await getStoryPriceBid();

    let minNextAsk = parseFloat((storyPriceBid + (storyPriceBid * minSpread)).toFixed(8));
    return minNextAsk;
}

async function getStoryBalance() {
    return (await whitebit.fetchBalance())[STORY_TICKER];
}

async function getUsdtBalance() {
    return (await whitebit.fetchBalance())[USDT_TICKER];
}

async function getFreeUsdtBalance() {
    return (await getUsdtBalance()).free;
}

async function getFreeStoryBalance() {
    return (await getStoryBalance()).free;
}

async function getStoryPriceBid() {
    let bid = (await getStoryTicker()).bid;
    return bid;
}

async function getStoryPriceAsk() {
    let ask = (await getStoryTicker()).ask;
    return ask;
}

async function getStoryOrderBook() {
    let orderBook = (await whitebit.fetchOrderBook(STORY_SYMBOL));
    return orderBook;
}

async function getStoryTicker() {
    return await whitebit.fetchTicker(STORY_SYMBOL);
}

async function getStoryMarket() {
    let markets = (await whitebit.fetchMarkets());
    return markets.find(c => c.id === STORY_ID);
}

function genRandomDecimal(max, min, decimalPlaces = 0) {
    var rand = Math.random() < 0.5 ? ((1 - Math.random()) * (max - min) + min) : (Math.random() * (max - min) + min);  // could be min or max or anything in between
    var power = Math.pow(10, decimalPlaces);
    return Math.floor(rand * power) / power;
}

async function fakeOrder() {
    let buyOrSell = getRandomNumberBetween(2, 1);
    let order;
    if (buyOrSell === 1) {
        //Do buy
        order = await fakeBuyOrder();
        order.type = "buy";
    } else {
        //Do sell
        order = await fakeSellOrder();
        order.type = "sell";
    }
    return order;

}

async function fakeBuyOrder() {
    let askPrice = await getStoryPriceAsk();
    let bidPrice = await getStoryPriceBid();
    let usdtBalance = await getFreeUsdtBalance();
    fakeOrderVariationAmount = genRandomDecimal(0.03, 0.005, 3);

    let price = askPrice - (askPrice * fakeOrderVariationAmount);
    if (price < bidPrice) return;
    let fakeAmount = getRandomNumberBetween(usdtBalance, minimumCost * minimumCostMultiplier);
    while (fakeAmount > usdtBalance) {
        fakeAmount -= 5;
    }
    let askOrder = await placeAsk(fakeAmount / price, price);
    let bidOrder = await placeBid(fakeAmount / price, price);
    await log('BUY ORDER - Ask placed' + askOrder.price);
    await log('BUY ORDER - Bid placed' + bidOrder.price);
    await log('BUY ORDER - Amount ' + fakeAmount);
    let lastOrderPlacedAt = new Date();
    await log('BUY ORDER - Successful at ' + lastOrderPlacedAt);
    return lastOrderPlacedAt;
}

async function fakeSellOrder() {
    let bidPrice = await getStoryPriceBid();
    let askPrice = await getStoryPriceAsk();
    let storyBalanceInUsd = (await getFreeStoryBalance()) * bidPrice;
    let usdtBalance = await getFreeUsdtBalance();

    fakeOrderVariationAmount = genRandomDecimal(0.03, 0.005, 3);

    let price = bidPrice + (bidPrice * fakeOrderVariationAmount);
    if (price > askPrice) return;
    let fakeAmount = getRandomNumberBetween(storyBalanceInUsd, minimumCost * minimumCostMultiplier);
    if (fakeAmount > storyBalanceInUsd) {
        fakeAmount = getRandomNumberBetween(storyBalanceInUsd, minimumCost);
    }
    while (fakeAmount > usdtBalance) {
        fakeAmount -= 5;
    }
    while (fakeAmount > storyBalanceInUsd) {
        fakeAmount -= 5;
    }
    let bidOrder = await placeBid(fakeAmount / price, price);
    await sleep(1000);
    let askOrder = await placeAsk(fakeAmount / price, price);
    await log('SELL ORDER - Ask placed' + askOrder.price);
    await log('SELL ORDER - Bid placed' + bidOrder.price);
    await log('SELL ORDER - Amount ' + fakeAmount);
    let lastOrderPlacedAt = new Date();
    await log('SELL ORDER - Successful at ' + lastOrderPlacedAt);
    return lastOrderPlacedAt;

}


async function main() {

    try {
        await init();
    } catch (e) {
        if (e.message.toString().includes('whitebit 429 Too Many Requests')) {
            await log('rerun...')
        }
    }
}

async function log(message) {
    console.log(message);
    const logItem = {message, time: new Date()};
    const result = await mongoClient
        .db('crypto_mm')
        .collection('Logs').insertOne(logItem);
    return result;

}



