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
    
    if (infoHash.length != 40) {
        result.status = "fail"
        result.reason = "Invalid info_hash length"
        res.send(result)        
    } else if (alreadyAddedInfoHashes.includes(infoHash)) { // check if torrent is already in the queue
        result.status = "fail"
        result.reason = "Already added"
        res.send(result)
    } else {

        // construct torrentId with trackers
        let torrentId = `magnet:?xt=urn:btih:${infoHash}&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com`
        
        // obtain torrent metadata
        const torrent = client.add(torrentId, {
            // store: MemoryChunkStore,
            path: `./${infoHash}/`
        })

        torrent.on('error', function (err) {
            console.log(err);
        })

        client.on('error', function (err) {
            console.log(err);
        })
        
        var intervalID = setInterval(pollMetadataStatus, 1000)
        var attempt = 0

        // var timedOut = 0
        

        function pollMetadataStatus()
        {
            attempt += 1
            console.log(torrent.progress)
            console.log(torrent.ready)
            console.log(`attempt is ${attempt}`)
            if (attempt > 10) {
                clearInterval(intervalID)
                result.status = "fail"
                result.reason = "Can't fetch torrent metadata"
                result.timedOut = true
                // :TODO: ensure we unload torrent after failed attempts
                // runCallback({timedOut: true})
            }
        }

        torrent.on('download', function (bytes) {

            console.log('just downloaded: ' + bytes)
            console.log('total downloaded: ' + torrent.downloaded)
            console.log('download speed: ' + torrent.downloadSpeed)
            console.log('progress: ' + torrent.progress)
        })

        // torrent.on('error'), function (err) {
        //     console.log(err)
        // }
        
        torrent.on('metadata', () => {

            // console.log(torrent)
            // console.log(client)

            clearInterval(intervalID)

            // if (torrent.files.length > 1) {
            //     result.status = "fail"
            //     result.reason = "Only single-file torrents are supported at this moment"
            // }

            // // this file is a candidate for saving
            var supposedFile = torrent.files[0]

            // if (supposedFile.length > 5000000) {
            //     result.status = "fail"
            //     result.reason = "Files bigger than 5MB are not allowed at this moment"
            // }

            // var regexAll = /[^\\]*\.(\w+)$/
            // var total = supposedFile.name.match(regexAll);
            // var thisFilename = total[0];
            // var thisExtension = total[1];

            // var allowedExtensions = ["jpg", "jpeg", "png", "gif", "md", "markdown"]

            // if (!allowedExtensions.includes(thisExtension)) {
            //     result.status = "fail"
            //     result.reason = `Only following extensions: ${allowedExtensions.join(', ')} are supported  at this moment`
            // }
                 
            if (result.status != "fail") {
                result.timedOut =  false
                result.name = supposedFile.name
                result.status = "success"
                // res.send(result)
                
            } else {
                torrent.destroy()
                runCallback({status: status, reason: reason, timedOut: timedOut})
                res.send(result)        
            }                
        })
            // res.send(result)

        torrent.on('done', () => {
            var file = torrent.files[0]

            console.log(file);
            // Promise.allSettled(promises).
            //     then((results) => results.forEach((result) => console.log(result.status)));
            
            updateContentCallback({
                timedOut: result.timedOut,
                p2p_network_id: "01",
                info_hash: infoHash,
                name: file.name,                    
                path: `./${infoHash}/${file.name}`
                // res: res
                // content: fs.readFileSync(`./${infoHash}/${file.name}`, {encoding: 'base64'})
            })
        })

            // torrent.on('done', function() {
                
              

            //     // t = fs.readFileSync(`./${infoHash}/${file.name}`, {encoding: 'base64'})

            //     // conso;e.t
                    
                        
            // })
        
        // send a callback to rails server when files downloading is finished
        
    }

    
    
})
function updateTimedOutCallback(params) {

}

function updateContentCallback(params, attempt = 0) {

    if (attempt > 5) throw `Failed to write file to ${params.path} after 5 attemps`
    
    if(!fs.existsSync(params.path)) {
        console.log("File not written yet; try again in 100ms");
        setTimeout(function() {
            attempt += 1
            updateContentCallback(params, attempt);
        }, 10);
    }

    // if (!params.timedOut) {
    //     try { // statements to try
    //         params.content = fs.readFileSync(params.path, {encoding: 'base64'})
    //     }
    //     catch (e) {
    //         console.error(e); // pass exception object to error handler (i.e. your own function)
        
    //     }
    // }
    
    console.log(params)
    
    const data = JSON.stringify({
        params
    })

    // POST   /api/torrents/:info_hash/set_timed_out(.:format)       torrents#set_timed_out
    // POST   /api/torrents/:info_hash/update_content(.:format)      torrents#update_content
    
    const options = {
        hostname: 'localhost',
        port: 3000,
        path: `/api/torrents/${params.infoHash}/update_content`,
        method: 'POST',
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
