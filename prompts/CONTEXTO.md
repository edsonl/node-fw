# Node FW — Contexto Permanente

Este arquivo resume o projeto para sessões futuras. Ler os documentos completos em `docs/` antes de implementar qualquer fase.

## 1. Objetivo

Central de monitoramento e classificação de acessos HTTP/HTTPS do Nginx, com suporte a vários sites (Magento, Laravel, WordPress e PHP convencional). Deve identificar domínio, IP, país, ASN, método, rota, User-Agent, status e tempos; detectar padrões automatizados e possíveis ataques; reconhecer bots legítimos; manter suspeitos; oferecer painel administrativo; e integrar decisões de bloqueio ao Fail2Ban.

O sistema deve ser leve, incremental e não pode criar dependência do Node.js para o funcionamento dos sites.

## 2. Stack prevista

- Backend: Node.js LTS, Fastify 5, Redis (cliente `redis` 6.3.1), coletor UDP nativo; WebSocket previsto.
- Frontend: Vue 3 + Quasar.
- Geo: MaxMind GeoLite2 Country + ASN, bancos locais `.mmdb`.
- Segurança: Fail2Ban, iptables, systemd, autenticação administrativa, auditoria.
- Testes: `node:test` no backend (implementado); Vitest previsto para o frontend.

## 3. Diretórios

```text
/home/edson/www/node-fw/
├── docs/
│   ├── IMPLEMENTACAO.md
│   ├── ARQUITETURA.md
│   ├── MAXMIND.md
│   ├── NGINX.md
│   └── PAINEL-OBSERVACAO.md
├── nginx/
│   ├── 00-node-fw-log.conf
│   └── node-fw-php-log.conf
├── backups/                 # backups locais de vhosts (fora do Git)
├── prompts/
│   ├── CONTEXTO.md
│   ├── CLASSIFICACAO-GEOGRAFICA-FASE6.md
│   └── VALIDACAO-LOGS-ETAPA-FINAL.md
├── config/
│   └── classification.example.json
├── src/
│   ├── app.js
│   ├── server.js
│   ├── config/
│   ├── collector/
│   ├── classification/
│   ├── enrichment/
│   ├── routes/
│   ├── panel/
│   ├── storage/
│   └── utils/
├── scripts/
│   ├── send-test-event.js
│   └── update-maxmind.js
├── test/
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
└── .kilo/
```

Estrutura atual: `src/enrichment/` (MaxMind), `src/classification/` (regras/score/bots), `config/classification.example.json`, `data/geolite2/` (bancos locais ignorados pelo Git) e `scripts/update-maxmind.js`. Estrutura futura: `panel/` (Vue/Quasar) e persistência/administração de regras da Fase 7.

Produção: a raiz real do projeto é `/home/web/node-fw/`; ela **não foi acessada nesta tarefa**. Nenhuma implantação ou ativação foi feita.

## 4. Arquitetura e decisões

Fluxo: Internet → firewall/Fail2Ban → Nginx → PHP-FPM e logs; Nginx envia Syslog UDP para `127.0.0.1:5514` → coletor Node.js → enriquecimento MaxMind → classificação local → fila/Redis → painel. A elegibilidade de bloqueio é apenas calculada; nenhum evento é enviado ao Fail2Ban nesta fase.

Decisões já tomadas:

- Coleta principal por Syslog UDP nativo do Nginx; `auth_request` não será usado como mecanismo principal.
- Access logs tradicionais do Nginx são preservados.
- O Node.js não bloqueia diretamente; apenas o Fail2Ban aplica bloqueios.
- O Node FW não depende de resposta HTTP do Node para atender os sites.
- País é componente de score; nunca motivo isolado de bloqueio.
- Country + ASN são necessários; City é opcional.
- Redis é temporário; configuração persistente fica em arquivos JSON versionados.
- Modo inicial: somente monitoramento (modo 1). Modos 2 e 3 existirão, mas não serão ativados sem calibração.
- Jail Fail2Ban separado (`nginx-security-monitor`); o jail `nginx-wishlist` não será alterado.
- Não registrar query string, cookies, `Authorization`, corpo ou tokens.
- Log de segurança será enviado apenas em locations PHP/dinâmicas.
- O evento do Fail2Ban terá linha fixa e validada, sem texto livre.
- Nenhum código, módulo ou link do projeto `node-anti-span` será reutilizado.

## 5. Restrições obrigatórias

