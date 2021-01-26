#!/usr/bin/env node
'use strict'


const cp = require('child_process')
const createTorrent = require('create-torrent')
const ecstatic = require('ecstatic')
const executable = require('executable')
const fs = require('fs')
// const fs = require ('../lib/fs.js')
const http = require('http')
const https = require('https')
const mime = require('mime')
const minimist = require('minimist')
const moment = require('moment')
const networkAddress = require('network-address')
const open = require('open')
const parseTorrent = require('parse-torrent')
const path = require('path')
const MemoryChunkStore = require('memory-chunk-store')
const prettierBytes = require('prettier-bytes')
const stripIndent = require('common-tags/lib/stripIndent')
const WebTorrent = require('webtorrent-hybrid')
var FSChunkStore = require('fs-chunk-store')

// global.WRTC = require('wrtc');
const metadataFetchTimeout = 60;

const express = require('express')
const bodyParser = require('body-parser')
const app = express()

var access = fs.createWriteStream('./node.access.log', { flags: 'a' })
, error = fs.createWriteStream('./node.error.log', { flags: 'a' });

process.stdout.pipe(access);
process.stderr.pipe(error);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const argv = minimist(process.argv.slice(2), {
    alias: {        
        h: 'help',
        p: 'port',
        v: 'version'
    },
    boolean: [ // Boolean options
        // Options (simple)
        'help',
        'version',
        'verbose'
    ],
    default: {
        port: 1873,
        quit: true
    }
})

// start webtorrent client
var client = new WebTorrent()
client.on('error', fatalError)

process.title = 'webtorrent_http_client'

app.get('/', function (req, res) {
    res.send('here')
})

app.get('/:infoHash', (req, res) => {

    var infoHash = req.params.infoHash;

    var alreadyAddedInfoHashes = client.torrents.map(function(t) { return t.infoHash })

    var result = {}

    // I.  pre-ininitalization validations
    if (infoHash.length != 40) {
        result.status = "fail"
        result.reason = "Invalid info_hash length"
    }

    if (alreadyAddedInfoHashes.includes(infoHash)) { // check if torrent is already in the queue
        result.status = "fail"
        result.reason = "Already added"
    }

    // send failure immediately after failing pre-initialization validations
    if (result.status == "fail") {
        return res.send(result) // NB: early return here
    } else {
        res.send({status: "in_progress"})
    }

    
    // II. initializing new torrent
    
    // construct torrentId with trackers
    let torrentId = `magnet:?xt=urn:btih:${infoHash}&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com`
    
    // obtain torrent metadata
    const torrent = client.add(torrentId, {
        // store: MemoryChunkStore,
        path: `./downloads/${infoHash}/`
    })

    var intervalID = setInterval(pollMetadataStatus, 5000)
    var attempt = 0

    function pollMetadataStatus() {
        attempt += 1
        console.log(torrent.progress)
        console.log(torrent.ready)
        console.log(`attempt is ${attempt}`)
        if (attempt > 10) {
            clearInterval(intervalID)
            torrent.destroy()

            // return if we can't fetch metadata after some time
            return updateTorrentCallback({
                action: "update_status",
                info_hash: infoHash,
                status: "time_out",
                reason: "Can't fetch torrent metadata"
            })
            
        }
    }

    // III. New validations after loading metadata 
    torrent.on('metadata', () => {

        clearInterval(intervalID)

        // this file is a candidate for saving
        var supposedFile = torrent.files[0]

        // begin validations
        
        if (torrent.files.length > 1) {
            torrent.destroy()
            return updateTorrentCallback({
                action: "update_status",
                info_hash: infoHash,
                status: "fail",
                reason: "Only single-file torrents are supported at this moment"
            })
        }

        
        if (supposedFile.length > 5000000) {
            torrent.destroy()
            return updateTorrentCallback({
                action: "update_status",
                info_hash: infoHash,
                status: "fail",
                reason: "Files bigger than 5MB are not allowed at this moment"
            })
        }

        var regexAll = /[^\\]*\.(\w+)$/
        var total = supposedFile.name.match(regexAll);
        var thisFilename = total[0];
        var thisExtension = total[1];

        var allowedExtensions = ["jpg", "jpeg", "png", "gif", "md", "markdown"]

        if (!allowedExtensions.includes(thisExtension)) {
            torrent.destroy()
            return updateTorrentCallback({
                action: "update_status",
                info_hash: infoHash,
                status: "fail",
                reason: `Only following extensions: ${allowedExtensions.join(', ')} are supported  at this moment`
            })
        }
        
        // end validations

        // if we are still here, the torrent is valid. waiting for ... 
    })
    // IV. download and send data back

    torrent.on('done', () => {

        return updateTorrentCallback({
            action: "update_torrent_data",
            status: "success",
            info_hash: infoHash,
            name: supposedFile.name,                    
            path: `./downloads/${infoHash}/${file.name}`
        })
    })
})

