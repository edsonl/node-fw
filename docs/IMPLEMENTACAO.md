# Node FW — Plano de Implementação

| Campo | Valor |
|---|---|
| Projeto | Node FW |
| Diretório | `/home/edson/www/node-fw/` |
| Documento | Plano de implementação e checklist |
| Versão | 0.5.0 |
| Data | 06/11/2026 |
| Status | Fases 1 a 3 concluídas; piloto da Fase 4 validado; painel provisório 4A concluído; soak de 24h pendente |
| Responsável | Equipe Node FW |

## 1. Objetivo

Construir uma central de monitoramento e classificação de acessos HTTP/HTTPS recebidos pelo Nginx, capaz de acompanhar vários sites hospedados no mesmo servidor (Magento, Laravel, WordPress e PHP convencional), identificar comportamento automatizado e suspeito, apoiar a investigação pelo painel e encaminhar decisões de bloqueio ao Fail2Ban.

O Node FW deve ser leve e desacoplado: a indisponibilidade do Node.js, do Redis ou do painel não pode impedir o funcionamento dos sites monitorados.

## 2. Escopo

### 2.1 Incluído

- Coleta de eventos do Nginx via Syslog UDP em `127.0.0.1:5514`.
- Preservação dos access logs tradicionais do Nginx.
- Identificação de domínio, IP, país, ASN, método, caminho, User-Agent, status HTTP e tempos de resposta.
- Contadores e janelas temporais em Redis.
- Enriquecimento com MaxMind GeoLite2 (Country e ASN).
- Motor de classificação configurável por site.
- Painel administrativo em Vue 3 + Quasar.
- Integração com um jail Fail2Ban independente.
- Operação inicial somente em modo monitoramento.
- Documentação e roteiro incremental por fases.

### 2.2 Fora do escopo desta etapa

- Implementar backend, coletor, painel ou regras nesta execução.
- Alterar Nginx, Fail2Ban, iptables, Redis ou systemd.
- Copiar bancos ou credenciais MaxMind.
- Modificar o projeto `/home/edson/node-anti-span/`.
- Substituir WAF, ModSecurity, CrowdSec ou proteção de camada 7 existente.
- Bloqueio direto de visitantes pelo Node.js.

## 3. Inventário do ambiente

Inspeção somente leitura realizada em 05/11/2026.

| Item | Resultado observado |
|---|---|
| `/home/edson/www/node-fw/` | Existente; `docs/` e `prompts/` vazios; configuração em `.kilo/`; diretório ainda não é repositório Git |
| Node.js | `v24.12.0` |
| npm | `10.5.2` |
| Nginx | `1.18.0` (Ubuntu) |
| Redis | `6.0.16` |
| systemd | Ativo |
| Fail2Ban | Não encontrado neste ambiente: `/etc/fail2ban` ausente e `fail2ban-client` indisponível |
| Configuração Nginx | `/etc/nginx/nginx.conf` inclui `/home/edson/www/nginx/*.conf`; 9 arquivos de site encontrados |
| Padrões Nginx observados | Vários sites com `access_log off;` no nível do `server`; locations de estáticos também desligam log; configurações Magento com `try_files`, `@handler`, `fastcgi_pass` e, em pelo menos um site, socket PHP 5.6 |
| Logs tradicionais | `/var/log/nginx/access.log` e rotações presentes |
| Estado do projeto | Apenas documentação e `.gitignore`; nenhum código de aplicação |

> O ambiente atual pode ser de desenvolvimento/contêiner e não refletir integralmente o servidor de produção. A existência do jail `nginx-wishlist`, do Fail2Ban e das diretivas de rate limit deve ser confirmada no servidor real antes da Fase 8. Nada foi alterado.

## 4. Princípios de desenvolvimento

1. Incremental: uma fase por vez, com critérios de conclusão verificáveis.
2. Segurança primeiro: menor privilégio, validação de entrada, segredos fora do Git e auditoria.
3. Desacoplamento: o caminho crítico dos sites não depende do Node FW.
4. Observabilidade: medir perda de UDP, filas, erros e latência do coletor.
5. Simplicidade: evitar componentes e dependências sem necessidade comprovada.
6. Privacidade: não registrar cookies, credenciais, tokens ou query strings sensíveis.
7. Documentação: decisões relevantes registradas em `docs/ARQUITETURA.md` e neste plano.

