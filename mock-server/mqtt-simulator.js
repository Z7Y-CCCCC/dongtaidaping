const mqtt = require('mqtt');

// 连接到 EMQX 公共测试服务器
// 注意：在实际局域网部署中，应修改为类似 'mqtt://192.168.1.100:1883'
const client = mqtt.connect('mqtt://broker.emqx.io:1883');

const TOPIC_REALTIME = 'factory/Line1/realtime';

// 20 台炉子的配置
const furnaceConfigs = [];
for (let i = 1; i <= 20; i++) {
    furnaceConfigs.push({ 
        id: `Furnace_${String(i).padStart(2, '0')}`, 
        name: `${i}#多用炉`, 
        baseTemp: 840 + Math.random() * 20, 
        baseCarbon: 0.8 + Math.random() * 0.1 
    });
}

console.log('正在连接 MQTT 测试服务器...');

client.on('connect', () => {
    console.log('✅ MQTT 服务器连接成功');
    
    // 每 2 秒为每台炉子各发一次
    setInterval(() => {
        furnaceConfigs.forEach((cfg, index) => {
            // 每台炉子错开 200ms 发送，避免同时大量消息
            setTimeout(() => publishMockData(cfg), index * 200);
        });
    }, 2000);
});

client.on('error', (err) => {
    console.error('MQTT 连接错误:', err);
});

function publishMockData(cfg) {
    const now = Date.now();
    // 模拟数据结构
    const payload = {
        timestamp: now,
        furnace_id: cfg.id,
        furnace_name: cfg.name,
        analog: {
            actual_temp: (cfg.baseTemp - 10 + Math.random() * 20).toFixed(1),
            setpoint_temp: cfg.baseTemp,
            actual_carbon: (cfg.baseCarbon - 0.05 + Math.random() * 0.1).toFixed(2),
            setpoint_carbon: cfg.baseCarbon
        },
        motors: {
            stir_motor: Math.random() > 0.1,   // 90% 概率运行
            fan_motor: Math.random() > 0.1,
            oil_pump: Math.random() > 0.5
        },
        mechanisms: {
            push_chain_forward: (Math.floor(now / 10000) % 2 === 0),
            push_chain_backward: (Math.floor(now / 10000) % 2 !== 0),
        },
        doors: {
            front_door_closed: (Math.floor(now / 15000) % 2 === 0),
            front_door_open: (Math.floor(now / 15000) % 2 !== 0),
            middle_door_closed: true,
            middle_door_open: false
        },
        status: {
            running: true,
            alarm: Math.random() > 0.85,  // 15% 概率触发报警测试
            alarm_code: 0,
            alarm_msg: ""
        }
    };

    const message = JSON.stringify(payload);
    client.publish(TOPIC_REALTIME, message);
    console.log(`[${new Date().toLocaleTimeString()}] ${cfg.name} 发布数据`);
}
