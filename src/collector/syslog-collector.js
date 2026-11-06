import dgram from 'node:dgram';

import { isLoopbackIp } from '../utils/ip.js';
import { parseSecurityEvent } from './event-parser.js';
import { parseSyslogMessage } from './syslog-parser.js';

const MAX_UDP_MESSAGE_BYTES = 65507;

function nowIso() {
    return new Date().toISOString();
}

function validateCollectorOptions({ host, port, tag, maxMessageBytes, recvBufferBytes }) {
    if (!isLoopbackIp(host)) {
        throw new TypeError('Syslog collector host must be a loopback address');
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new TypeError('Syslog collector port must be between 0 and 65535');
    }
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(tag)) {
        throw new TypeError('Syslog collector tag has an invalid format');
    }
    if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 512 || maxMessageBytes > MAX_UDP_MESSAGE_BYTES) {
        throw new TypeError(`Syslog collector maxMessageBytes must be between 512 and ${MAX_UDP_MESSAGE_BYTES}`);
    }
    if (!Number.isInteger(recvBufferBytes) || recvBufferBytes < 65536) {
        throw new TypeError('Syslog collector recvBufferBytes must be at least 65536');
    }
}

export function createSyslogCollector(options) {
    const {
        host = '127.0.0.1',
        port = 5514,
        tag = 'nodefw',
        maxMessageBytes = 8192,
        recvBufferBytes = 1024 * 1024,
        userAgentMaxLength = 512,
        logger = null,
        onEvent = () => {},
        onInvalid = () => {},
    } = options ?? {};

    validateCollectorOptions({ host, port, tag, maxMessageBytes, recvBufferBytes });

    const stats = {
        started: false,
        host,
        port,
        received: 0,
        bytesReceived: 0,
        accepted: 0,
        invalid: 0,
        invalidByReason: {},
        handlerErrors: 0,
        lastMessageAt: null,
        lastAcceptedAt: null,
        lastInvalidAt: null,
        lastError: null,
        startedAt: null,
        stoppedAt: null,
    };

    let socket = null;
    let boundAddress = null;
    let started = false;
    let stopping = false;
    let lastInvalidLogAt = 0;
    let suppressedInvalidLogs = 0;

    function callSafely(callback, value, label) {
        try {
            const result = callback(value);
            if (result && typeof result.then === 'function') {
                result.catch((error) => {
                    stats.handlerErrors += 1;
                    logger?.error({ err: error, callback: label }, 'collector callback failed');
                });
            }
        } catch (error) {
            stats.handlerErrors += 1;
            logger?.error({ err: error, callback: label }, 'collector callback failed');
        }
    }

    function logInvalid(reason, meta) {
        const now = Date.now();
        if (now - lastInvalidLogAt >= 60_000) {
            logger?.warn(
                {
                    reason,
                    source: meta?.source ?? null,
                    suppressedSinceLastLog: suppressedInvalidLogs,
                },
                'dropped invalid syslog message'
            );
            lastInvalidLogAt = now;
            suppressedInvalidLogs = 0;
            return;
        }

        suppressedInvalidLogs += 1;
    }

    function recordInvalid(reason, meta = {}) {
        stats.invalid += 1;
        stats.invalidByReason[reason] = (stats.invalidByReason[reason] ?? 0) + 1;
        stats.lastInvalidAt = nowIso();
        callSafely(onInvalid, { reason, ...meta }, 'onInvalid');
        logInvalid(reason, meta);
    }

    function handleMessage(message, rinfo) {
        stats.received += 1;
        stats.bytesReceived += message.length;
        stats.lastMessageAt = nowIso();

        if (!isLoopbackIp(rinfo.address)) {
            recordInvalid('source_not_loopback', { source: rinfo.address });
            return;
        }

        if (message.length > maxMessageBytes) {
            recordInvalid('oversize', { source: rinfo.address, size: message.length });
            return;
        }

        let syslog;
        try {
            syslog = parseSyslogMessage(message.toString('utf8'), { tag });
        } catch (error) {
            recordInvalid(error.reason ?? 'syslog_parse_error', { source: rinfo.address });
            return;
        }

        let event;
        try {
            event = parseSecurityEvent(syslog.message, { userAgentMaxLength });
        } catch (error) {
            recordInvalid(error.reason ?? 'event_validation_error', { source: rinfo.address });
            return;
        }

        event.syslog = {
            timestamp: syslog.timestamp,
            hostname: syslog.hostname,
            tag: syslog.tag,
            priority: syslog.priority,
            facility: syslog.facility,
            severity: syslog.severity,
        };

        stats.accepted += 1;
        stats.lastAcceptedAt = nowIso();
        callSafely(onEvent, event, 'onEvent');
    }

    function start() {
        if (started) {
            return Promise.resolve(boundAddress);
        }
        if (socket) {
            return Promise.reject(new Error('Syslog collector is already starting or running'));
        }

        const type = host.includes(':') ? 'udp6' : 'udp4';
        const sock = dgram.createSocket({ type, reuseAddr: false });
        socket = sock;

        return new Promise((resolve, reject) => {
            let settled = false;

            const failStart = (error) => {
                stats.lastError = { message: error.message, at: nowIso() };
                if (settled) {
                    logger?.error({ err: error }, 'udp socket error');
                    return;
                }

                settled = true;
                sock.removeAllListeners();
                try {
                    sock.close();
                } catch {
                    // The socket may not have been bound yet.
                }
                socket = null;
                reject(error);
            };

            sock.on('error', failStart);

            sock.on('message', handleMessage);

            sock.on('listening', () => {
                settled = true;
                started = true;
                stopping = false;
                boundAddress = sock.address();
                stats.started = true;
                stats.startedAt = nowIso();
                stats.stoppedAt = null;

                try {
                    sock.setRecvBufferSize(recvBufferBytes);
                } catch (error) {
                    logger?.debug({ err: error }, 'could not set UDP receive buffer size');
                }

                logger?.info(
                    {
                        address: boundAddress.address,
                        port: boundAddress.port,
                        family: boundAddress.family,
                        recvBufferBytes,
                    },
                    'syslog collector listening'
                );
                resolve(boundAddress);
            });

            sock.on('close', () => {
                if (!stopping) {
                    started = false;
                    stats.started = false;
                    logger?.warn('syslog collector closed unexpectedly');
                }
            });

            try {
                sock.bind({ address: host, port, exclusive: true });
            } catch (error) {
                failStart(error);
            }
        });
    }

    async function stop() {
        if (!socket) {
            started = false;
            stats.started = false;
            return;
        }

        stopping = true;
        const sock = socket;

        await new Promise((resolve) => {
            const finish = () => {
                sock.removeAllListeners();
                socket = null;
                boundAddress = null;
                started = false;
                stats.started = false;
                stats.stoppedAt = nowIso();
                resolve();
            };

            try {
                sock.close(finish);
            } catch {
                finish();
            }
        });

        logger?.info('syslog collector stopped');
    }

    function getStats() {
        return {
            ...stats,
            invalidByReason: { ...stats.invalidByReason },
            address: boundAddress ? { ...boundAddress } : null,
            uptimeMs: stats.startedAt ? Date.now() - Date.parse(stats.startedAt) : 0,
        };
    }

    return {
        start,
        stop,
        getStats,
    };
}