## 5. Fases de implementação

### Fase 1 — Preparação do projeto

**Status: concluída em 05/11/2026.**

- [x] Inspecionar `/home/edson/www/node-fw/`.
- [x] Criar `docs/` e `prompts/`.
- [x] Criar `docs/IMPLEMENTACAO.md`.
- [x] Criar `docs/ARQUITETURA.md`.
- [x] Inspecionar somente para leitura o uso de MaxMind em `/home/edson/node-anti-span/`.
- [x] Criar `docs/MAXMIND.md` sem valores secretos.
- [x] Criar `prompts/CONTEXTO.md`.
- [x] Criar `.gitignore` com regras para `.env`, bancos e logs.
- [x] Documentar decisões arquiteturais iniciais.

**Critérios de conclusão:** documentação criada, inspeção registrada, nenhum serviço ou configuração de produção alterado, nenhuma credencial copiada.

### Fase 2 — Backend e coletor

**Status: concluída em 05/11/2026.**

- [x] Inicializar projeto Node.js 24.x com `package.json` privado, ESM e `engines` mínimo.
- [x] Instalar e configurar Fastify 5 com logger estruturado, redaction, IDs de requisição e tratamento central de erros.
- [x] Criar estrutura modular em `src/` (`config`, `collector`, `routes`, `utils`).
- [x] Implementar configuração de ambiente validada na inicialização.
- [x] Criar `.env.example` sem segredos e defaults seguros.
- [x] Criar coletor Syslog UDP vinculado exclusivamente a loopback (`127.0.0.1:5514` por padrão).
- [x] Implementar parser do envelope syslog e do JSON do Nginx.
- [x] Validar origem loopback, tamanho máximo, codificação, IP, domínio, método, rota, status e tempos.
- [x] Rejeitar e contabilizar eventos malformados sem derrubar o processo.
- [x] Criar logs de diagnóstico com throttle para eventos inválidos.
- [x] Criar testes unitários de parser, validação, configuração e IPs.
- [x] Criar teste de integração enviando datagramas UDP reais para o coletor.
- [x] Validar rajada de 100 datagramas em loopback.
- [x] Criar endpoints `/api/health`, `/api/ready` e `/api/stats`.
- [x] Criar script `scripts/send-test-event.js` para simulação.
- [x] Documentar execução local e simulação no Apêndice A.
- [x] Validar encerramento gracioso por `SIGTERM`.

**Entregue:** `package.json`, `package-lock.json`, `.env.example`, `src/`, `scripts/send-test-event.js` e `test/`. Na conclusão da Fase 2, a suíte tinha 34 testes aprovados. O coletor recebeu evento real via UDP, rejeitou tag inválida/JSON inválido/datagrama grande e liberou a porta no encerramento.

**Critérios de conclusão:** o coletor recebe eventos UDP válidos, rejeita inválidos, mantém-se estável sob rajada e não bloqueia o processo por falha de dependência. Testes automatizados passam.

### Fase 3 — Redis

**Status: concluída em 05/11/2026.**

- [x] Implementar conexão Redis com timeout de conexão, reconexão com backoff e circuit breaker fail-fast.
- [x] Definir prefixo exclusivo `nodfw:v1:` e DB dedicado 7 (configurável).
- [x] Implementar fila interna limitada (10.000 por padrão) com descarte do evento mais antigo.
- [x] Criar contadores globais, por site, por IP e por IP+site.
- [x] Implementar janelas de 1 segundo, 1, 5 e 15 minutos.
- [x] Implementar TTL em todas as chaves temporárias.
- [x] Implementar escrita em lote com `MULTI`/pipeline e expiração por chave.
- [x] Criar rankings de país e de IP por janela.
- [x] Criar contadores de status HTTP e de requisições dinâmicas.
- [x] Criar stream de eventos recentes com `MAXLEN ~` (50.000 por padrão).
- [x] Implementar cache de reputação por IP; score e nível serão calculados na Fase 6.
- [x] Implementar escrita em lote e backpressure com fila.
- [x] Implementar consultas agregadas e endpoint `/api/summary`.
- [x] Testar rajada de 200 eventos e escrita em um único lote.
- [x] Testar indisponibilidade do Redis, abertura do circuito e recuperação automática.
- [x] Medir consumo de memória durante o teste de carga (Redis em aproximadamente 13,8 MB totais no ambiente de teste); alertas formais ficam para a Fase 9.