- Não modificar `/home/edson/node-anti-span/` nem qualquer configuração de produção sem necessidade e autorização.
- Não alterar Nginx, Fail2Ban ou iptables sem uma fase específica e autorização.
- Não copiar credenciais MaxMind nesta fase; nenhuma credencial deve aparecer em logs, respostas, docs ou Git.
- Não versionar `.env`, bancos `.mmdb`, manifestos locais ou logs.
- Não criar links simbólicos para bancos do projeto antigo.
- Não introduzir dependência do Node FW no caminho de atendimento dos sites.
- Trabalhar uma fase por vez, atualizando `docs/IMPLEMENTACAO.md`.
- Não expor Redis ou painel diretamente à internet.
- Não confiar em `X-Forwarded-For` de origem não confiável.

## 6. Estado atual (11/11/2026)

- Fase 1 concluída: documentação, inspeção MaxMind e `.gitignore` criados.
- Fase 2 concluída: backend Fastify, configuração de ambiente, coletor Syslog UDP, parser/validação, rotas de saúde e testes.
- Fase 3 concluída: cliente Redis resiliente, fila limitada, agregação em lote, janelas/TTL, rankings, stream de eventos, reputação e consultas agregadas. Suíte com 51 testes aprovados.
- Fase 4 (piloto) ativa: `log_format security_json`, map de caminho sem query, snippet PHP e integração do vhost `casadoppia.site`. Validado em Nginx temporário e depois no Nginx real; 3 eventos gravados no DB 7. Soak de 24h pendente.
- Fase 4A concluída: painel provisório em `/panel`, somente leitura e loopback, com filtros, paginação cursorizada do stream, indicadores de saúde e polling de 10s. Validado em Chrome headless e contra o Redis real. Não aprova a Fase 5.
- Fase 5 implementada em desenvolvimento: MaxMind Country/ASN com readers locais, cache/TTL, modo degradado, updater independente com lock/tar/MMDB/SHA-256/swap/.previous e painel com país/ASN. Nenhum banco ou credencial real foi usado; implantação não realizada.
- Fase 6 implementada em desenvolvimento: regras globais/por site, score/níveis, tracker de janelas, bot verifier DNS, exceções, decay, modo 1/2/3, persistência de score/suspeitos no Redis e score no painel. Perfis geográficos `relaxed` (BR/US, 1.5x), `standard` (Europa, 1.0x) e `strict` (Ásia, Rússia e Liga Árabe, 0.5x), com precedência `strict > standard > relaxed`, fallback `standard` para país desconhecido e fator aplicado aos limites por site/janela; `criticalPathPerMinute` não recebe fator. Sem calibração real, sem bloqueio e sem implantação. Suíte com 108 testes aprovados.
- Componentes implementados:
  - `src/server.js`: bootstrap, inicialização do coletor/Redis/pipeline e encerramento gracioso.
  - `src/app.js`: Fastify, logger com redaction, IDs de requisição, erros e 404.
  - `src/config/`: carregamento de `.env` e validação de configuração.
  - `src/collector/`: coletor UDP, parser syslog, parser/validação do evento.
  - `src/storage/`: cliente Redis, fila, plano de agregação, aggregator, consultas e chaves.
  - `src/enrichment/`: readers MaxMind Country/ASN, cache, modo degradado e updater independente.
  - `src/classification/`: regras, perfis geográficos, tracker de janelas, bot verifier, score, exceções e modos.
  - `config/classification.example.json`: exemplo de configuração global, perfis geográficos e por site.
  - `src/routes/health.js`: `/api/health`, `/api/ready`, `/api/stats`, `/api/summary`.
  - `src/routes/panel.js`: `/panel` e `/api/events/recent`.
  - `src/panel/`: HTML/CSS/JS do painel provisório 4A, com país/ASN, score/nível e saúde da classificação.
  - `src/utils/ip.js`: validação e classificação de escopo de IP.
  - `scripts/send-test-event.js`: simulação de evento.
  - `scripts/update-maxmind.js`: atualização independente; não roda no startup.
  - `nginx/00-node-fw-log.conf`: `map` e `log_format` no contexto `http`.
  - `nginx/node-fw-php-log.conf`: snippet Syslog para locations PHP.
  - `docs/NGINX.md`: instruções de vhost, configuração central, validação, rollback e troubleshooting.
  - `docs/PAINEL-OBSERVACAO.md`: uso, campos, limites e procedimento do soak.
