'use strict';
const logger = require('winston');
const request = require("request");
const sqlite3 = require('sqlite3');
var s3 = require('s3');
const fs = require('fs');
const db = new sqlite3.Database('db.sqlite');
var sleep = require('sleep');
const lbry = require('lbry-nodejs');

let _channelID;
let _customTag;
let _videosLocation;
let _channelName;
let _limit;
let _claimPrice;
let _authorWallet;
const MAX_RETRIES = 0;

class BerkeleySync {
  /**
  * 		
  * @param {String} channelID the id of the channel you wish to claim
  * @param {String} customTag an identifying tag for the claim name
  * @param {Integer} limit how many claims for a given channel should be processed in total
  * @param {String} videosLocation where is the location of the videos
  * @param {Integer} claimPrice what price should an user pay for the claimed video
  * @param {String} authorWallet if a claim price is specified, where should the fee be sent to?		
  */
  constructor(channelID, customTag, limit, videosLocation, claimPrice, authorWallet) {
    _channelID = channelID;
    _customTag = customTag;
    _videosLocation = videosLocation;
    _limit = limit;
    _claimPrice = claimPrice;
    _authorWallet = authorWallet;

    //this doesn't actually fix the race condition...		
    //basically the query creates the table in the database on the first run		
    //however it takes longer to execute this than to proceed further in the code and reach the first query of the table...
    db.serialize(function () {
      db.run("CREATE TABLE IF NOT EXISTS syncd_videos (videoid TEXT UNIQUE, claimname TEXT, claim_id TEXT, lbrychannel TEXT)");
    });
    //dirty bypass		
    sleep.msleep(500);
  }
}

/**
 * Setter for the LBRY channel
 */
BerkeleySync.prototype.setChannel = function (channel) {
  _channelName = channel;
  return checkChannelOwnership();
};

BerkeleySync.prototype.performSyncronization = function () {
  let processVideo = function (data) {
    let promises = data.map(row => {
      return downloadVideo(row)
        .then(setupPayload)
        .then(publish)
        .then(savePublish)
        .catch(reason => {
          logger.error("There was a problem processing %s: %s", row.videoid, reason);
        });
    });
    return Promise.all(promises);
  };

  return lbry.status()
    .then(daemonStatus => {
      if (daemonStatus.result.is_running === true)
        return getAllUnprocessedVideos()
          .then(processVideo);
      return Promise.reject('The daemon is not running');
    });
};

/** 
 * Call this function to verify if a given channel name is owned
*/
function checkChannelOwnership() {
  return new Promise(function (fulfill, reject) {
    var options = {
      method: 'POST',
      url: 'http://localhost:5279/lbryapi',
      body: '{"method":"channel_list_mine" }'
    };

    request(options, function (error, response, body) {
      if (error) {
        return reject(error);
      }
      let resultSet = JSON.parse(body)['result'];
      for (let item of resultSet) {
        if (item.name === _channelName)
          return fulfill({ owned: true });
      }
      return reject({ channel_owned: false });
    });
  });
}

function getAllUnprocessedVideos() {
  //maximum amount of videos sync'd to LBRY in one run
  //console.log(_channelID);
  return new Promise(function (fulfill, reject) {
    //sync'd videos are not sync'd anymore, so every time the script is called it will upload $limit new videos
    const query =
      "SELECT videoid,channelid,fulltitle,description, thumbnail, data " +
      "FROM videos WHERE downloaded = 1 " +
      "AND videos.videoid NOT IN (select videoid FROM syncd_videos) " +
      "AND videos.channelid = '" + _channelID + "'" +
      ((_limit > 0) ? (" LIMIT " + _limit + ";") : ';');
    //console.log(query);

    db.all(query,
      function (err, rows) {
        if (err) {
          reject(err);
        }
        else {
          fulfill(rows);
        }
      });
  });
}

