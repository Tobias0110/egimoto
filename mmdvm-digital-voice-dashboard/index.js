import express from 'express'
import helmet from 'helmet'
import SSE from 'express-sse'
import compression from 'compression'
import dotenv from 'dotenv'
import url from 'node:url'
import path from 'node:path'
import { engine } from 'express-handlebars'
import { mqttConnect } from './mqtt.js'
import { readCallerIdNames } from './callerIdNames.js'
import { readVersionNumber } from './version.js'

dotenv.config()

const currentDirectory= url.fileURLToPath( new URL('.', import.meta.url) )
const maxPacketHistoryLength= parseInt(process.env.MAX_PACKET_HISTORY_LENGTH)
const packetHistory= []
// Remember which DMR time slots are in use
let ts1_in_use = false;
let ts2_in_use = false;
// Remember last status for new users
let lastStatus = {mode: 'IDLE', rssi: '-', text: '-', swr: '-', temp: '-', hum: '-'};

function transmitPacket( packet ) {
  stream.send( packet )

  // Keep track of DMR timeslosts in use
  if(packet.typ == "DMR TS1" & packet.action == "start") ts1_in_use = true;
  else if(packet.typ == "DMR TS1" & packet.action == "end") ts1_in_use = false;
  else if(packet.typ == "DMR TS2" & packet.action == "start") ts2_in_use = true;
  else if(packet.typ == "DMR TS2" & packet.action == "end") ts2_in_use = false;
  // If a package that doesn't belong to DMR is sent, no timeslot can be active.
  else {
    ts1_in_use = false;
    ts2_in_use = false;
  }

  // Add packet to the history and delete old ones if necessary
  packetHistory.push( packet )
  while( packetHistory.length > maxPacketHistoryLength ) {
    packetHistory.shift()
  }
}

function transmitStatus( packet ) {
  // Update only available / changing fields
  if(typeof packet.mode != "undefined") lastStatus.mode = packet.mode;
  if(typeof packet.rssi != "undefined") lastStatus.rssi = packet.rssi;
  if(typeof packet.text != "undefined") lastStatus.text = packet.text;
  if(typeof packet.swr != "undefined") lastStatus.swr = packet.swr;
  if(typeof packet.temp != "undefined") lastStatus.temp = packet.temp;
  if(typeof packet.hum != "undefined") lastStatus.hum = packet.hum;
  status_stream.send(lastStatus);
}

const openCalls= []
function handleOpenCalls( packet ) {
  if( packet.action === 'start' ) {
    // Close any other open calls if a new start packet is received, exept the start packet is for the DMR timeslot that is curently not in use.
    // Repeater can handle two DMR calls on diffrent time slots and in all other modes only one call at a time.
    if( openCalls.length && packet.action === 'start' && !((packet.typ == "DMR TS1" && ts2_in_use == true && ts1_in_use == false) || (packet.typ == "DMR TS2" && ts1_in_use == true && ts2_in_use == false))) {
      openCalls.forEach( startPacket => {
        const stopPacket= {...startPacket}
        stopPacket.time= new Date().toISOString()
        stopPacket.action= 'end'
        transmitPacket( stopPacket )
        
        //console.log(`[Stream] Generated missing stop packet: from ${stopPacket.from} -> to ${stopPacket.to}`)
      })

      openCalls.length= 0
    }
    
    // Remember this start packet for manually closing later if necessary
    openCalls.push( packet );
    // Nothing to close, just send a start package
    transmitPacket( packet );
  }

  // Remove start packets from the open list if an incoming end packet matches the typ and create end packet
  // Gets called for all end packages
  if(packet.action === 'end') {
    for( let i= 0; i < openCalls.length; i++ ) {
      const startPacket= openCalls[i]
      if( (startPacket.typ) === (packet.typ) ) {
        const stopPacket= {...startPacket}
        stopPacket.time= new Date().toISOString()
        stopPacket.action= 'end'
        stopPacket.loss= packet.loss;
        stopPacket.ber= packet.ber;
        stopPacket.rssi= packet.rssi;
        transmitPacket( stopPacket )
        openCalls.splice(i, 1)
        i--
      }
    }
  }
}

// Read the caller id names CSV and connect to mqtt in parallel
const [callerIdNames, client, versionNumber]= await Promise.all([ readCallerIdNames(), mqttConnect(), readVersionNumber(currentDirectory) ])

const app = express()

// Setup handlebars views directory and file extension
app.engine('hbs', engine({defaultLayout: 'main', extname: '.hbs'}))
app.set('view engine', 'hbs')
app.set('views', path.join(currentDirectory, '/views'))

app.locals.version= versionNumber
app.locals.repeaterCallSign= process.env.REPEATER_CALL_SIGN

// Add middleware functions
app.use(helmet())
app.use(compression())
app.use(express.static(path.join(currentDirectory, '/static')))

