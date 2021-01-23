#!/usr/bin/env node
'use strict'


const cp = require('child_process')
const createTorrent = require('create-torrent')
const ecstatic = require('ecstatic')
const executable = require('executable')
const fs = require('fs')
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

// const { version: webTorrentCliVersion } = require('../package.json')
// const { version: webTorrentVersion } = require('webtorrent/package.json')

// const Discovery = require('torrent-discovery');
// const Protocol = require('bittorrent-protocol');
// const ut_metadata = require('ut_metadata');
// const addrToIPPort = require('addr-to-ip-port');
// const bencode = require('bencode');
// const net = require('net');

// const SELF_HASH = '4290a5ff50130a90f1de64b1d9cc7822799affd5';   // Random infohash
// const INFO_HASH = '90289fd34dfc1cf8f316a268add8354c85334458';   // ubuntu-16.04.1-server-amd64.iso

// function discoveryMetadata(infoHash) {
//     new Discovery({ infoHash: INFO_HASH, peerId: SELF_HASH, port: 6881, dht: true })
//         .on('peer', function (peer) {
//             const peerAddress = { address: addrToIPPort(peer)[0], port: addrToIPPort(peer)[1] };
//             console.log(`download metadata from peer ${peerAddress.address}:${peerAddress.port}`);
//             getMetadata(peerAddress, INFO_HASH);
//         });

//     const getMetadata = (peerAddress, infoHash) => {
//         const socket = new net.Socket();
//         socket.setTimeout(5000);
//         socket.connect(peerAddress.port, peerAddress.address, () => {
//             const wire = new Protocol();

//             socket.pipe(wire).pipe(socket);
//             wire.use(ut_metadata());

//             wire.handshake(infoHash, SELF_HASH, { dht:true });
//             wire.on('handshake', function (infoHash, peerId) {
//                 wire.ut_metadata.fetch();
//             })

//             wire.ut_metadata.on('metadata', function (rawMetadata) {
//                 let metadata = bencode.decode(rawMetadata).info;                // Got it!
//                 console.log(`${metadata.name.toString('utf-8')}:`);
//                 console.log(metadata);
//                 process.exit(0);
//             })
//         });
//         socket.on('error', err => { socket.destroy(); });
//     }
// }

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

        var intervalID = setInterval(pollMetadataStatus, 1000)
        var attempt = 0
        

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
                // :TODO: ensure we unload torrent after failed attempts
                res.send(result)
                runCallback({timedOut: true})
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
        
        torrent.on('metadata', function () {

            // console.log(torrent)
            // console.log(client)

            clearInterval(intervalID)

            if (torrent.files.length > 1) {
                result.status = "fail"
                result.reason = "Only single-file torrents are supported at this moment"
            }

            // this file is a candidate for saving
            var supposedFile = torrent.files[0]

            if (supposedFile.length > 5000000) {
                result.status = "fail"
                result.reason = "Files bigger than 5MB are not allowed at this moment"
            }

            var regexAll = /[^\\]*\.(\w+)$/
            var total = supposedFile.name.match(regexAll);
            var thisFilename = total[0];
            var thisExtension = total[1];

            var allowedExtensions = ["jpg", "jpeg", "png", "gif", "md", "markdown"]

            if (!allowedExtensions.includes(thisExtension)) {
                result.status = "fail"
                result.reason = `Only following extensions: ${allowedExtensions.join(', ')} are supported  at this moment`
            }
                 
            if (result.status != "fail") {
                
                result.name = supposedFile.name
                result.status = "success"
                
            } else {
                torrent.destroy()
            }                

            res.send(result)

            torrent.on('done', function() {

                console.log('torrent finished downloading')
                torrent.files.forEach(function(file){
                    console.log(file)
                })
                
                var file = torrent.files[0]
                console.log(torrent)
                console.log(file)


                // send a callback to rails server when files downloading is finished
                runCallback({
                    timedOut: false,
                    p2p_network_id: "01",
                    info_hash: infoHash,
                    name: file.name,                    
                    path: `./${infoHash}/${file.name}`
                }, function(){ setTimeout('', 5000) })
            })
        })
    }
})

