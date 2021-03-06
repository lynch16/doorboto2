// doorboto_test.mjs Copyright 2020 Manchester Makerspace MIT Licence
const { authorize, cronUpdate, checkStanding } = require('./doorboto.js');
const {
  createCardArray,
  createCards,
  rejectedCard,
  acceptedCard,
} = require('./storage/on_site_cache_test.js');
const { cacheSetup, updateCard } = require('./storage/on_site_cache.js');
const fs = require('fs/promises');
const { connectDB, insertDoc } = require('./storage/mongo.js');
const oid = require('./storage/oid.js');

const TEST_PATH = `${__dirname}/test_storage/`;
const REJECTION = 'rejections';
const CHECKIN = 'checkins';
const CARDS = 'cards';
const COLLECTIONS = [CARDS, CHECKIN, REJECTION];

// Members should be able to authorize solely on cache
// Unit test to run without database env vars
const noValidDbTest = async () => {
  console.log(`running no valid db test in ${TEST_PATH}`);
  try {
    await cacheSetup(TEST_PATH);
    const cards = [acceptedCard(), rejectedCard()];
    await createCards(cards);
    for (let i = 0; i < cards.length; i++) {
      await authorize(cards[i].uid, authorized => {
        const status = authorized ? 'checked in' : 'rejected';
        console.log(`${cards[i].holder} was ${status} without database`);
      }).catch(console.log);
    }
  } catch (error) {
    console.log(`Authorize test issue => ${error}`);
  } finally {
    await fs.rmdir(TEST_PATH, { recursive: true });
    // Recursive option to be deprecated? No promise/async fs.rm? Confusing
  }
};

const itUnderstandsGoodStanding = () => {
  console.log(`Running is good standing test`);
  const cardData = acceptedCard();
  const standing = checkStanding(cardData);
  try {
    const { authorized, cardData, msg } = standing;
    if (authorized) {
      console.log(
        `correctly assessed standing "${msg}" for ${cardData.holder}`
      );
    } else {
      throw new Error('data should be in good standing but assessed as not');
    }
  } catch (error) {
    console.log(`goodStanding => ${error}`);
  }
};

const itUnderstandsBadStanding = () => {
  console.log(`running is bad standing test`);
  const cardData = rejectedCard();
  const standing = checkStanding(cardData);
  try {
    const { authorized, cardData, msg } = standing;
    if (authorized) {
      throw new Error('data should be in bad standing but assessed as good');
    } else {
      console.log(
        `correctly assessed standing "${msg}" for ${cardData.holder}`
      );
    }
  } catch (error) {
    console.log(`badStanding => ${error}`);
  }
};

// Integration test to run with Mongo
const recordsRejection = async () => {
  console.log(`running records rejection test in ${TEST_PATH}`);
  try {
    await cacheSetup(TEST_PATH);
    const uid = oid();
    await authorize(uid, authorized => {
      const result = authorized ? 'FAILURE' : 'SUCCESS';
      const status = authorized ? 'accepted' : 'rejected';
      console.log(`${result}: this card was ${status}`);
    });
    const { db, client } = await connectDB();
    const rejectDoc = await db.collection(REJECTION).findOne({ uid });
    const rejectedResult = rejectDoc ? 'SUCCESS' : 'FAILURE';
    const rejectedStatus = rejectDoc ? 'inserted rejection' : 'did not insert';
    console.log(`${rejectedResult}: ${rejectedStatus} into database`);
    await client.close();
  } catch (error) {
    console.log(`Records rejection => ${error}`);
  } finally {
    await fs.rmdir(TEST_PATH, { recursive: true });
    // Recursive option to be deprecated? No promise/async fs.rm? Confusing
  }
};

// integration test with backup of members collection
const canUpdateCacheOfMembers = async () => {
  console.log(`It can update a cache of members`);
  try {
    await cacheSetup(TEST_PATH);
    const cards = createCardArray(2);
    const { db, client } = await connectDB();
    for (let i = 0; i < cards.length; i++) {
      await db.collection(CARDS).insertOne(insertDoc(cards[i]));
    }
    client.close();
    await cronUpdate(false);
  } catch (error) {
    console.log(`canUpdateCacheOfMembers => ${error}`);
  }
};

// integration test to maintain a key but subtle expected behaviour
// A database request should not block first attempt to authorize a key against cache
// if it does this causes significant lag in the doors reaction to authorized key holders
const itCanOpenDoorQuickly = async () => {
  console.log(`It can quickly open the door, USE REMOTE DB LIKE PROD`);
  await cacheSetup(TEST_PATH);
  const card = acceptedCard();
  updateCard(card);
  const { db, client } = await connectDB();
  await db.collection(CARDS).insertOne(insertDoc(card));
  await client.close();
  const startMillis = Date.now();
  await authorize(card.uid, authorized => {
    const authMillis = Date.now();
    const authDuration = authMillis - startMillis;
    const status = authorized && authDuration < 30 ? 'SUCCESS' : 'FAILURE';
    console.log(`${status}: It took ${authDuration} millis to authorize`);
  });
  const finishMillis = Date.now();
  const finishDuration = finishMillis - startMillis;
  console.log(`it took ${finishDuration} millis to finish`);
};

// integration test to see if database is double checked if cache is out of data
const canAuthRecentlyUpdated = async() => {
  console.log(`running can auth recent update test in ${TEST_PATH}`);
  try {
    await cacheSetup(TEST_PATH);
    const card = acceptedCard();
    // invalidate card in cache
    updateCard({
      ...card,
      validity: 'lost',
    });
    const { db, client } = await connectDB();
    // put the legitimate version of the card in the db
    await db.collection(CARDS).insertOne(insertDoc(card));
    // now test to see what happens
    let checkCount = 0;
    const startMillis = Date.now();
    await authorize(card.uid, authorized => {
      const result = authorized ? 'SUCCESS' : 'FAILURE';
      const status = authorized ? 'accepted' : 'rejected';
      console.log(`${result}: this card was ${status}`);
      checkCount++;
      const finishMillis = Date.now();
      const finishDuration = finishMillis - startMillis;
      console.log(`it took ${finishDuration} millis to auth a new user`);
    });
    if(checkCount !== 1){
      console.log(`FAILURE: Check standing was called more than once or not at all`);
    }
    const checkinDoc = await db.collection(CHECKIN).findOne({ name: card.holder });
    const checkinResult = checkinDoc ? 'SUCCESS' : 'FAILURE';
    const checkinStatus = checkinDoc ? 'inserted checkin' : 'did not checkin';
    console.log(`${checkinResult}: ${checkinStatus} into database`);
    await client.close();
  } catch (error) {
    console.log(`Auth recent update => ${error}`);
  } finally {
    await fs.rmdir(TEST_PATH, { recursive: true });
    // Recursive option to be deprecated? No promise/async fs.rm? Confusing
  }
}

// fresh db start for integration test
const cleanUpDb = async () => {
  const { db, client } = await connectDB();
  const promises = [];
  COLLECTIONS.forEach(collection => {
    promises.push(db.collection(collection).drop());
  });
  for (let i in promises) {
    try {
      await promises[i];
    } catch (error) {
      if(error !== 'MongoError: ns not found'){
        console.log(`cleanUpDb => ${error}`);
      }
    }
  }
  await client.close();
};

module.exports = {
  noValidDbTest,
  canUpdateCacheOfMembers,
  recordsRejection,
  itUnderstandsGoodStanding,
  itUnderstandsBadStanding,
  itCanOpenDoorQuickly,
  canAuthRecentlyUpdated,
  cleanUpDb,
};