- Ainda não implementados: painel administrativo completo (Fase 7), Fail2Ban e systemd. MaxMind e classificação estão implementados em dev, mas sem bancos/credenciais reais, calibração e implantação; nenhum bloqueio é executado.
- Endpoints locais: API `127.0.0.1:8088`, UDP `127.0.0.1:5514`, tag `nodefw`.
- Redis: DB `7`, prefixo `nodfw:v1:`, janelas 1s/1m/5m/15m, stream `events` com 50.000 entradas. O DB 7 contém eventos de teste do piloto; testes isolados usaram DB 15.
- Nginx: `/etc/nginx/nginx.conf` inclui diretamente `/home/edson/www/node-fw/nginx/00-node-fw-log.conf` antes de `sites-enabled`; a cópia antiga em `/home/edson/www/nginx/` foi removida. Piloto `/home/edson/www/nginx/casadoppia.conf` com log tradicional temporário + Syslog; backup em `backups/`. Reload de produção realizado em 05/11/2026 e testado com requisições reais.
- Painel: `http://127.0.0.1:8088/panel`, somente leitura e loopback. Para o soak de 24h, executar em tmux/screen; systemd fica para a Fase 9.
- Inspeção do ambiente:
  - Node.js `v24.12.0`, npm `10.5.2`.
  - Nginx `1.18.0`, com include de `/home/edson/www/nginx/*.conf`.
  - Redis `6.0.16`.
  - systemd ativo.
  - Fail2Ban não encontrado neste ambiente (`/etc/fail2ban` ausente, `fail2ban-client` indisponível). Confirmar no servidor de produção antes da Fase 8.
  - Vários sites possuem `access_log off;` e configurações Magento com reescritas/`@handler`.
- MaxMind:
  - Banco existente no projeto antigo: `/home/edson/node-anti-span/geolite-data/GeoLite2-Country.mmdb`.
  - Apenas Country; ASN e City ausentes no projeto antigo.
  - Implementação: `GeoLite2-Country.mmdb` e `GeoLite2-ASN.mmdb` em `MAXMIND_DB_DIR` (`data/geolite2/` na raiz do projeto tanto em desenvolvimento quanto em produção; produção `/home/web/node-fw/data/geolite2/`).
  - Variáveis: `MAXMIND_ENABLED`, `MAXMIND_DB_DIR`, `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY`, `MAXMIND_REFRESH_MAX_AGE_DAYS`, `MAXMIND_DOWNLOAD_TIMEOUT_MS`, `MAXMIND_DOWNLOAD_RETRIES`, `MAXMIND_RETRY_BACKOFF_MS`, `MAXMIND_CACHE_MAX_ENTRIES`, `MAXMIND_CACHE_TTL_MS`, `MAXMIND_LOCK_STALE_MS`.
  - Updater: `npm run maxmind:update` (não roda no startup). Lock, tar/MMDB validados, SHA-256, swap atômico, `.previous`, manifesto sem segredos.
  - Country e ASN reais baixados e validados em desenvolvimento em 11/11/2026; produção ainda não implantada. Valores secretos não devem ser documentados.
  - Serviço inicia degradado sem os bancos; país/ASN nulos.

## 7. Próxima etapa

Concluir o **soak da Fase 4** e calibrar as Fases 5/6 em desenvolvimento:

1. Manter o Node FW em execução em tmux/screen e o piloto `casadoppia.site` por 24 horas.
2. Acompanhar o painel em `http://127.0.0.1:8088/panel`, `/api/stats`, `/api/summary`, stream `events`, invalid, fila, Redis, score e níveis.
3. Comparar contagens do log tradicional com os eventos aceitos.
4. Registrar os resultados do soak em `docs/SOAK-24H-PENDENTE.md`.
5. Calibrar pesos, limites e fatores geográficos (`relaxed`/`standard`/`strict`) da classificação com dados reais em modo monitoramento.
6. Em tarefa operacional separada, obter/copiar os bancos MaxMind reais, criar `.env` e ativar após a revisão.
7. Não executar bloqueios nem iniciar a Fase 8 antes da revisão do soak e da decisão de produção.

MaxMind e classificação estão implementados em dev; a classificação inclui perfis geográficos, sem calibração real ou implantação. O jail `nginx-wishlist` e o Fail2Ban continuam intocados.

## 8. Documentos de referência

- `docs/IMPLEMENTACAO.md`: fases, checklists, critérios, riscos e status.
- `docs/ARQUITETURA.md`: componentes, fluxo, Redis, Nginx, classificação, Fail2Ban e segurança.
- `docs/MAXMIND.md`: inspeção, cópia segura, atualização independente e pendências.
- `docs/NGINX.md`: configuração central, vhosts, validação, rollback e troubleshooting.
- `docs/PAINEL-OBSERVACAO.md`: painel 4A, filtros, paginação, score, limites e procedimento do soak.
- `docs/SOAK-24H-PENDENTE.md`: baseline, janela e comandos de reconciliação do soak.
- `prompts/VALIDACAO-LOGS-ETAPA-FINAL.md`: prompt para implementar diagnóstico de cobertura entre log PHP dedicado e eventos Node FW por site/período, sem depender da retenção do stream.
- `prompts/CLASSIFICACAO-GEOGRAFICA-FASE6.md`: prompt para estender a Fase 6 com perfis geográficos configuráveis em modo de observação; edição pelo painel fica para a Fase 7.
- `config/classification.example.json`: exemplo de regras globais e por site da Fase 6.