//construction of the payload needed for the publish method
function setupPayload(row) {
  const filename = row.videoid + ".mp4";
  let name = _customTag + "-" + row.videoid.replace(/[^A-Za-z0-9\-]/g, '-');
  let filePath = _videosLocation + row.channelid + '/' + filename;
  return new Promise(function (fulfill, reject) {
    //publications should all be grouped in one address, the best way to do it it's probably not the following, however
    //I will just grab the first address from the wallet_list... this should stay consistant hopefully!
    return lbry.wallet_list()
      .then(result => {
        if (result.hasOwnProperty('result') && Array.isArray(result.result)) {
          let claimAddress = result.result[0];
          logger.info("[YT-LBRY] result %s ", claimAddress);
          //check if the address starts with b (all LBRY addresses do)
          if (claimAddress.indexOf('b') === 0) {
            let payload = {
              params: {
                //claim names only allow chars and numbers and dashes
                name: name,
                file_path: filePath,
                claim_address: claimAddress,
                change_address: claimAddress, //I guess it's alright to have the change end up in the same address as the claim address
                bid: 0.01,
                author: JSON.parse(row.data).channelTitle,
                description: row.description,
                language: "en",
                license: "Creative Commons License",
                nsfw: false,
                //this could become row.thumbnail however thumbs that failed uploading would cause claims to have invalid URLS until updated
                thumbnail: "http://berk.ninja/thumbnails/" + row.videoid,
                title: row.fulltitle,
                channel_id: 'de0fcd76d525b1db36f24523e75c28b542e92fa2'
              }
            };

            //if the user has specified a channel, then the claim will be attached to such channel
            if (_channelName !== null) {
              payload.params.channel_name = _channelName;
            }

            return fulfill({ payload: payload, filename: filename, videodata: row });
          }
        }
        //TODO: if it fails then it means that there are no addresses in the wallet. One should be created (wallet_unused_address)
        //https://lbryio.github.io/lbry/#wallet_unused_address
        return reject({ error: 'error in selecting the destination address', details: result });
      })
      .catch(reject);
  });
};

/**
 * publish to lbry
 * @param {Object} payloadBundle
 */
function publish(payloadBundle, failures) {
  if (typeof failures === 'undefined') {
    failures = 0;
  }
  logger.info("Publishing %s - %s", payloadBundle.payload.params.name, payloadBundle.payload.params.title);
  return new Promise(function (fulfill, reject) {
    return lbry.publish(payloadBundle.payload.params.name, 0.01, payloadBundle.payload.params)
      .catch(reject)
      .then(body => {
        if (body.hasOwnProperty('error')) {
          if (failures < MAX_RETRIES) {
            logger.error("Failed to claim %s (%d/3) due to: \n%s", payloadBundle.payload.params.name, failures, JSON.stringify(body));
            return publish(payloadBundle, ++failures).then(fulfill).catch(reject);
          }
          else {
            logger.error("Failed to claim %s due to: \n%s", payloadBundle.payload.params.name, JSON.stringify(body));
            return reject(body);
          }
        }
        else {
          logger.info("[YT-LBRY] Success in publishing %s", payloadBundle.payload.params.name);
          //logger.info("body: %s", JSON.stringify(body));
          return fulfill({ claimname: payloadBundle.payload.params.name, videodata: payloadBundle.videodata, daemonraw: body });
        }
      });
  });
}

function savePublish(publishResponse) {
  return new Promise(function (success, reject) {
    const filename = _videosLocation + _channelID + '/' + publishResponse.videodata.videoid + ".mp4"
    logger.info('Published ' + filename + " to " + publishResponse.claimname);
    db.serialize(function () {
      const stmt = db.prepare("INSERT OR IGNORE INTO syncd_videos VALUES (?,?,?,?);");
      stmt.run(publishResponse.videodata.videoid, publishResponse.claimname, publishResponse.daemonraw.result.claim_id, ((_channelName !== null) ? _channelName : ''));
      stmt.finalize();
    });
    fs.unlink(filename, err => {
      logger.info(err ? ("unlink failed: " + err) : ("file deleted: " + filename));
      return success();
    });
  });
}


/**
 * download a given ucberkeley video to local storage
 * @param {String} s3Path
 * @param {String} filename
 * @param {Object} payload
 */
function downloadVideo(row) {
  const vidDir = '/mnt/bigdrive/videos/';
  const dir = vidDir + row.channelid + '/';
  const output = dir + row.videoid + '.mp4';


  const s3Path = 'videos/' + row.channelid + '/' + row.videoid + '.mp4';

  return new Promise(function (fulfill, reject) {
    const client = s3.createClient({
      maxAsyncS3: 20,     // this is the default
      s3RetryCount: 3,    // this is the default
      s3RetryDelay: 1000, // this is the default
      multipartUploadThreshold: 20971520, // this is the default (20 MB)
      multipartUploadSize: 15728640, // this is the default (15 MB)
      s3Options: {
        accessKeyId: process.env.s3_access_key,
        secretAccessKey: process.env.s3_secret_key,
        region: "us-east-2",
      },
    });

    const params = {
      localFile: output,
      s3Params: {
        Bucket: "lbry-niko2",
        Key: s3Path,
      },
    };

    const downloader = client.downloadFile(params);
    downloader.on('error', function (err) {
      return reject(err);
    });
    downloader.on('end', function () {
      logger.log("done downloading " + output);
      return fulfill(row);
    });
  });
}

module.exports = BerkeleySync;