**Entregue:** `src/storage/redis-client.js`, `keys.js`, `aggregation-plan.js`, `aggregator.js`, `event-queue.js`, `queries.js`, `errors.js`, extensão das rotas de saúde e 51 testes aprovados. A integração real usou DB 15 e prefixo isolado; o DB 7 não foi alterado. Com Redis indisponível, `/api/ready` retorna 503, o coletor continua recebendo e a fila retém eventos; após o Redis voltar, o pipeline retoma automaticamente.

**Critérios de conclusão:** agregações corretas em testes de janela, TTL funcionando, memória limitada, nenhuma perda de estabilidade do coletor quando o Redis cai.

### Fase 4 — Integração Nginx

**Status: piloto ativo e validado no Nginx de produção; soak de 24h pendente.**

- [x] Validar a versão e os módulos do Nginx de produção (Nginx 1.18.0; Syslog é nativo).
- [x] Definir `log_format security_json` com `escape=json` no contexto `http`.
- [x] Definir `map` para caminho original sem query string.
- [x] Definir marcação de requisição dinâmica/PHP com `$upstream_addr`.
- [x] Criar snippet reutilizável para locations PHP.
- [x] Preservar access logs tradicionais; o piloto mantém log combinado na location PHP.
- [x] Configurar Syslog UDP em um único site piloto (`casadoppia.site`).
- [x] Confirmar que `access_log off` no `server` não impede o log da location PHP.
- [x] Validar herança/substituição de `access_log` em `server` e `location`.
- [x] Validar requisições Magento com reescrita interna e `@handler`.
- [x] Validar que estáticos não geram volume de eventos.
- [x] Comparar amostra de contagens com o log tradicional (3 requisições, 3 eventos).
- [x] Medir perda de UDP na amostra (0 perdas; soak contínuo pendente).
- [x] Criar `docs/NGINX.md` com instruções de vhost e configuração central.
- [x] Testar o fluxo completo em Nginx temporário em `127.0.0.1:18080`.
- [x] Recarregar o Nginx de produção com a configuração validada (reload aceito em 05/11/2026).
- [x] Remover a cópia duplicada do arquivo central em `/home/edson/www/nginx/`.
- [x] Testar o `casadoppia.site` real ponta a ponta: 3 requisições, 3 eventos, 0 inválidos.
- [ ] Validar Laravel/WordPress em um site real (pendente; receita documentada).
- [ ] Validar IP real atrás de proxy/CDN (não aplicável ao piloto; documentado).
- [ ] Executar `sudo nginx -t` explicitamente antes do próximo reload.
- [ ] Manter o piloto por 24 horas e comparar contagens contínuas.
- [ ] Expandir para os demais sites de forma controlada.

**Entregue:** `nginx/00-node-fw-log.conf`, `nginx/node-fw-php-log.conf`, include do arquivo do projeto no `/etc/nginx/nginx.conf` (antes de `sites-enabled`), alteração no vhost `casadoppia.conf`, backup em `backups/` e `docs/NGINX.md`. A cópia antiga em `/home/edson/www/nginx/00-node-fw-log.conf` foi removida para evitar duplicidade. O fluxo foi validado em Nginx 1.18.0 temporário e depois no Nginx real: PHP-FPM 5.6, `path` sem query, `final_uri` `/index.php`, `dynamic=1`, status 200 e 3 eventos gravados no DB 7.

**Critérios de conclusão:** site piloto envia eventos corretos por pelo menos 24 horas, logs tradicionais intactos, contagens compatíveis com amostra e nenhum impacto perceptível no tempo de resposta.

### Fase 4A — Painel provisório de observação