function runCallback(params, f) {
    f();
    if (!params.timedOut) {
        params.content = fs.readFileSync(params.path, {encoding: 'base64'})
    }
    console.log(params)
    // console.log(supposedFile.infoHash);
    // var payload = {torrent: {files: [{}]}}

    // payload.torrent.timedOut = timedOut;
    
    // if (!timedOut) {
    //     payload.torrent.p2p_network_id = "01"
    //     payload.torrent.info_hash = supposedFile.infoHash
    //     payload.torrent.files[0].name = supposedFile.name
    //     payload.torrent.files[0].content = fs.readFileSync(`./${supposedFile.infoHash}/${supposedFile.name}`, {encoding: 'base64'})
    // }

    // console.log(`payload is ${payload}`)
    // prerequisites
    // infoHash to determine db entry
    // var infoHash = supposedFile.infoHash

    
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




// app.listen(argv.port).on('error', err => {
//     if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
//         return server.listen(0, initServer)
//     }

//     return fatalError(err)
// })

function runDownload (torrentId) {
  if (!argv.out && !argv.stdout && !playerName) {
    argv.out = process.cwd()
  }

  client = new WebTorrent({
    blocklist: argv.blocklist,
    torrentPort: argv['torrent-port'],
    dhtPort: argv['dht-port']
  })
  client.on('error', fatalError)

  const torrent = client.add(torrentId, {
    path: argv.out,
    announce: argv.announce
  })

  if (argv.verbose) {
    torrent.on('warning', handleWarning)
  }

  torrent.on('infoHash', () => {
    if ('select' in argv) {
      torrent.so = argv.select.toString()
    }

    if (argv.quiet) return

    updateMetadata()
    torrent.on('wire', updateMetadata)

    function updateMetadata () {
      clivas.clear()

      clivas.line(
        '{green:fetching torrent metadata from} {bold:%s} {green:peers}',
        torrent.numPeers
      )
    }

    torrent.on('metadata', () => {
      clivas.clear()
      torrent.removeListener('wire', updateMetadata)

      clivas.clear()
      clivas.line('{green:verifying existing torrent data...}')
    })
  })

  torrent.on('done', () => {
    numTorrents -= 1

    if (!argv.quiet) {
      const numActiveWires = torrent.wires
        .reduce((num, wire) => num + (wire.downloaded > 0), 0)

      clivas.line('')
      clivas.line(
        'torrent downloaded {green:successfully} from {bold:%s/%s} {green:peers} ' +
        'in {bold:%ss}!', numActiveWires, torrent.numPeers, getRuntime()
      )
    }

    if (argv['on-done']) {
      cp.exec(argv['on-done']).unref()
    }

    if (!playerName && !serving && argv.out && !argv['keep-seeding']) {
      torrent.destroy()

      if (numTorrents === 0) {
        gracefulExit()
      }
    }
  })

  
  function onReady () {
    if (typeof argv.select === 'boolean') {
      clivas.line('Select a file to download:')

      torrent.files.forEach((file, i) => clivas.line(
        '{2+bold+magenta:%s} %s {blue:(%s)}',
        i, file.name, prettierBytes(file.length)
      ))

      clivas.line('\nTo select a specific file, re-run `webtorrent` with "--select [index]"')
      clivas.line('Example: webtorrent download "magnet:..." --select 0')

      return gracefulExit()
    }

    // if no index specified, use largest file
    const index = (typeof argv.select === 'number')
      ? argv.select
      : torrent.files.indexOf(torrent.files.reduce((a, b) => a.length > b.length ? a : b))

    if (!torrent.files[index]) {
      return errorAndExit(`There's no file that maps to index ${index}`)
    }

    onSelection(index)
  }

  function onSelection (index) {
    href = (argv.airplay || argv.chromecast || argv.xbmc || argv.dlna)
      ? `http://${networkAddress()}:${server.address().port}`
      : `http://localhost:${server.address().port}`

    href += `/${index}/${encodeURIComponent(torrent.files[index].name)}`

    if (playerName) {
      torrent.files[index].select()
    }

    if (argv.stdout) {
      torrent.files[index].createReadStream().pipe(process.stdout)
    }

    if (argv.vlc) {
      vlcCommand((err, vlcCmd) => {
        if (err) {
          return fatalError(err)
        }

        if (process.platform === 'win32') {
          openVLCWin32(vlcCmd)
        } else {
          openPlayer(`${vlcCmd} "${href}" ${VLC_ARGS}`)
        }
      })
    } else if (argv.iina) {
      openIINA(`${IINA_EXEC} "${href}"`, `iina://weblink?url=${href}`)
    } else if (argv.mplayer) {
      openPlayer(`${MPLAYER_EXEC} "${href}"`)
    } else if (argv.mpv) {
      openPlayer(`${MPV_EXEC} "${href}"`)
    } else if (argv.omx) {
      openPlayer(`${OMX_EXEC} "${href}"`)
    }

    function openPlayer (cmd) {
      cp.exec(cmd, err => {
        if (err) {
          const isMpvFalseError = playerName === 'mpv' && err.code === 4

          if (!isMpvFalseError) {
            return fatalError(err)
          }
        }
      }).on('exit', playerExit).unref()
    }

    function openIINA (cmd, href) {
      cp.exec(cmd, () => {
        open(href, { url: true })
      }).on('exit', playerExit)
        .unref()
    }

    function openVLCWin32 (vlcCommand) {
      const args = [].concat(href, VLC_ARGS.split(' '))

      cp.execFile(vlcCommand, args, err => {
        if (err) {
          return fatalError(err)
        }
      }).on('exit', playerExit).unref()
    }

    function playerExit () {
      if (argv.quit) {
        gracefulExit()
      }
    }

    if (argv.airplay) {
      const airplay = require('airplay-js')

      airplay.createBrowser()
        .on('deviceOn', device => device.play(href, 0, () => {}))
        .start()
    }

    if (argv.chromecast !== false) {
      const chromecasts = require('chromecasts')()

      const opts = {
        title: `WebTorrent - ${torrent.files[index].name}`
      }

      if (argv.subtitles) {
        subtitlesServer.listen(0)
        opts.subtitles = [`http://${networkAddress()}:${subtitlesServer.address().port}/${encodeURIComponent(path.basename(argv.subtitles))}`]
        opts.autoSubtitles = true
      }

      chromecasts.on('update', player => {
        if (
          // If there are no named chromecasts supplied, play on all devices
          argv.chromecast === true ||
          // If there are named chromecasts, check if this is one of them
          [].concat(argv.chromecast).find(name => player.name.toLowerCase().includes(name.toLowerCase()))
        ) {
          player.play(href, opts)

          player.on('error', err => {
            err.message = `Chromecast: ${err.message}`
            return errorAndExit(err)
          })
        }
      })
    }

    if (argv.xbmc) {
      const xbmc = require('nodebmc')

      new xbmc.Browser()
        .on('deviceOn', device => device.play(href, () => {}))
    }

    if (argv.dlna) {
      const dlnacasts = require('dlnacasts')()

      dlnacasts.on('update', player => {
        const opts = {
          title: `WebTorrent - ${torrent.files[index].name}`,
          type: mime.getType(torrent.files[index].name)
        }

        if (argv.subtitles) {
          subtitlesServer.listen(0, () => {
            opts.subtitles = [
              `http://${networkAddress()}:${subtitlesServer.address().port}/${encodeURIComponent(path.basename(argv.subtitles))}`
            ]
            play()
          })
        } else {
          play()
        }

        function play () {
          player.play(href, opts)
        }
      })
    }

    drawTorrent(torrent)
  }
}

function runDownloadMeta (torrentId) {
  if (!argv.out && !argv.stdout) {
    argv.out = process.cwd()
  }

  client = new WebTorrent({
    blocklist: argv.blocklist,
    torrentPort: argv['torrent-port'],
    dhtPort: argv['dht-port']
  })
  client.on('error', fatalError)

  const torrent = client.add(torrentId, {
    store: MemoryChunkStore,
    announce: argv.announce
  })

  torrent.on('infoHash', function () {
    const torrentFilePath = `${argv.out}/${this.infoHash}.torrent`

    if (argv.quiet) {
      return
    }

    updateMetadata()
    torrent.on('wire', updateMetadata)

    function updateMetadata () {
      clivas.clear()
      clivas.line(
        '{green:fetching torrent metadata from} {bold:%s} {green:peers}',
        torrent.numPeers
      )
    }

    torrent.on('metadata', function () {
      clivas.clear()
      torrent.removeListener('wire', updateMetadata)

      clivas.clear()
      clivas.line(`{green:saving the .torrent file data to ${torrentFilePath} ..}`)
      fs.writeFileSync(torrentFilePath, this.torrentFile)
      gracefulExit()
    })
  })
}

function runSeed (input) {
  if (path.extname(input).toLowerCase() === '.torrent' || /^magnet:/.test(input)) {
    // `webtorrent seed` is meant for creating a new torrent based on a file or folder
    // of content, not a torrent id (.torrent or a magnet uri). If this command is used
    // incorrectly, let's just do the right thing.
    runDownload(input)
    return
  }

  const client = new WebTorrent({
    blocklist: argv.blocklist,
    torrentPort: argv['torrent-port'],
    dhtPort: argv['dht-port']
  })
  client.on('error', fatalError)

  client.seed(input, {
    announce: argv.announce
  }, torrent => {
    if (argv.quiet) {
      console.log(torrent.magnetURI)
    }

    drawTorrent(torrent)
  })
}

let drawInterval
function drawTorrent (torrent) {
  if (!argv.quiet) {
    process.stdout.write(Buffer.from('G1tIG1sySg==', 'base64')) // clear for drawing
    drawInterval = setInterval(draw, 1000)
    drawInterval.unref()
  }

  let hotswaps = 0
  torrent.on('hotswap', () => (hotswaps += 1))

  let blockedPeers = 0
  torrent.on('blockedPeer', () => (blockedPeers += 1))

  function draw () {
    const unchoked = torrent.wires
      .filter(wire => !wire.peerChoking)

    let linesRemaining = clivas.height
    let peerslisted = 0

    const speed = torrent.downloadSpeed
    const estimate = torrent.timeRemaining
      ? moment.duration(torrent.timeRemaining / 1000, 'seconds').humanize()
      : 'N/A'

    const runtimeSeconds = getRuntime()
    const runtime = runtimeSeconds > 300
      ? moment.duration(getRuntime(), 'seconds').humanize()
      : `${runtimeSeconds} seconds`
    const seeding = torrent.done

    clivas.clear()

    line(`{green:${seeding ? 'Seeding' : 'Downloading'}: }{bold:${torrent.name}}`)

    if (seeding) line(`{green:Info hash: }${torrent.infoHash}`)

    const portInfo = []
    if (argv['torrent-port']) portInfo.push(`{green:Torrent port: }${argv['torrent-port']}`)
    if (argv['dht-port']) portInfo.push(`{green:DHT port: }${argv['dht-port']}`)
    if (portInfo.length) line(portInfo.join(' '))

    if (playerName) {
      line(`{green:Streaming to: }{bold:${playerName}}  {green:Server running at: }{bold:${href}}`)
    } else if (server) {
      line(`{green:Server running at: }{bold:${href}}`)
    }

    if (argv.out) {
      line(`{green:Downloading to: }{bold:${argv.out}}`)
    }

    line(`{green:Speed: }{bold:${
      prettierBytes(speed)
    }/s} {green:Downloaded:} {bold:${
      prettierBytes(torrent.downloaded)
    }}/{bold:${prettierBytes(torrent.length)}} {green:Uploaded:} {bold:${
      prettierBytes(torrent.uploaded)
    }}`)

    line(`{green:Running time:} {bold:${
      runtime
    }}  {green:Time remaining:} {bold:${
      estimate
    }}  {green:Peers:} {bold:${
      unchoked.length
    }/${
      torrent.numPeers
    }}`)

    if (argv.verbose) {
      line(`{green:Queued peers:} {bold:${
        torrent._numQueued
      }}  {green:Blocked peers:} {bold:${
        blockedPeers
      }}  {green:Hotswaps:} {bold:${
        hotswaps
      }}`)
    }

    line('')

    torrent.wires.every(wire => {
      let progress = '?'

      if (torrent.length) {
        let bits = 0

        const piececount = Math.ceil(torrent.length / torrent.pieceLength)

        for (let i = 0; i < piececount; i++) {
          if (wire.peerPieces.get(i)) {
            bits++
          }
        }

        progress = bits === piececount
          ? 'S'
          : `${Math.floor(100 * bits / piececount)}%`
      }

      let str = '{3:%s} {25+magenta:%s} {10:%s} {12+cyan:%s/s} {12+red:%s/s}'

      const args = [
        progress,
        wire.remoteAddress
          ? `${wire.remoteAddress}:${wire.remotePort}`
          : 'Unknown',
        prettierBytes(wire.downloaded),
        prettierBytes(wire.downloadSpeed()),
        prettierBytes(wire.uploadSpeed())
      ]

      if (argv.verbose) {
        str += ' {15+grey:%s} {10+grey:%s}'

        const tags = []

        if (wire.requests.length > 0) {
          tags.push(`${wire.requests.length} reqs`)
        }

        if (wire.peerChoking) {
          tags.push('choked')
        }

        const reqStats = wire.requests
          .map(req => req.piece)

        args.push(tags.join(', '), reqStats.join(' '))
      }

      line(...[].concat(str, args))

      peerslisted += 1
      return linesRemaining > 4
    })

    line('{60:}')

    if (torrent.numPeers > peerslisted) {
      line('... and %s more', torrent.numPeers - peerslisted)
    }

    clivas.flush(true)

    function line (...args) {
      clivas.line(...args)
      linesRemaining -= 1
    }
  }
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

  // if (subtitlesServer) {
  //   subtitlesServer.close()
  // }

  // clearInterval(drawInterval)

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
