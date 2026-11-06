import { isIP } from 'node:net';

const NON_PUBLIC_SCOPES = new Set([
    'private',
    'loopback',
    'linkLocal',
    'shared',
    'unspecified',
    'documentation',
    'reserved',
]);

function ipv4Scope(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return 'invalid';
    }

    const [a, b, c] = parts;

    if (a === 0 && b === 0 && c === 0 && parts[3] === 0) {
        return 'unspecified';
    }
    if (a === 127) {
        return 'loopback';
    }
    if (a === 10) {
        return 'private';
    }
    if (a === 172 && b >= 16 && b <= 31) {
        return 'private';
    }
    if (a === 192 && b === 168) {
        return 'private';
    }
    if (a === 169 && b === 254) {
        return 'linkLocal';
    }
    if (a === 100 && b >= 64 && b <= 127) {
        return 'shared';
    }
    if (a === 192 && b === 0 && c === 2) {
        return 'documentation';
    }
    if (a === 198 && b === 51 && c === 100) {
        return 'documentation';
    }
    if (a === 203 && b === 0 && c === 113) {
        return 'documentation';
    }
    if (a >= 224 && a <= 239) {
        return 'multicast';
    }
    if (a >= 240) {
        return 'reserved';
    }

    return 'public';
}

function ipv6Scope(ip) {
    const address = ip.toLowerCase().split('%', 1)[0];

    if (address === '::') {
        return 'unspecified';
    }
    if (address === '::1') {
        return 'loopback';
    }

    const mappedIpv4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedIpv4) {
        return ipv4Scope(mappedIpv4[1]);
    }

    const firstHextet = address.split(':', 1)[0];
    const firstValue = firstHextet === '' ? 0 : Number.parseInt(firstHextet, 16);
    if (!Number.isInteger(firstValue)) {
        return 'invalid';
    }

    if ((firstValue & 0xffc0) === 0xfe80) {
        return 'linkLocal';
    }
    if ((firstValue & 0xfe00) === 0xfc00) {
        return 'private';
    }
    if (address === '2001:db8' || address.startsWith('2001:db8:')) {
        return 'documentation';
    }
    if ((firstValue & 0xff00) === 0xff00) {
        return 'multicast';
    }

    return 'public';
}

export function getIpScope(ip) {
    if (typeof ip !== 'string') {
        return 'invalid';
    }

    const version = isIP(ip);
    if (version === 0) {
        return 'invalid';
    }
    if (version === 4) {
        return ipv4Scope(ip);
    }

    return ipv6Scope(ip);
}

export function isLoopbackIp(ip) {
    return getIpScope(ip) === 'loopback';
}

export function isPrivateOrLocalIp(ip) {
    return NON_PUBLIC_SCOPES.has(getIpScope(ip));
}
