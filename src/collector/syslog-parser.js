const PRIORITY_PATTERN = /^<(\d{1,3})>/;
const RFC3164_TIMESTAMP_PATTERN = /^[A-Z][a-z]{2}\s{1,2}\d{1,2}\s\d{2}:\d{2}:\d{2}\s+/;
const TAG_PATTERN = /^(?:(?<hostname>[A-Za-z0-9._-]+)\s+)?(?<tag>[A-Za-z0-9._-]+):\s*(?<message>[\s\S]*)$/;

export class SyslogParseError extends Error {
    constructor(reason, message) {
        super(message);
        this.name = 'SyslogParseError';
        this.code = 'SYSLOG_PARSE_ERROR';
        this.reason = reason;
    }
}

export function parseSyslogMessage(input, { tag: expectedTag } = {}) {
    if (typeof input !== 'string') {
        throw new SyslogParseError('invalid_input', 'Syslog message must be a string');
    }

    let remainder = input.replace(/[\r\n]+$/, '');
    if (remainder === '') {
        throw new SyslogParseError('empty_message', 'Syslog message is empty');
    }

    let priority = null;
    const priorityMatch = remainder.match(PRIORITY_PATTERN);
    if (priorityMatch) {
        priority = Number(priorityMatch[1]);
        if (!Number.isInteger(priority) || priority < 0 || priority > 191) {
            throw new SyslogParseError('invalid_priority', 'Syslog priority is out of range');
        }
        remainder = remainder.slice(priorityMatch[0].length);
    }

    let timestamp = null;
    const timestampMatch = remainder.match(RFC3164_TIMESTAMP_PATTERN);
    if (timestampMatch) {
        timestamp = timestampMatch[0].trim();
        remainder = remainder.slice(timestampMatch[0].length);
    }

    const tagMatch = remainder.match(TAG_PATTERN);
    if (!tagMatch || !tagMatch.groups) {
        throw new SyslogParseError('malformed_syslog', 'Syslog message does not contain a tag and payload');
    }

    const parsedTag = tagMatch.groups.tag;
    if (expectedTag && parsedTag !== expectedTag) {
        throw new SyslogParseError('unexpected_tag', 'Syslog tag does not match the expected tag');
    }

    const message = tagMatch.groups.message.trim();
    if (message === '') {
        throw new SyslogParseError('empty_message', 'Syslog payload is empty');
    }

    return {
        priority,
        facility: priority === null ? null : priority >> 3,
        severity: priority === null ? null : priority & 7,
        timestamp,
        hostname: tagMatch.groups.hostname ?? null,
        tag: parsedTag,
        message,
    };
}
