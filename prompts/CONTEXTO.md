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
│   └── CONTEXTO.md
├── src/
│   ├── app.js
│   ├── server.js
│   ├── config/
│   ├── collector/
│   ├── routes/
│   ├── panel/
│   ├── storage/
│   └── utils/
├── scripts/
│   └── send-test-event.js
├── test/
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
└── .kilo/
```

Estrutura futura: `config/` (configuração persistente), `data/geolite2/` (bancos MaxMind) e `panel/` (Vue/Quasar).

## 4. Arquitetura e decisões

Fluxo: Internet → firewall/Fail2Ban → Nginx → PHP-FPM e logs; Nginx envia Syslog UDP para `127.0.0.1:5514` → coletor Node.js → Redis → motor de classificação → painel e evento de bloqueio → Fail2Ban → iptables.

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

## 6. Estado atual (05/11/2026)

- Fase 1 concluída: documentação, inspeção MaxMind e `.gitignore` criados.
- Fase 2 concluída: backend Fastify, configuração de ambiente, coletor Syslog UDP, parser/validação, rotas de saúde e testes.
- Fase 3 concluída: cliente Redis resiliente, fila limitada, agregação em lote, janelas/TTL, rankings, stream de eventos, reputação e consultas agregadas. Suíte com 51 testes aprovados.
- Fase 4 (piloto) ativa: `log_format security_json`, map de caminho sem query, snippet PHP e integração do vhost `casadoppia.site`. Validado em Nginx temporário e depois no Nginx real; 3 eventos gravados no DB 7. Soak de 24h pendente.
- Fase 4A concluída: painel provisório em `/panel`, somente leitura e loopback, com filtros, paginação cursorizada do stream, indicadores de saúde e polling de 10s. Validado em Chrome headless e contra o Redis real; 60 testes automatizados aprovados. Não aprova a Fase 5.
- Componentes implementados:
  - `src/server.js`: bootstrap, inicialização do coletor/Redis/pipeline e encerramento gracioso.
  - `src/app.js`: Fastify, logger com redaction, IDs de requisição, erros e 404.
  - `src/config/`: carregamento de `.env` e validação de configuração.
  - `src/collector/`: coletor UDP, parser syslog, parser/validação do evento.
  - `src/storage/`: cliente Redis, fila, plano de agregação, aggregator, consultas e chaves.
  - `src/routes/health.js`: `/api/health`, `/api/ready`, `/api/stats`, `/api/summary`.
  - `src/routes/panel.js`: `/panel` e `/api/events/recent`.
  - `src/panel/`: HTML/CSS/JS do painel provisório 4A.
  - `src/utils/ip.js`: validação e classificação de escopo de IP.
  - `scripts/send-test-event.js`: simulação de evento.
  - `nginx/00-node-fw-log.conf`: `map` e `log_format` no contexto `http`.
  - `nginx/node-fw-php-log.conf`: snippet Syslog para locations PHP.
  - `docs/NGINX.md`: instruções de vhost, configuração central, validação, rollback e troubleshooting.
  - `docs/PAINEL-OBSERVACAO.md`: uso, campos, limites e procedimento do soak.
- Ainda não implementados: MaxMind, classificação/score, painel administrativo completo (Fase 7), Fail2Ban e systemd.
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
  - Banco existente: `/home/edson/node-anti-span/geolite-data/GeoLite2-Country.mmdb`.
  - Apenas Country; ASN e City ausentes.
  - Variáveis identificadas: `GEOIP_DB_PATH`, `MAXMIND_EDITION_ID`, `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY`, `MAXMIND_REFRESH_MAX_AGE_DAYS`.
  - Nenhum valor secreto copiado ou documentado.
  - Nenhum banco copiado.

## 7. Próxima etapa

Concluir a **Fase 4 — soak e expansão**:

1. Manter o Node FW em execução em tmux/screen e o piloto `casadoppia.site` por 24 horas.
2. Acompanhar o painel em `http://127.0.0.1:8088/panel`, `/api/stats`, `/api/summary`, stream `events`, invalid, fila e Redis.
3. Comparar contagens do log tradicional com os eventos aceitos.
4. Remover o log tradicional temporário do piloto se não for desejado; manter o Syslog.
5. Registrar os resultados do soak e só então avaliar a Fase 5.
6. Expandir para outros sites um por vez, conforme `docs/NGINX.md`.

Não avançar para MaxMind, classificação ou Fail2Ban antes de concluir o soak e a validação do piloto. O painel 4A não aprova a Fase 5 por si só. O jail `nginx-wishlist` e o Fail2Ban continuam intocados.

## 8. Documentos de referência

- `docs/IMPLEMENTACAO.md`: fases, checklists, critérios, riscos e status.
- `docs/ARQUITETURA.md`: componentes, fluxo, Redis, Nginx, classificação, Fail2Ban e segurança.
- `docs/MAXMIND.md`: inspeção, cópia segura, atualização independente e pendências.
- `docs/NGINX.md`: configuração central, vhosts, validação, rollback e troubleshooting.
- `docs/PAINEL-OBSERVACAO.md`: painel 4A, filtros, paginação, limites e procedimento do soak.