// Setup view routes
app.get('/', (req, res) => res.render('home'))
app.get('/about/en', (req, res) => res.render('about_en'))
app.get('/about/de', (req, res) => res.render('about_de'))
app.get('/faq/en', (req, res) => res.render('faq_en'))
app.get('/faq/de', (req, res) => res.render('faq_de'))

const stream= new SSE()
app.get('/stream', stream.init)
app.get('/history', (req, resp) => resp.send(packetHistory) )

const status_stream= new SSE()
app.get('/status_stream', status_stream.init)
app.get('/status', (req, resp) => resp.send(lastStatus))

client?.on('message', (topic, payload) => {
  if( topic !== process.env.MQTT_TOPIC ) {
    return
  }

  const jsonString= payload.toString('utf8').trim()
  if( !jsonString ) {
    return
  }

  try {
    /*
    // Parse the json into an object to add some additional fields
    const packet= JSON.parse( jsonString )
    const dmrMode= (packet.typ || packet.type || '').toLowerCase().indexOf('dmr') >= 0
    packet.time= new Date().toISOString()
    packet.fromName= dmrMode ? callerIdNames.get( parseInt(packet.from) ) || '' : ''

    // Only translate private call (PC) caller ids to names
    const [callType, toField]= packet.to.split(' ')
    if( dmrMode && callType && callType.toUpperCase() === 'PC') {
      const toFieldName= callerIdNames.get( parseInt(toField) )
      packet.toName= toFieldName ? `${callType} ${toFieldName}` : ''
    }*/

    const mess = JSON.parse(jsonString);

    // action, external, typ, from, fromName, to, toName, time: isoTime
    const packet = {external: false};
    const sPacket ={};
    packet.time= new Date().toISOString();

    if(typeof mess.YSF != "undefined") {
      packet.typ = "YSF";
        if(mess.YSF.action == "start") {
            /*console.log("YSF start:");
            console.log(mess.YSF.source);
            console.log(mess.YSF.source_cs);
            console.log(mess.YSF['dg-id']);
            console.log(mess.YSF.timestamp);*/
            packet.action = "start";
            if(mess.YSF.source == "network") packet.external = true;
            packet.from = mess.YSF.source_cs;
            packet.fromName = packet.from;
            packet.to = "DG-ID " + mess.YSF['dg-id'];
            packet.toName = packet.to;
            packet.loss = '-';
            packet.ber = '-';
            packet.rssi = '-';
        }
        else if(mess.YSF.action == "end" || mess.YSF.action == 'lost') {
            /*console.log("YSF stop:");
            console.log(mess.YSF.loss);
            if(typeof mess.YSF.rssi != "undefined") console.log(mess.YSF.rssi.ave);
            console.log(mess.YSF.timestamp);*/
            packet.action = "end";
            // there are packets without this
            if(typeof mess.YSF.loss != "undefined") packet.loss = parseFloat(mess.YSF.loss).toFixed(2) + '%';
            else packet.loss = '-';
            if(typeof mess.YSF.ber != "undefined") packet.ber= parseFloat(mess.YSF.ber).toFixed(2) + '%';
            else packet.ber = '-';
            if(typeof mess.YSF.rssi != "undefined") packet.rssi= mess.YSF.rssi.ave + 'dBm';
            else packet.rssi = '-';
        }
        handleOpenCalls( packet );
    }

    else if(typeof mess.DMR != "undefined") {
        if((mess.DMR.action == "start") && (mess.DMR.slot == 1)) {
            /*console.log("DMR TS1 start:");
            console.log(mess.DMR.source);
            console.log(mess.DMR.source_id);
            let type = "PC";
            if(mess.DMR.destination_type == "group") type = "TG";
            console.log(type + " " + mess.DMR.destination_id);
            console.log(mess.DMR.timestamp);*/
            packet.typ = "DMR TS1";
            packet.action = "start";
            if(mess.DMR.source == "network") packet.external = true;
            packet.from = mess.DMR.source_id;
            packet.fromName = mess.DMR.source_info;
            let typ = "PC";
            if(mess.DMR.destination_type == "group") typ = "TG";
            packet.to = typ + " " + mess.DMR.destination_id;
            packet.toName = packet.to;
            packet.loss = '-';
            packet.ber = '-';
            packet.rssi = '-';
        }
        else if((mess.DMR.action == "end" || mess.DMR.action == 'lost') && (mess.DMR.slot == 1)) {
            /*console.log("DMR TS1 stop:");
            if(typeof mess.DMR.loss != "undefined") console.log(mess.DMR.loss);
            console.log(mess.DMR.ber);
            if(typeof mess.DMR.rssi != "undefined") console.log(mess.DMR.rssi.ave);
            console.log(mess.DMR.timestamp);*/
            packet.typ = "DMR TS1";
            packet.action = "end";
            if(typeof mess.DMR.loss != "undefined") packet.loss= parseFloat(mess.DMR.loss).toFixed(2) + '%';
            else packet.loss = '-';
            if(typeof mess.DMR.ber != "undefined") packet.ber= parseFloat(mess.DMR.ber).toFixed(2) + '%';
            else packet.ber = '-';
            if(typeof mess.DMR.rssi != "undefined") packet.rssi= mess.DMR.rssi.ave + 'dBm';
            else packet.rssi = '-';
        }
        else if((mess.DMR.action == "start") && (mess.DMR.slot == 2)) {
            /*console.log("DMR TS2 start:");
            console.log(mess.DMR.source);
            console.log(mess.DMR.source_id);
            let type = "PC";
            if(mess.DMR.destination_type == "group") type = "TG";
            console.log(type + " " + mess.DMR.destination_id);
            console.log(mess.DMR.timestamp);*/
            packet.typ = "DMR TS2";
            packet.action = "start";
            if(mess.DMR.source == "network") packet.external = true;
            packet.from = mess.DMR.source_id;
            packet.fromName = mess.DMR.source_info;
            let typ = "PC";
            if(mess.DMR.destination_type == "group") typ = "TG";
            packet.to = typ + " " + mess.DMR.destination_id;
            packet.toName = packet.to;
            packet.loss = '-';
            packet.ber = '-';
            packet.rssi = '-';
        }
        else if((mess.DMR.action == "end" || mess.DMR.action == 'lost') && (mess.DMR.slot == 2)) {
            /*console.log("DMR TS2 stop:");
            if(typeof mess.DMR.loss != "undefined") console.log(mess.DMR.loss);
            console.log(mess.DMR.ber);
            if(typeof mess.DMR.rssi != "undefined") console.log(mess.DMR.rssi.ave);
            console.log(mess.DMR.timestamp);*/
            packet.typ = "DMR TS2";
            packet.action = "end";
            if(typeof mess.DMR.loss != "undefined") packet.loss= parseFloat(mess.DMR.loss).toFixed(2) + '%';
            else packet.loss = '-';
            if(typeof mess.DMR.ber != "undefined") packet.ber= parseFloat(mess.DMR.ber).toFixed(2) + '%';
            else packet.ber = '-';
            if(typeof mess.DMR.rssi != "undefined") packet.rssi= mess.DMR.rssi.ave + 'dBm';
            else packet.rssi = '-';
        }
        handleOpenCalls( packet );
    }

    else if(typeof mess.M17 != "undefined") {
      packet.typ = "M17";
        if(mess.M17.action == "start") {
            /*console.log("m17 start:");
            console.log(mess.M17.source);
            console.log(mess.M17.source_cs);
            console.log(mess.M17.destination_cs);
            console.log(mess.M17.timestamp);*/
            packet.action = "start";
            if(mess.M17.source == "network") packet.external = true;
            packet.from = mess.M17.source_cs;
            packet.fromName = packet.from;
            packet.to = mess.M17.destination_cs;
            packet.toName = packet.to;
            packet.loss = '-';
            packet.ber = '-';
            packet.rssi = '-';
        }
        else if(mess.M17.action == "end" || mess.M17.action == 'lost') {
            /*console.log("M17 stop:");
            if(typeof mess.M17.rssi != "undefined") console.log(mess.M17.rssi.ave);
            console.log(mess.M17.timestamp);*/
            packet.action = "end";
            if(typeof mess.M17.loss != "undefined") packet.loss= parseFloat(mess.M17.loss).toFixed(2) + '%';
            else packet.loss = '-';
            if(typeof mess.M17.ber != "undefined") packet.ber= parseFloat(mess.M17.ber).toFixed(2) + '%';
            else packet.ber = '-';
            if(typeof mess.M17.rssi != "undefined") packet.rssi= mess.M17.rssi.ave + 'dBm';
            else packet.rssi = '-';
        }
        handleOpenCalls( packet );
    }

    // Mode
    else if(typeof mess.MMDVM != "undefined") {
        sPacket.mode = mess.MMDVM.mode.toUpperCase();
        if(mess.MMDVM.mode == 'idle') {
          sPacket.rssi = '-';
          sPacket.text = '-';
        }
        transmitStatus(sPacket);
    }

    // S-Meter
    else if(typeof mess.RSSI != "undefined") {
        sPacket.mode = mess.RSSI.mode.toUpperCase();
        sPacket.rssi = mess.RSSI.value;
        transmitStatus(sPacket);
    }

    // Talker alias
    else if(typeof mess.Text != "undefined") {
        sPacket.text = mess.Text.value;
    }

  } catch( e ) {
    console.error('Could not decode mqtt message', e)
  }
})

console.log(`[HELLO] Running digital voice dashboard v${versionNumber}`)

const port= parseInt(process.env.PORT)
app.listen(port, () => {
  console.log(`[HTTP] Server listening on ${port}`)
})
