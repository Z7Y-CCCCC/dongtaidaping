const os = require('os');

// 这些通常是 VPN、虚拟机、容器或代理创建的网卡。向这些网卡发送 SSDP 会把
// 本机服务误识别成电视，也会生成电视无法访问的视频地址。
const VIRTUAL_INTERFACE_PATTERN = /(?:^|[\s_(\-])(?:vethernet|hyper[- ]?v|vmware|virtualbox|docker|wsl|tailscale|zerotier|wireguard|clash|tun\d*|tap\d*|vpn|loopback)(?:$|[\s_)\-])/i;

function ipv4ToLong(address) {
    const parts = String(address || '').split('.');
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const number = Number(part);
        if (number < 0 || number > 255) return null;
        value = ((value << 8) | number) >>> 0;
    }
    return value;
}

function isBenchmarkIpv4(address) {
    const value = ipv4ToLong(address);
    if (value == null) return false;
    // RFC 2544：198.18.0.0/15 只用于网络设备测试；Clash 等代理常把它用作虚拟网段。
    return value >= ipv4ToLong('198.18.0.0') && value <= ipv4ToLong('198.19.255.255');
}

function isUsableLanIpv4(address) {
    const value = ipv4ToLong(address);
    if (value == null) return false;
    if (address === '0.0.0.0' || /^127\./.test(address) || /^169\.254\./.test(address)) return false;
    if (isBenchmarkIpv4(address)) return false;
    // 组播、保留地址和有限广播都不能作为电视回连地址。
    const first = value >>> 24;
    return first > 0 && first < 224;
}

function isPrivateIpv4(address) {
    return /^10\./.test(address)
        || /^192\.168\./.test(address)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function isVirtualInterfaceName(name) {
    return VIRTUAL_INTERFACE_PATTERN.test(String(name || ''));
}

function allHostIpv4Addresses(networks = os.networkInterfaces()) {
    const addresses = [];
    for (const entries of Object.values(networks || {})) {
        for (const entry of entries || []) {
            if (entry.family !== 'IPv4' || entry.internal || !ipv4ToLong(entry.address)) continue;
            if (!addresses.includes(entry.address)) addresses.push(entry.address);
        }
    }
    return addresses;
}

function listLanIpv4Interfaces(networks = os.networkInterfaces()) {
    const physical = [];
    const fallback = [];
    for (const [name, entries] of Object.entries(networks || {})) {
        for (const entry of entries || []) {
            if (entry.family !== 'IPv4' || entry.internal || !isUsableLanIpv4(entry.address)) continue;
            const item = {
                name,
                address: entry.address,
                netmask: entry.netmask || '',
                virtual: isVirtualInterfaceName(name)
            };
            fallback.push(item);
            if (!item.virtual) physical.push(item);
        }
    }

    // 正常机器优先只用物理网卡；极端环境没有可识别的物理网卡时才回退，避免功能彻底不可用。
    const selected = physical.length ? physical : fallback;
    return selected.sort((a, b) => Number(isPrivateIpv4(b.address)) - Number(isPrivateIpv4(a.address)));
}

module.exports = {
    allHostIpv4Addresses,
    ipv4ToLong,
    isBenchmarkIpv4,
    isPrivateIpv4,
    isUsableLanIpv4,
    isVirtualInterfaceName,
    listLanIpv4Interfaces
};
