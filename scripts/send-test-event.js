#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
    options: {
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: '5514' },
        tag: { type: 'string', default: 'nodefw' },
        site: { type: 'string', default: 'www.example.com' },
        ip: { type: 'string', default: '203.0.113.10' },
        path: { type: 'string', default: '/teste-node-fw?utm=simulacao' },
        status: { type: 'string', default: '200' },
    },
    strict: true,
});

const host = values.host;
const port = Number(values.port);
const status = Number(values.status);

if (host !== '127.0.0.1' && host !== '::1') {
    console.error('host must be 127.0.0.1 or ::1');
    process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('port must be an integer between 1 and 65535');
    process.exit(1);
}
if (!Number.isInteger(status) || status < 100 || status > 599) {
    console.error('status must be an integer between 100 and 599');
    process.exit(1);
}

const now = new Date();
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = String(now.getDate()).padStart(2, ' ');
const syslogTimestamp = [
    months[now.getMonth()],
    day,
    [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':'),
].join(' ');

const event = {
    timestamp: now.toISOString(),
    request_id: randomBytes(16).toString('hex'),
    site: values.site,
    server_name: values.site,
    ip: values.ip,
    method: 'GET',
    path: values.path,
    final_uri: '/index.php',
    status,
    request_time: 0.042,
    upstream_addr: 'unix:/run/php/php8.2-fpm.sock',
    upstream_time: '0.038',
    dynamic: 1,
    scheme: 'https',
    body_bytes_sent: 1234,
    user_agent: 'Mozilla/5.0 (NodeFW test event)',
};

const line = `<134>${syslogTimestamp} web01 ${values.tag}: ${JSON.stringify(event)}`;
const socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');

socket.send(Buffer.from(line, 'utf8'), port, host, (error) => {
    socket.close();
    if (error) {
        console.error(`failed to send test event: ${error.message}`);
        process.exitCode = 1;
        return;
    }

    console.log(`test event sent to ${host}:${port} site=${values.site}`);
});
