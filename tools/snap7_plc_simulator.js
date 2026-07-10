const path = require('path');
const os = require('os');

const DEVICE_LAYOUTS = [
    { id: 'Furnace_01', baseByte: 30 },
    { id: 'Furnace_02', baseByte: 50 },
    { id: 'Furnace_03', baseByte: 70 },
    { id: 'Furnace_04', baseByte: 90 },
    { id: 'Furnace_05', baseByte: 110 },
    { id: '6# 多用炉', baseByte: 130 },
    { id: '7# 多用炉', baseByte: 150 }
];
const DB_SIZE = 256;

function loadSnap7Module() {
    const candidates = [
        process.env.SNAP7_MODULE_PATH,
        path.join(os.tmpdir(), 'codex-snap7-test', 'node_modules', 'node-snap7')
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (e) {
            // Try the next known location.
        }
    }

    try {
        return require('node-snap7');
    } catch (e) {
        throw new Error(
            'node-snap7 is required for the PLC simulator. Install it in a temp folder or set SNAP7_MODULE_PATH.'
        );
    }
}

function readArg(name, fallback) {
    const prefix = `--${name}=`;
    const item = process.argv.find(arg => arg.startsWith(prefix));
    return item ? item.slice(prefix.length) : fallback;
}

function setBit(buffer, byteOffset, bitOffset, value) {
    const mask = 1 << bitOffset;
    if (value) buffer[byteOffset] |= mask;
    else buffer[byteOffset] &= ~mask;
}

function writeWord(buffer, byteOffset, value) {
    buffer.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(value))), byteOffset);
}

function writeCommonProcessValues(db1, tick) {
    const temperature = 820 + Math.sin(tick / 8) * 18;
    const setpoint = 880;
    const carbon = 86 + Math.cos(tick / 10) * 5; // 后台当前常规点位是 WORD，所以这里按 0.01% 外部自己换算时再扩展。
    const carbonSetpoint = 88;

    writeWord(db1, 0, temperature); // DB1.DBW0 实际温度
    writeWord(db1, 2, setpoint); // DB1.DBW2 设定温度
    writeWord(db1, 4, carbon); // DB1.DBW4 实际碳势
    writeWord(db1, 6, carbonSetpoint); // DB1.DBW6 设定碳势
    setBit(db1, 8, 0, Math.floor(tick / 24) % 2 === 0); // DB1.DBX8.0 bj1
    setBit(db1, 8, 1, Math.floor(tick / 37) % 2 === 0); // DB1.DBX8.1 bj2

    return { temperature, setpoint, carbon, carbonSetpoint };
}

function updateDeviceDb(db1, tick, layout, index) {
    const phaseTick = tick + index * 9;
    const base = layout.baseByte;
    const frontDoorOpen = Math.floor(phaseTick / 18) % 2 === 0;
    const middleDoorOpen = Math.floor((phaseTick + 7) / 26) % 2 === 0;
    const rearFanOn = Math.floor((phaseTick + 3) / 70) % 2 !== 0;
    const frontFanOn = Math.floor((phaseTick + 11) / 82) % 2 !== 0;
    const oilOn = [1, 2, 3, 4].map(n => Math.floor((phaseTick + n * 5) / (58 + n * 7)) % 2 !== 0);

    setBit(db1, base, 0, frontDoorOpen); // front_door_open
    setBit(db1, base, 1, middleDoorOpen); // middle_door_open
    setBit(db1, base, 2, rearFanOn); // rear_fan
    setBit(db1, base, 3, frontFanOn); // front_fan
    oilOn.forEach((on, oilIndex) => setBit(db1, base, 4 + oilIndex, on)); // oil_stir_1..4

    const rearFanSpeed = rearFanOn ? 980 + Math.sin(phaseTick / 5) * 80 : 0;
    const frontFanSpeed = frontFanOn ? 760 + Math.cos(phaseTick / 6) * 70 : 0;
    const oilSpeeds = oilOn.map((on, oilIndex) => on ? 520 + oilIndex * 18 + Math.sin(phaseTick / (4 + oilIndex)) * 35 : 0);

    writeWord(db1, base + 2, rearFanSpeed); // rear_fan_speed
    writeWord(db1, base + 4, frontFanSpeed); // front_fan_speed
    oilSpeeds.forEach((speed, oilIndex) => writeWord(db1, base + 6 + oilIndex * 2, speed)); // oil_stir_N_speed

    return {
        id: layout.id,
        frontDoorOpen,
        middleDoorOpen,
        rearFanSpeed: Math.round(rearFanSpeed),
        frontFanSpeed: Math.round(frontFanSpeed),
        oilSpeeds: oilSpeeds.map(Math.round)
    };
}