**Status: implementação concluída em 06/11/2026; uso durante o soak e registro final ainda pendentes.** Este incremento permite observar acessos do site piloto durante o soak da Fase 4. É um painel operacional mínimo, somente de leitura, e não antecipa as funções administrativas completas da Fase 7.

- [x] Exibir lista paginada de eventos recentes recebidos pelo coletor, com atualização periódica e indicação clara do horário da última atualização.
- [x] Exibir campos úteis para investigação: horário, site, IP, método, caminho sem query string, status HTTP, duração, indicação de requisição dinâmica e User-Agent truncado.
- [x] Permitir filtro por site, IP e status HTTP; validar limites e valores no servidor.
- [x] Exibir resumo e saúde já disponíveis: volume por janela, respostas por status, eventos inválidos por motivo, fila e estado do Redis.
- [x] Reutilizar o Redis/stream existente; criar consulta limitada e cursor estável para eventos recentes, sem varrer chaves ou carregar todo o histórico.
- [x] Manter API e painel restritos a loopback durante esta etapa; não expor porta ou UI à Internet nem criar ações de bloqueio/configuração.
- [x] Preservar privacidade: nunca mostrar query string, cookies, authorization ou corpo; limitar/truncar User-Agent e demais campos.
- [x] Registrar como iniciar/parar o painel, campos exibidos e limitações em `docs/PAINEL-OBSERVACAO.md`.
- [x] Validar paginação, filtros e stream real no Redis DB 7.
- [x] Validar a renderização da UI em Chrome headless.
- [ ] Usar o painel durante o soak de 24 horas e registrar contagens, erros e observações antes de aprovar o início da Fase 5.

**Entregue:** UI responsiva em `src/panel/`, rotas `/panel` e `/api/events/recent`, consulta cursorizada em `src/storage/queries.js`, testes de paginação/filtros e guia em `docs/PAINEL-OBSERVACAO.md`. A suíte total tem 60 testes aprovados. A UI e os assets usam CSP restritiva, `Cache-Control: no-store` e bind de API em loopback. A consulta do stream lê no máximo 1.000 entradas por chamada, não usa `KEYS` e trunca User-Agent em 160 caracteres.

**Critérios de conclusão:** eventos recentes e indicadores são visíveis sem acesso direto ao Redis; consulta permanece limitada; UI/API ficam somente locais e somente leitura; observação do piloto e decisão de passagem à Fase 5 ficam registradas.

**Limites explícitos:** sem MaxMind (país/ASN), classificação/score, autenticação administrativa, gestão de regras, WebSocket, bloqueio, nem substituição do painel completo da Fase 7. A conclusão do painel não aprova a Fase 5.

### Fase 5 — MaxMind

**Pré-requisito:** concluir o painel provisório de observação da Fase 4A e usá-lo durante o soak do piloto. A implementação de MaxMind só começa após a revisão dos dados observados e a conclusão dos critérios da Fase 4.

- [ ] Confirmar no servidor de produção as edições e credenciais disponíveis.
- [ ] Copiar de forma independente o banco Country existente.
- [ ] Baixar ou copiar o banco ASN necessário.
- [ ] Criar diretório próprio com permissões restritas.
- [ ] Criar `.env` independente com permissões `0600`.
- [ ] Implementar leitor local de Country e ASN.
- [ ] Implementar cache de consultas por IP.
- [ ] Implementar atualização independente com validação, lock e troca atômica.
- [ ] Implementar retenção de versão anterior para rollback.
- [ ] Registrar metadados de atualização sem expor credenciais.
- [ ] Testar precisão, IPv4, IPv6, IP privado e IP inválido.
- [ ] Testar falha de download e banco corrompido.
- [ ] Documentar atribuição/licença MaxMind no painel.

**Critérios de conclusão:** consultas locais funcionam sem rede, atualização não interrompe o serviço, erros não derrubam o coletor e nenhuma credencial aparece em logs.

### Fase 6 — Classificação

