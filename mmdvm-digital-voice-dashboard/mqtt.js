import mqtt from 'mqtt'

export async function mqttConnect() {
  try {
    // Connect to the mqtt server with username and password
    const client = await mqtt.connectAsync(process.env.MQTT_HOST, {
      clientId: process.env.MQTT_CLIENT,
      username: process.env.MQTT_USER,
      password: process.env.MQTT_PASSWORD
    });

    // Subscribe to the topic
    console.log('[MQTT] Connected to server')
    let topic_list = [];
    topic_list.push(process.env.MQTT_MMDVM, process.env.MQTT_TEMP, process.env.MQTT_HUM);
    await client.subscribeAsync(topic_list);

    // Setup event listeners for errors or reconnect
    client.on("reconnect", () => {
      console.error('[MQTT] Reconnected to server')
    }).on('error', error => {
      console.error('[MQTT] Error:', error)
    })

    return client

  } catch( e ) {
    console.error('[MQTT] Could not connect/subscribe to server:', e)
    return null
  }
}