function updateDb(db1, tick) {
    db1.fill(0);
    const common = writeCommonProcessValues(db1, tick);
    const devices = DEVICE_LAYOUTS.map((layout, index) => updateDeviceDb(db1, tick, layout, index));
    return { common, devices };
}

function publishDb(server, db1) {
    server.SetArea(server.srvAreaDB, 1, db1);
}

function main() {
    const s7mod = loadSnap7Module();
    const host = readArg('host', '127.0.0.1');
    const port = Number(readArg('port', 1102));
    const intervalMs = Number(readArg('interval', 250));
    const logReads = readArg('log-reads', '0') === '1';

    const server = new s7mod.S7Server();
    server.SetParam(server.LocalPort, port);
    const eventMask = server.evcClientAdded
        | server.evcClientDisconnected
        | (logReads ? server.evcDataRead : 0);
    server.SetEventMask(eventMask);

    const db1 = Buffer.alloc(DB_SIZE);
    let tick = 0;
    updateDb(db1, tick);
    server.RegisterArea(server.srvAreaDB, 1, db1);
    publishDb(server, db1);

    server.on('event', event => {
        console.log(`[snap7-sim] ${server.EventText(event)}`);
    });

    const started = server.StartTo(host);
    if (!started) {
        const code = server.LastError();
        throw new Error(`Snap7 simulator failed to start: ${code} ${server.ErrorText(code)}`);
    }

    console.log(`[snap7-sim] listening on ${host}:${port}, DB1 size=${db1.length}`);
    console.log('[snap7-sim] common: DBW0 temp, DBW2 setTemp, DBW4 carbon, DBW6 setCarbon, DBX8.0/8.1 alarm bits');
    console.log('[snap7-sim] per furnace: base=30+index*20; DBXbase.0 front door, .1 middle door, .2/.3 fans, .4-.7 oil stir, DBWbase+2..+12 speeds');

    const timer = setInterval(() => {
        tick += 1;
        const values = updateDb(db1, tick);
        publishDb(server, db1);
        if (tick % Math.max(1, Math.round(5000 / intervalMs)) === 0) {
            const doorSummary = values.devices.map(item => `${item.id}:F${item.frontDoorOpen ? 1 : 0}/M${item.middleDoorOpen ? 1 : 0}`).join(' ');
            const speedSummary = values.devices.slice(0, 2).map(item => `${item.id}:fan${item.rearFanSpeed}/${item.frontFanSpeed},oil${item.oilSpeeds.join('/')}`).join(' | ');
            console.log(`[snap7-sim] temp=${Math.round(values.common.temperature)} carbon=${Math.round(values.common.carbon)} doors=${doorSummary}`);
            console.log(`[snap7-sim] sample speeds ${speedSummary}`);
        }
    }, intervalMs);

    function shutdown() {
        clearInterval(timer);
        try {
            server.Stop();
            server.UnregisterArea(server.srvAreaDB, 1);
        } catch (e) {
            // Ignore shutdown races.
        }
        console.log('[snap7-sim] stopped');
        process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main();