- [ ] Definir modelo de dados de regras globais e por site.
- [ ] Implementar pontuação e níveis Normal/Observação/Suspeito/Crítico.
- [ ] Implementar limites de taxa por IP, site e rota crítica.
- [ ] Implementar análise de país e ASN como componentes de score.
- [ ] Implementar verificação de Googlebot/Bingbot por DNS reverso, DNS direto e faixas publicadas.
- [ ] Implementar detecção de padrões: varredura de rotas, excesso de 404/403, métodos e User-Agent suspeitos.
- [ ] Implementar decaimento e reincidência.
- [ ] Implementar listas de exceção por IP/CIDR, ASN, bot verificado e rota.
- [ ] Implementar configuração por site e modo de operação.
- [ ] Implementar modo de simulação (avalia e registra, não bloqueia).
- [ ] Criar testes com cenários de ataque e falsos positivos.
- [ ] Revisar limites iniciais com dados reais em modo monitoramento.

**Critérios de conclusão:** decisões explicáveis e auditáveis, país nunca é motivo isolado de bloqueio, bots legítimos não são penalizados indevidamente e modo simulação é o padrão.

### Fase 7 — Painel

O painel desta fase é o produto administrativo completo. Ele não é substituído pelo painel provisório, somente de leitura, previsto na Fase 4A.

- [ ] Criar aplicação Vue 3 + Quasar.
- [ ] Implementar autenticação administrativa com sessão segura.
- [ ] Implementar proteção CSRF e rate limit de login.
- [ ] Criar dashboard com métricas em tempo quase real.
- [ ] Criar monitoramento com filtros por domínio, IP, país e status.
- [ ] Criar detalhe por IP com ASN, histórico, pontuação e motivos.
- [ ] Criar lista de suspeitos e evolução da pontuação.
- [ ] Criar cadastro de sites monitorados.
- [ ] Criar gestão de regras globais e por domínio.
- [ ] Criar gestão de exceções.
- [ ] Criar acompanhamento de bloqueios e histórico de decisões.
- [ ] Criar configurações de retenção.
- [ ] Implementar WebSocket com reconexão e limites de taxa.
- [ ] Testar usabilidade e responsividade.

**Critérios de conclusão:** painel acessível apenas por administradores autenticados, dados em tempo real sem sobrecarregar Redis, ações auditadas e interface responsiva.

### Fase 8 — Fail2Ban

- [ ] Definir formato de linha de evento seguro e imutável.
- [ ] Criar filtro Fail2Ban ancorado e restritivo.
- [ ] Criar jail independente `nginx-security-monitor`.
- [ ] Não alterar o jail `nginx-wishlist`.
- [ ] Criar arquivo de eventos com diretório e permissões adequadas.
- [ ] Implementar somente emissão de eventos em modo de bloqueio.
- [ ] Implementar idempotência e cooldown por IP.
- [ ] Implementar primeiro banimento de 24 horas.
- [ ] Implementar reincidência de 30 dias.
- [ ] Implementar consulta de status real do Fail2Ban.
- [ ] Implementar reconciliação entre painel e Fail2Ban.
- [ ] Implementar desbloqueio administrativo com privilégio mínimo.
- [ ] Testar injeção de linha, IP inválido e evento duplicado.
- [ ] Validar proteção contra falsos positivos.
- [ ] Documentar rollback e desativação segura.

**Critérios de conclusão:** banimento e desbanimento funcionam, painel reflete o estado real, logs não permitem injeção e o jail existente permanece intacto.

### Fase 9 — Produção

- [ ] Criar unidades systemd para API/coletor e jobs.
- [ ] Configurar usuário de serviço sem privilégios.
- [ ] Configurar inicialização automática e limites de recursos.
- [ ] Configurar logrotate para logs próprios.
- [ ] Proteger Redis com bind local, autenticação/ACL e firewall.
- [ ] Proteger o painel com TLS, autenticação e restrição de rede.
- [ ] Avaliar CPU, memória e I/O em produção.
- [ ] Configurar alertas de memória, profundidade de fila, perda de eventos e falhas do Redis.
- [ ] Realizar testes de carga e caos.
- [ ] Testar falha e reinício do Node.js.
- [ ] Testar indisponibilidade de Redis, MaxMind e Fail2Ban.
- [ ] Documentar backup, restauração e recuperação.
- [ ] Validar segurança geral e revisar permissões.
- [ ] Definir janela de manutenção e plano de rollback.
- [ ] Atualizar checklist final e encerrar a implantação.