function updateTorrentCallback(params, attempt = 0) {

    // if the file is less than 20 kb, it may not have time to write. so we give several attempts to fs for reading
    if (params.status == "success") {
        if (attempt > 5) {
            console.error(`Failed to write file to ${params.path} after 5 attemps`)
            params.status = "fail"
            params.reason = "Can't read file (hint: 20kb bug?)"
        }

        if(!fs.existsSync(params.path)) {
            console.log("File not written yet; try again in 100ms");
            setTimeout(function() {
                updateContentCallback(params, attempt += 1);
            }, 100);
        } else {
            params.content = fs.readFileSync(params.path, {encoding: 'base64'})
        }
    }

    const data = JSON.stringify({
        params
    })

    // possible actions :
    // PUT   /api/torrents/:info_hash/update
    const serverOptions = {
        hostname: 'localhost',
        port: 3000,
        path: `/api/torrents/${params.info_hash}/update`,
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    }

    const callbackReq = http.request(options, callbackRes => {
        console.log(`statusCode: ${callbackRes.statusCode}`)

        callbackRes.on('data', d => {
            process.stdout.write(d)
        })
    })

    callbackReq.on('error', error => {
        console.error(error)
    })

    callbackReq.write(data)
    callbackReq.end()
}






    
    // if return res.send();

var port = argv.port

app.listen(argv.port, function () {
    console.log('App is listening on port ' + argv.port + ' and ready for incoming requests');
});

let expectedError = false

process.on('exit', code => {
    if (code === 0 || expectedError) return // normal exit
    if (code === 130) return // intentional exit with Control-C

    console.log('\n{red:UNEXPECTED ERROR:} If this is a bug in WebTorrent, report it!')
    console.log('{green:OPEN AN ISSUE:} https://github.com/webtorrent/webtorrent-cli/issues\n')
    console.log(`node ${process.version}, ${process.platform} ${process.arch}, exit ${code}`)
})

let gracefullyExiting = false

process.on('SIGINT', gracefulExit)
process.on('SIGTERM', gracefulExit)

// helpers

function fatalError (err) {
   `Fatal error ${err.message || err}`
    process.exit(1)
}

function handleWarning (err) {
  console.warn(`Warning: ${err.message || err}`)
}

function fatalError (err) {
  console.log(`${err.message || err}`)
  process.exit(1)
}

function errorAndExit (err) {
  clivas.line(`{red:Error:} ${err.message || err}`)
  expectedError = true
  process.exit(1)
}

function gracefulExit () {
  if (gracefullyExiting) {
    return
  }

  gracefullyExiting = true

    console.log('Graceful Exit');

  process.removeListener('SIGINT', gracefulExit)
  process.removeListener('SIGTERM', gracefulExit)

  if (!client) {
    return
  }

  if (argv['on-exit']) {
    cp.exec(argv['on-exit']).unref()
  }

  client.destroy(err => {
    if (err) {
      return fatalError(err)
    }

    // Quit after 1 second. This is only necessary for `webtorrent-hybrid` since
    // the `electron-webrtc` keeps the node process alive quit.
    setTimeout(() => process.exit(0), 1000)
      .unref()
  })
}
