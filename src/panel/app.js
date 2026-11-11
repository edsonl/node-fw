(() => {
    'use strict';

    const REFRESH_INTERVAL_MS = 10000;
    const REQUEST_TIMEOUT_MS = 8000;

    const state = {
        filters: { site: '', ip: '', status: '', limit: 50 },
        events: [],
        cursor: null,
        hasMore: false,
        loadingEvents: false,
        loadingStats: false,
        autoRefresh: true,
        lastUpdated: null,
    };

    const els = {
        appVersion: byId('app-version'),
        lastUpdate: byId('last-update'),
        errorBanner: byId('error-banner'),
        metricReq1m: byId('metric-req-1m'),
        metricReq5m: byId('metric-req-5m'),
        metricReq15m: byId('metric-req-15m'),
        metricUnique1m: byId('metric-unique-1m'),
        statusChips: byId('status-chips'),
        metricInvalid: byId('metric-invalid'),
        invalidReasons: byId('invalid-reasons'),
        metricQueue: byId('metric-queue'),
        queueDetail: byId('queue-detail'),
        metricRedis: byId('metric-redis'),
        redisDetail: byId('redis-detail'),
        metricMaxmind: byId('metric-maxmind'),
        maxmindDetail: byId('maxmind-detail'),
        metricClassification: byId('metric-classification'),
        classificationDetail: byId('classification-detail'),
        metricWrites: byId('metric-writes'),
        pipelineDetail: byId('pipeline-detail'),
        eventCount: byId('event-count'),
        eventsBody: byId('events-body'),
        emptyState: byId('empty-state'),
        loadStatus: byId('load-status'),
        loadMore: byId('load-more'),
        refreshNow: byId('refresh-now'),
        healthGrid: byId('health-grid'),
        filters: byId('filters'),
        filterSite: byId('filter-site'),
        filterIp: byId('filter-ip'),
        filterStatus: byId('filter-status'),
        filterLimit: byId('filter-limit'),
        applyFilters: byId('apply-filters'),
        clearFilters: byId('clear-filters'),
        autoRefresh: byId('auto-refresh'),
    };

    const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'medium',
    });
    const numberFormatter = new Intl.NumberFormat('pt-BR');

    function byId(id) {
        return document.getElementById(id);
    }

    function setText(element, value) {
        element.textContent = value === undefined || value === null || value === ''
            ? '—'
            : String(value);
    }

    function setHidden(element, hidden) {
        element.classList.toggle('hidden', hidden);
    }

    function showError(message) {
        els.errorBanner.textContent = message;
        setHidden(els.errorBanner, false);
    }

    function clearError() {
        els.errorBanner.textContent = '';
        setHidden(els.errorBanner, true);
    }

    function formatNumber(value) {
        if (value === undefined || value === null || value === '') {
            return '—';
        }
        return Number.isFinite(Number(value)) ? numberFormatter.format(Number(value)) : '—';
    }

    function formatTime(value) {
        if (!value) {
            return '—';
        }

        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : timeFormatter.format(date);
    }

    function formatDuration(value) {
        if (value === undefined || value === null || value === '' || !Number.isFinite(Number(value))) {
            return '—';
        }

        const seconds = Number(value);
        return seconds < 1
            ? `${Math.round(seconds * 1000)} ms`
            : `${seconds.toFixed(3)} s`;
    }

    function levelClass(level) {
        switch (level) {
            case 'observation':
                return 'level-observation';
            case 'suspect':
                return 'level-suspect';
            case 'critical':
                return 'level-critical';
            default:
                return 'level-normal';
        }
    }

    function statusClass(status) {
        if (!Number.isInteger(status)) {
            return 'status';
        }
        if (status >= 200 && status < 300) {
            return 'status status-2xx';
        }
        if (status >= 300 && status < 400) {
            return 'status status-3xx';
        }
        if (status >= 400 && status < 500) {
            return 'status status-4xx';
        }
        if (status >= 500 && status < 600) {
            return 'status status-5xx';
        }
        return 'status';
    }

    async function fetchJson(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(url, {
                cache: 'no-store',
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            });
            const body = await response.json().catch(() => null);

            if (!response.ok) {
                const reason = body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
                throw new Error(reason);
            }

            return body;
        } finally {
            clearTimeout(timer);
        }
    }

    function readFilters() {
        const site = els.filterSite.value.trim();
        const ip = els.filterIp.value.trim();
        const statusText = els.filterStatus.value.trim();
        const limit = Number(els.filterLimit.value);

        if (statusText !== '' && !/^\d+$/.test(statusText)) {
            throw new Error('Status deve ser um número entre 100 e 599.');
        }

        const status = statusText === '' ? '' : Number(statusText);
        if (status !== '' && (status < 100 || status > 599)) {
            throw new Error('Status deve estar entre 100 e 599.');
        }
        if (![25, 50, 100].includes(limit)) {
            throw new Error('Limite de página inválido.');
        }

        return { site, ip, status, limit };
    }

    function buildQuery(extra = {}) {
        const params = new URLSearchParams();
        if (state.filters.site) {
            params.set('site', state.filters.site);
        }
        if (state.filters.ip) {
            params.set('ip', state.filters.ip);
        }
        if (state.filters.status !== '') {
            params.set('status', String(state.filters.status));
        }
        params.set('limit', String(state.filters.limit));
        if (extra.cursor) {
            params.set('cursor', extra.cursor);
        }
        return params.toString();
    }

    function renderEvents() {
        const rows = state.events.map((event) => {
            const row = document.createElement('tr');

            const timeCell = document.createElement('td');
            timeCell.className = 'time';
            timeCell.textContent = formatTime(event.timestamp || event.receivedAt);
            timeCell.title = event.receivedAt
                ? `Recebido em ${event.receivedAt}`
                : timeCell.textContent;
            row.append(timeCell);

            const siteCell = document.createElement('td');
            siteCell.textContent = event.site || '—';
            row.append(siteCell);

            const ipCell = document.createElement('td');
            ipCell.className = 'ip';
            ipCell.textContent = event.ip || '—';
            row.append(ipCell);

            const originCell = document.createElement('td');
            originCell.className = 'origin';
            const origin = [];
            if (event.country) {
                origin.push(event.country);
            }
            if (Number.isInteger(event.asn)) {
                origin.push(`AS${event.asn}`);
            }
            originCell.textContent = origin.length > 0 ? origin.join(' · ') : '—';
            const originDetails = [];
            if (event.asnOrg) {
                originDetails.push(event.asnOrg);
            }
            if (event.geoProfile) {
                originDetails.push(`perfil ${event.geoProfile} ×${event.geoFactor ?? 1}`);
            }
            if (event.geoFallback) {
                originDetails.push('país ausente: perfil padrão');
            }
            if (originDetails.length > 0) {
                originCell.title = originDetails.join(' · ');
            }
            row.append(originCell);

            const methodCell = document.createElement('td');
            methodCell.className = 'method';
            methodCell.textContent = event.method || '—';
            row.append(methodCell);

            const pathCell = document.createElement('td');
            pathCell.className = 'path';
            pathCell.textContent = event.path || '—';
            if (event.finalUri && event.finalUri !== event.path) {
                pathCell.title = `URI final: ${event.finalUri}`;
            }
            row.append(pathCell);

            const statusCell = document.createElement('td');
            const statusBadge = document.createElement('span');
            statusBadge.className = statusClass(event.status);
            statusBadge.textContent = Number.isInteger(event.status) ? String(event.status) : '—';
            statusCell.append(statusBadge);
            row.append(statusCell);

            const scoreCell = document.createElement('td');
            scoreCell.className = 'score';
            const scoreBadge = document.createElement('span');
            scoreBadge.className = `score-badge ${levelClass(event.level)}`;
            scoreBadge.textContent = Number.isInteger(event.score)
                ? `${event.score} ${event.level ?? ''}`.trim()
                : '—';
            if (Array.isArray(event.reasons) && event.reasons.length > 0) {
                scoreBadge.title = event.reasons.join(' · ');
            }
            scoreCell.append(scoreBadge);
            row.append(scoreCell);

            const durationCell = document.createElement('td');
            durationCell.className = 'duration';
            durationCell.textContent = formatDuration(event.requestTime);
            row.append(durationCell);

            const dynamicCell = document.createElement('td');
            const dynamicBadge = document.createElement('span');
            dynamicBadge.className = event.dynamic ? 'badge dynamic' : 'badge';
            dynamicBadge.textContent = event.dynamic ? 'Sim' : '—';
            dynamicCell.append(dynamicBadge);
            row.append(dynamicCell);

            const userAgentCell = document.createElement('td');
            userAgentCell.className = 'ua';
            userAgentCell.textContent = event.userAgent || '—';
            if (event.userAgent) {
                userAgentCell.title = event.userAgentTruncated
                    ? `${event.userAgent} (truncado)`
                    : event.userAgent;
            }
            row.append(userAgentCell);

            return row;
        });

        els.eventsBody.replaceChildren(...rows);
        setHidden(els.emptyState, state.events.length !== 0);
        els.eventCount.textContent = `${state.events.length} evento${state.events.length === 1 ? '' : 's'}${state.hasMore ? ' · há mais' : ''}`;
        setHidden(els.loadMore, !state.hasMore);
    }

    function renderSummary(summary) {
        const data = summary
            ? (state.filters.site ? summary.site : summary.global)
            : null;

        const requests = data?.requests ?? null;
        setText(els.metricReq1m, requests ? formatNumber(requests['1m']) : '—');
        setText(els.metricReq5m, requests ? formatNumber(requests['5m']) : '—');
        setText(els.metricReq15m, requests ? formatNumber(requests['15m']) : '—');
        setText(els.metricUnique1m, data?.unique ? formatNumber(data.unique['1m']) : '—');

        const statuses = data?.status && typeof data.status === 'object'
            ? Object.entries(data.status)
                .map(([code, count]) => [String(code), Number(count)])
                .filter(([, count]) => Number.isFinite(count))
                .sort((a, b) => b[1] - a[1])
            : [];

        if (statuses.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'muted';
            empty.textContent = '—';
            els.statusChips.replaceChildren(empty);
        } else {
            const chips = statuses.slice(0, 8).map(([code, count]) => {
                const chip = document.createElement('span');
                chip.className = 'chip';
                chip.textContent = `${code}: ${formatNumber(count)}`;
                return chip;
            });
            els.statusChips.replaceChildren(...chips);
        }
    }

    function renderStats(stats) {
        const collector = stats?.collector ?? null;
        const pipeline = stats?.pipeline ?? null;
        const redis = stats?.redis ?? null;
        const maxmind = stats?.maxmind ?? null;
        const classification = stats?.classification ?? null;

        setText(els.metricInvalid, collector ? formatNumber(collector.invalid) : '—');
        const reasons = collector?.invalidByReason && typeof collector.invalidByReason === 'object'
            ? Object.entries(collector.invalidByReason)
                .filter(([, count]) => Number(count) > 0)
                .map(([reason, count]) => `${reason}: ${formatNumber(count)}`)
            : [];
        els.invalidReasons.textContent = reasons.length > 0
            ? reasons.join(' · ')
            : (collector ? 'nenhum' : 'indisponível');

        const queue = pipeline?.queue ?? null;
        setText(els.metricQueue, queue ? formatNumber(queue.currentDepth) : '—');
        els.queueDetail.textContent = queue
            ? `máx ${formatNumber(queue.maxSize)} · descartados ${formatNumber(queue.droppedTotal)}`
            : 'indisponível';

        setText(els.metricRedis, redis ? (redis.ready ? 'Pronto' : 'Indisponível') : '—');
        els.metricRedis.className = redis
            ? (redis.ready ? 'metric-ok' : 'metric-bad')
            : '';
        els.redisDetail.textContent = redis
            ? `DB ${redis.database ?? '—'} · reconexões ${formatNumber(redis.reconnectAttempts)}`
            : 'indisponível';

        if (!maxmind) {
            setText(els.metricMaxmind, '—');
            els.metricMaxmind.className = '';
            els.maxmindDetail.textContent = 'indisponível';
        } else if (!maxmind.enabled) {
            setText(els.metricMaxmind, 'Desativado');
            els.metricMaxmind.className = '';
            els.maxmindDetail.textContent = 'MAXMIND_ENABLED=false';
        } else if (maxmind.countryReady && maxmind.asnReady) {
            setText(els.metricMaxmind, 'Pronto');
            els.metricMaxmind.className = 'metric-ok';
            els.maxmindDetail.textContent = `cache ${formatNumber(maxmind.cacheEntries)}/${formatNumber(maxmind.cacheMaxEntries)}`;
        } else {
            setText(els.metricMaxmind, 'Degradado');
            els.metricMaxmind.className = 'metric-warn';
            els.maxmindDetail.textContent = `país ${maxmind.countryReady ? 'ok' : '—'} · ASN ${maxmind.asnReady ? 'ok' : '—'}`;
        }

        if (!classification) {
            setText(els.metricClassification, '—');
            els.metricClassification.className = '';
            els.classificationDetail.textContent = 'indisponível';
        } else {
            const levels = classification.levelCounts ?? {};
            const mode = classification.modeCounts ?? {};
            const dominantMode = Object.entries(mode)
                .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] ?? '1';
            setText(els.metricClassification, `Modo ${dominantMode}`);
            els.metricClassification.className = 'metric-ok';
            els.classificationDetail.textContent = `suspeitos ${formatNumber(levels.suspect)} · críticos ${formatNumber(levels.critical)} · IPs ${formatNumber(classification.trackedIps)}`;
        }

        setText(els.metricWrites, pipeline ? formatNumber(pipeline.writtenEvents) : '—');
        els.pipelineDetail.textContent = pipeline
            ? `lotes ${formatNumber(pipeline.batches)} · falhas ${formatNumber(pipeline.writeFailures)} · descartados ${formatNumber(pipeline.failedEvents)}`
            : 'indisponível';

        renderHealth(stats);
    }

    function addHealthItem(title, entries) {
        const item = document.createElement('div');
        item.className = 'health-item';

        const heading = document.createElement('h3');
        heading.textContent = title;
        item.append(heading);

        const list = document.createElement('dl');
        for (const [label, value] of entries) {
            const term = document.createElement('dt');
            term.textContent = label;
            const description = document.createElement('dd');
            description.textContent = value === undefined || value === null || value === ''
                ? '—'
                : String(value);
            list.append(term, description);
        }
        item.append(list);
        return item;
    }

    function renderHealth(stats) {
        if (!stats) {
            const unavailable = document.createElement('span');
            unavailable.className = 'muted';
            unavailable.textContent = 'Indicadores indisponíveis.';
            els.healthGrid.replaceChildren(unavailable);
            return;
        }

        const collector = stats.collector ?? null;
        const pipeline = stats.pipeline ?? null;
        const redis = stats.redis ?? null;
        const maxmind = stats.maxmind ?? null;
        const classification = stats.classification ?? null;
        const items = [];

        items.push(addHealthItem('Coletor', [
            ['ativo', collector ? (collector.started ? 'sim' : 'não') : '—'],
            ['recebidos', collector ? formatNumber(collector.received) : '—'],
            ['aceitos', collector ? formatNumber(collector.accepted) : '—'],
            ['inválidos', collector ? formatNumber(collector.invalid) : '—'],
            ['erros de callback', collector ? formatNumber(collector.handlerErrors) : '—'],
        ]));

        items.push(addHealthItem('Fila', [
            ['profundidade', pipeline?.queue ? formatNumber(pipeline.queue.currentDepth) : '—'],
            ['máxima', pipeline?.queue ? formatNumber(pipeline.queue.maxDepth) : '—'],
            ['limite', pipeline?.queue ? formatNumber(pipeline.queue.maxSize) : '—'],
            ['descartados', pipeline?.queue ? formatNumber(pipeline.queue.droppedTotal) : '—'],
        ]));

        items.push(addHealthItem('Redis', [
            ['pronto', redis ? (redis.ready ? 'sim' : 'não') : '—'],
            ['database', redis?.database ?? '—'],
            ['reconexões', redis ? formatNumber(redis.reconnectAttempts) : '—'],
            ['último erro', redis?.lastError?.message ?? '—'],
        ]));

        items.push(addHealthItem('MaxMind', [
            ['habilitado', maxmind ? (maxmind.enabled ? 'sim' : 'não') : '—'],
            ['país', maxmind ? (maxmind.countryReady ? 'pronto' : 'indisponível') : '—'],
            ['ASN', maxmind ? (maxmind.asnReady ? 'pronto' : 'indisponível') : '—'],
            ['cache', maxmind ? `${formatNumber(maxmind.cacheEntries)}/${formatNumber(maxmind.cacheMaxEntries)}` : '—'],
            ['lookups', maxmind ? formatNumber(maxmind.lookups) : '—'],
            ['cache hits', maxmind ? formatNumber(maxmind.cacheHits) : '—'],
            ['ignorados privados', maxmind ? formatNumber(maxmind.privateSkips) : '—'],
            ['erros de leitura', maxmind ? formatNumber(maxmind.lookupErrors) : '—'],
            ['último erro', maxmind?.lastError ? `${maxmind.lastError.edition}: ${maxmind.lastError.code}` : '—'],
        ]));

        const modes = classification?.modeCounts
            ? Object.entries(classification.modeCounts).map(([mode, count]) => `modo ${mode}: ${formatNumber(count)}`).join(' · ')
            : '—';
        const geoProfiles = classification?.geoProfileCounts
            ? Object.entries(classification.geoProfileCounts)
                .map(([profile, count]) => `${profile}: ${formatNumber(count)}`)
                .join(' · ')
            : '—';
        items.push(addHealthItem('Classificação', [
            ['decisões', classification ? formatNumber(classification.decisions) : '—'],
            ['normal', classification ? formatNumber(classification.levelCounts?.normal) : '—'],
            ['observação', classification ? formatNumber(classification.levelCounts?.observation) : '—'],
            ['suspeitos', classification ? formatNumber(classification.levelCounts?.suspect) : '—'],
            ['críticos', classification ? formatNumber(classification.levelCounts?.critical) : '—'],
            ['IPs rastreados', classification ? formatNumber(classification.trackedIps) : '—'],
            ['exceções', classification ? formatNumber(classification.hardExceptions) : '—'],
            ['erros', classification ? formatNumber(classification.errors) : '—'],
            ['modos', modes],
            ['perfis geográficos', geoProfiles],
            ['regras', classification?.rulesSource ?? '—'],
        ]));

        items.push(addHealthItem('Pipeline', [
            ['lotes', pipeline ? formatNumber(pipeline.batches) : '—'],
            ['eventos gravados', pipeline ? formatNumber(pipeline.writtenEvents) : '—'],
            ['falhas de escrita', pipeline ? formatNumber(pipeline.writeFailures) : '—'],
            ['eventos descartados', pipeline ? formatNumber(pipeline.failedEvents) : '—'],
            ['circuito aberto', pipeline ? (pipeline.circuitOpen ? 'sim' : 'não') : '—'],
            ['última escrita', pipeline?.lastWriteAt ? formatTime(pipeline.lastWriteAt) : '—'],
        ]));

        const reasons = collector?.invalidByReason && typeof collector.invalidByReason === 'object'
            ? Object.entries(collector.invalidByReason)
                .filter(([, count]) => Number(count) > 0)
                .map(([reason, count]) => `${reason}: ${formatNumber(count)}`)
            : [];
        items.push(addHealthItem('Inválidos por motivo', reasons.length > 0
            ? reasons.map((reason) => ['motivo', reason])
            : [['motivo', collector ? 'nenhum' : '—']]));

        els.healthGrid.replaceChildren(...items);
    }

    function renderHealthMeta(health) {
        if (!health) {
            els.appVersion.textContent = 'versão —';
            return;
        }

        els.appVersion.textContent = `v${health.version ?? '—'} · uptime ${formatUptime(health.uptimeSeconds)}`;
    }

    function formatUptime(seconds) {
        if (seconds === undefined || seconds === null || seconds === '' || !Number.isFinite(Number(seconds))) {
            return '—';
        }

        const total = Math.max(0, Math.floor(Number(seconds)));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }

    async function loadStats() {
        if (state.loadingStats) {
            return;
        }
        state.loadingStats = true;

        const summaryUrl = state.filters.site
            ? `/api/summary?site=${encodeURIComponent(state.filters.site)}`
            : '/api/summary';

        const results = await Promise.allSettled([
            fetchJson('/api/health'),
            fetchJson('/api/stats'),
            fetchJson(summaryUrl),
        ]);

        const health = results[0].status === 'fulfilled' ? results[0].value : null;
        const stats = results[1].status === 'fulfilled' ? results[1].value : null;
        const summary = results[2].status === 'fulfilled' ? results[2].value : null;

        renderHealthMeta(health);
        renderStats(stats);
        renderSummary(summary);

        if (results.every((result) => result.status === 'rejected')) {
            showError('Não foi possível carregar os indicadores.');
        }

        state.loadingStats = false;
    }

    async function loadEvents({ append = false } = {}) {
        if (state.loadingEvents) {
            return;
        }
        state.loadingEvents = true;
        els.loadStatus.textContent = 'Carregando...';
        els.applyFilters.disabled = true;
        els.refreshNow.disabled = true;
        els.loadMore.disabled = true;

        try {
            const cursor = append ? state.cursor : null;
            const data = await fetchJson(`/api/events/recent?${buildQuery({ cursor })}`);
            const events = Array.isArray(data?.events) ? data.events : [];

            state.events = append ? state.events.concat(events) : events;
            state.cursor = data?.page?.nextCursor ?? null;
            state.hasMore = Boolean(data?.page?.hasMore);
            state.lastUpdated = new Date();

            renderEvents();
            els.lastUpdate.textContent = `última atualização ${timeFormatter.format(state.lastUpdated)}`;
            els.loadStatus.textContent = '';
            clearError();
        } catch (error) {
            showError(`Falha ao carregar eventos: ${error.message}`);
        } finally {
            state.loadingEvents = false;
            els.applyFilters.disabled = false;
            els.refreshNow.disabled = false;
            els.loadMore.disabled = false;
            if (els.loadStatus.textContent === 'Carregando...') {
                els.loadStatus.textContent = '';
            }
        }
    }

    async function refreshAll() {
        await Promise.allSettled([loadStats(), loadEvents({ append: false })]);
    }

    els.filters.addEventListener('submit', (event) => {
        event.preventDefault();
        try {
            state.filters = readFilters();
            state.events = [];
            state.cursor = null;
            state.hasMore = false;
            renderEvents();
            clearError();
            void refreshAll();
        } catch (error) {
            showError(error.message);
        }
    });

    els.clearFilters.addEventListener('click', () => {
        els.filterSite.value = '';
        els.filterIp.value = '';
        els.filterStatus.value = '';
        els.filterLimit.value = '50';
        state.filters = { site: '', ip: '', status: '', limit: 50 };
        state.events = [];
        state.cursor = null;
        state.hasMore = false;
        renderEvents();
        clearError();
        void refreshAll();
    });

    els.loadMore.addEventListener('click', () => {
        if (state.hasMore && state.cursor) {
            void loadEvents({ append: true });
        }
    });

    els.refreshNow.addEventListener('click', () => {
        state.events = [];
        state.cursor = null;
        state.hasMore = false;
        renderEvents();
        void refreshAll();
    });

    els.autoRefresh.addEventListener('change', () => {
        state.autoRefresh = els.autoRefresh.checked;
    });

    setInterval(() => {
        if (!state.autoRefresh || document.hidden) {
            return;
        }

        void loadStats();
        if (state.cursor === null) {
            void loadEvents({ append: false });
        }
    }, REFRESH_INTERVAL_MS);

    void refreshAll();
})();