**Critérios de conclusão:** serviço resiliente, monitorado, com limites claros, backup testado e nenhuma dependência do Node FW para o funcionamento dos sites.

## 6. Dependências

| Dependência | Necessária em | Observação |
|---|---|---|
| Node.js LTS | Fase 2 | Implementado e validado com `v24.12.0`; `engines` mínimo `>=20.12.0` |
| Fastify | Fase 2 | Implementado com Fastify 5.12.8 |
| Redis | Fase 3 | Implementado com Redis 6.0.16 e cliente `redis` 6.3.1; DB 7 e prefixo dedicados |
| Nginx com syslog | Fase 4 | Nginx 1.18.0 validado; piloto ativo, soak de 24h pendente |
| MaxMind GeoLite2 Country | Fase 5 | Banco existente no projeto antigo |
| MaxMind GeoLite2 ASN | Fase 5 | Não existe no projeto antigo; precisa ser obtido |
| Vue 3 + Quasar | Fase 7 | Build separado do backend |
| Fail2Ban | Fase 8 | Deve ser validado no servidor de produção |
| iptables | Fase 8 | Aplicado exclusivamente pelo Fail2Ban |
| systemd | Fase 9 | Serviços e limites |
| TLS/reverse proxy | Fase 9 | Painel não deve ficar exposto diretamente |

## 7. Status das tarefas

| Fase | Status | Conclusão |
|---|---|---|
| 1 — Preparação | Concluída | 05/11/2026 |
| 2 — Backend e coletor | Concluída | 05/11/2026 |
| 3 — Redis | Concluída | 05/11/2026 |
| 4 — Nginx | Em andamento (piloto ativo) | Soak de 24h e expansão pendentes |
| 4A — Painel provisório | Implementado | 06/11/2026; uso no soak pendente |
| 5 — MaxMind | Não iniciada | — |
| 6 — Classificação | Não iniciada | — |
| 7 — Painel | Não iniciada | — |
| 8 — Fail2Ban | Não iniciada | — |
| 9 — Produção | Não iniciada | — |

## 8. Riscos e mitigação

| Risco | Impacto | Mitigação |
|---|---|---|
| Perda de datagramas UDP | Métricas incompletas | Manter access logs, comparar amostras, métricas de perda e fila |
| Configuração de log duplicada ou ausente | Volume excessivo ou dados faltantes | Snippet único, validação por site e teste com `nginx -T` |
| `access_log off` em sites existentes | Perda de eventos | Configurar log no location PHP, não apenas no server |
| Reescritas internas do Magento | URL original perdida | Registrar caminho original sem query e URI final separada |
| Proxy/CDN mal configurado | IP falsificado | `set_real_ip_from` restrito a faixas confiáveis; nunca confiar em XFF arbitrário |
| Redis indisponível | Sem agregação | Fila limitada, descarte controlado e reconexão; site não depende disso |
| Banco MaxMind ausente/vencido | Menos contexto | Cache, modo degradado e atualização independente |
| Falso positivo de bloqueio | Bloqueio de cliente legítimo | Modo monitoramento, score mínimo, múltiplos sinais, exceções e auditoria |
| Injeção no log do Fail2Ban | Bloqueio indevido | Linha fixa, campos validados, sem texto livre e permissões restritas |
| Painel exposto | Comprometimento administrativo | TLS, autenticação forte, CSRF, rate limit e restrição de rede |
| Credenciais em logs | Vazamento | Redaction, não registrar URL de download e `.env` fora do Git |

## 9. Decisões registradas

