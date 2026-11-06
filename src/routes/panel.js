import { readFile } from 'node:fs/promises';

const PANEL_HTML = await readFile(new URL('../panel/observation.html', import.meta.url), 'utf8');
const PANEL_CSS = await readFile(new URL('../panel/style.css', import.meta.url), 'utf8');
const PANEL_JS = await readFile(new URL('../panel/app.js', import.meta.url), 'utf8');

const PANEL_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

function setPanelHeaders(reply) {
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', PANEL_CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
}

function sendPanelAsset(reply, contentType, body) {
    setPanelHeaders(reply);
    reply.type(contentType);
    return reply.send(body);
}

export async function panelRoutes(app, options) {
    const { getRecentEvents = null } = options;

    const serveHtml = async (request, reply) => sendPanelAsset(
        reply,
        'text/html; charset=utf-8',
        PANEL_HTML
    );

    app.get('/', async (request, reply) => reply.redirect('/panel'));
    app.get('/panel', serveHtml);
    app.get('/panel/', serveHtml);
    app.get('/panel/style.css', async (request, reply) => sendPanelAsset(
        reply,
        'text/css; charset=utf-8',
        PANEL_CSS
    ));
    app.get('/panel/app.js', async (request, reply) => sendPanelAsset(
        reply,
        'text/javascript; charset=utf-8',
        PANEL_JS
    ));

    app.get('/api/events/recent', async (request, reply) => {
        setPanelHeaders(reply);

        if (typeof getRecentEvents !== 'function') {
            reply.code(503);
            return { error: 'events_unavailable' };
        }

        try {
            const data = await getRecentEvents(request.query ?? {});
            return {
                status: 'ok',
                ...data,
            };
        } catch (error) {
            if (error?.code === 'INVALID_QUERY') {
                reply.code(400);
                return { error: 'invalid_query' };
            }
            if (error?.code === 'STORAGE_NOT_READY') {
                reply.code(503);
                return { error: 'storage_not_ready' };
            }

            request.log.error({ err: error }, 'recent events query failed');
            reply.code(500);
            return { error: 'internal_error' };
        }
    });
}