| ID | Decisão |
|---|---|
| D001 | Coleta principal via Syslog UDP nativo do Nginx; não usar `auth_request` como mecanismo principal |
| D002 | Manter os access logs tradicionais do Nginx |
| D003 | O Node.js não aplica bloqueio diretamente; somente o Fail2Ban altera o firewall |
| D004 | País é componente de score, nunca motivo isolado de bloqueio |
| D005 | Banco Country + ASN são necessários; City é opcional |
| D006 | Redis é armazenamento temporário; configuração persistente fica em arquivos versionados, não no Redis |
| D007 | Operação inicial somente em modo monitoramento |
| D008 | Não registrar query string, cookies, authorization ou corpo de requisição |
| D009 | Jail Fail2Ban separado; o jail `nginx-wishlist` não será alterado |
| D010 | Nenhum código, módulo ou link do projeto `node-anti-span` será reutilizado |
| D011 | Escritas no Redis serão em lote, com fila limitada e descarte explícito |
| D012 | O painel será servido atrás de proxy com TLS e não ficará exposto diretamente |

## 10. Próximos passos

1. Manter o Node FW em execução e abrir o painel em `http://127.0.0.1:8088/panel`.
2. Acompanhar o piloto por 24 horas pelo painel e pelos indicadores operacionais.
3. Comparar contagens contínuas com o log tradicional do piloto e registrar os resultados.
4. Resolver as pendências de validação da Fase 4 antes de iniciar MaxMind.
5. Iniciar a Fase 5 após a conclusão documentada da Fase 4; o painel 4A não aprova a Fase 5 por si só.
6. Expandir para os demais sites um por vez, conforme `docs/NGINX.md`.

## Apêndice A — Execução local e simulação de eventos

Pré-requisitos: Node.js 20.12+ (validado com 24.12), npm e Redis acessível em `127.0.0.1:6379`.

```bash
cd /home/edson/www/node-fw
npm install
redis-cli ping
npm test
```

O arquivo `.env` é opcional para os defaults de desenvolvimento. Para personalizar:

```bash
cp .env.example .env
chmod 600 .env
```

Por padrão:

- API: `http://127.0.0.1:8088`
- Syslog UDP: `127.0.0.1:5514`
- Tag esperada: `nodefw`
- Redis: DB `7`, prefixo `nodfw:v1:`

Iniciar a API, o coletor e o pipeline Redis:

```bash
npm start
```

Em outro terminal, enviar um evento de teste:

```bash
npm run send:test-event
```

O script envia um evento com query string no caminho para validar que o coletor remove a query. Para inspecionar:

```bash
curl -s http://127.0.0.1:8088/api/health
curl -s http://127.0.0.1:8088/api/ready
curl -s http://127.0.0.1:8088/api/stats
curl -s http://127.0.0.1:8088/api/summary
curl -s 'http://127.0.0.1:8088/api/summary?site=www.example.com'
curl -s 'http://127.0.0.1:8088/api/events/recent?site=www.example.com&limit=25'
```

Painel provisório de observação:

```text
http://127.0.0.1:8088/panel
```

Guia completo em `docs/PAINEL-OBSERVACAO.md`.

Para ver cada evento aceito/rejeitado nos logs de diagnóstico, use `LOG_EVENTS=true` no `.env`. Em produção, mantenha `false` para evitar volume e exposição de dados.

Para testar sem tocar no DB 7, use um DB e prefixo isolados:

```bash
REDIS_DB=15 REDIS_PREFIX=nodfw:test:manual npm start
```

Limpeza após o teste:

```bash
redis-cli -n 15 --scan --pattern 'nodfw:test:manual:*' | xargs -r redis-cli -n 15 del
```

Exemplo de envio manual via Syslog UDP usando o formato do Nginx:

```text
<134>Nov  5 14:00:00 web01 nodefw: {"timestamp":"2026-11-05T14:00:00-03:00","site":"www.example.com","ip":"203.0.113.10","method":"GET","path":"/teste?utm=x","status":200,"request_time":0.04,"upstream_addr":"unix:/run/php/php8.2-fpm.sock","upstream_time":"0.03","dynamic":1,"user_agent":"test"}
```

Com Redis indisponível, `/api/ready` retorna 503, mas a API e o coletor continuam ativos. O pipeline abre o circuito, mantém a fila limitada e retoma automaticamente quando o Redis volta.

Para encerrar, use `Ctrl+C` ou `SIGTERM`; o coletor fecha o socket, o pipeline tenta o último lote e a API encerra de forma graciosa.
