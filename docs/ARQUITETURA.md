# Node FW — Arquitetura

| Campo | Valor |
|---|---|
| Projeto | Node FW |
| Documento | Arquitetura e decisões técnicas |
| Versão | 0.5.0 |
| Data | 06/11/2026 |
| Status | Arquitetura inicial; Fases 1 a 3 implementadas, piloto Nginx da Fase 4 integrado e painel provisório 4A concluído |

## 1. Visão geral

O Node FW é uma central de telemetria e classificação de segurança para sites atendidos pelo Nginx. Ele recebe eventos de acesso por Syslog UDP, enriquece os dados, mantém janelas temporais em Redis, classifica o comportamento e disponibiliza monitoramento e administração em um painel. O bloqueio de rede é delegado exclusivamente ao Fail2Ban.

```text
INTERNET
   |
   v
FIREWALL (iptables / Fail2Ban)
   |
   v
NGINX
   |
   +----> PHP-FPM / Magento / Laravel / WordPress
   |
   +----> Access Log tradicional (preservado)
   |
   +----> Syslog UDP 127.0.0.1:5514
                |
                v
          COLETOR NODE.JS
                |
                +----> Parser + validação
                +----> Enriquecimento MaxMind (Country/ASN)
                +----> Fila limitada + lote
                |
                v
              REDIS
                |
                +----> Janelas e contadores
                +----> Score e suspeitos
                +----> Stream de eventos / Pub-Sub
                |
                v
        MOTOR DE CLASSIFICAÇÃO
                |
                +----> API / WebSocket / Dashboard
                +----> Lista de suspeitos
                +----> Evento de bloqueio validado
                              |
                              v
                       ARQUIVO SEGURO
                              |
                              v
                          FAIL2BAN
                              |
                              v
                           IPTABLES
```

## 2. Componentes e responsabilidades

| Componente | Responsabilidade | Não faz |
|---|---|---|
| Nginx | Atender requisições, manter access log tradicional, enviar evento JSON via Syslog UDP | Não consulta o Node FW para liberar acesso |
| Coletor UDP | Escutar somente `127.0.0.1:5514`, ler datagramas, aplicar limite de tamanho | Não confia no conteúdo para bloquear diretamente |
| Parser/validador | Extrair syslog + JSON, validar schema, normalizar IP, limitar campos | Não aceita texto livre em decisões de bloqueio |
| Enriquecimento | Consultar MaxMind Country/ASN local, cache, verificação de bots | Não faz chamadas de rede no caminho crítico |
| Agregador Redis | Contadores, janelas, rankings, unicidade aproximada, TTL | Não é fonte de verdade permanente de configuração |
| Motor de classificação | Calcular score, aplicar regras globais/por site, explicar decisão | Não altera iptables |
| API Fastify | Autenticação, consultas, administração, health/metrics | Não fica exposta diretamente à internet |
| WebSocket | Atualizações em tempo quase real, com throttle e limites | Não substitui a API para operações administrativas |
| Painel Vue/Quasar | Dashboard, monitoramento, suspeitos, administração | Não acessa Redis ou Fail2Ban diretamente |
| Ponte Fail2Ban | Escrever eventos validados em arquivo restrito | Não executa comandos de firewall por requisição |
| Jobs | Atualização MaxMind, retenção, reconciliação de bans, verificação de bots | Não bloqueiam o event loop |
| Fail2Ban | Ler o arquivo de eventos, aplicar banimento via iptables | Não depende do Node FW para funcionar |

### 2.1 Comunicação entre serviços

| Origem → destino | Protocolo/meio | Endereço padrão | Proteção |
|---|---|---|---|
| Nginx → coletor | Syslog UDP | `127.0.0.1:5514` | Bind em loopback, validação de schema e tamanho |
| Coletor/API → Redis | RESP2/TCP | `127.0.0.1:6379`, DB 7 | Compatível com o Redis 5.0.7 observado no servidor; bind local, ACL/requirepass, firewall |
| Node → MaxMind | Leitura de arquivo local | `data/geolite2/` ou `/var/lib/node-fw/geolite2/` | Permissões restritas, sem rede no hot path |
| Job → MaxMind | HTTPS | `download.maxmind.com:443` | TLS, credenciais em `.env`, URL nunca logada |
| Node → Fail2Ban | Arquivo append-only | `/var/log/node-fw/security-events.log` | Diretório restrito, linha validada, filtro ancorado |
| Navegador → painel/API | HTTPS/WSS via proxy | Domínio administrativo | TLS, sessão, CSRF, rate limit |
| API → Fail2Ban (desbloqueio) | Helper restrito | `fail2ban-client` | Sudoers mínimo, IP validado, auditoria |
| Fail2Ban → iptables | Netfilter local | — | Executado apenas pelo Fail2Ban |

## 3. Fluxo de dados

1. A requisição chega ao Nginx e é encaminhada ao PHP-FPM ou servida como estático.
2. A location PHP registra o acesso no log tradicional e envia o mesmo evento em JSON para `127.0.0.1:5514`.
3. O coletor recebe o datagrama, valida tamanho e origem, e faz o parse do envelope syslog e do JSON.
4. O evento é validado: IP, domínio, método, caminho, status, tempos, User-Agent e `request_id`.
5. O IP é consultado no MaxMind local (Country/ASN) e em caches de verificação de bots.
6. O evento entra em uma fila limitada; um worker de lote grava contadores e amostras no Redis.
7. O motor de regras calcula ou atualiza o score do IP no contexto do site e das janelas.
8. Decisões, mudanças de nível e eventos relevantes são publicados para o painel.
9. Em modo de bloqueio, um evento `NODEFW_BAN` é escrito em arquivo restrito.
10. O Fail2Ban lê o arquivo, valida a linha pelo filtro e aplica o banimento via iptables.
11. O painel consulta o estado real do Fail2Ban e reconcilia o que foi registrado.

## 4. Estrutura futura de diretórios

```text
node-fw/
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
├── config/                  # sites, regras, exceções, settings (fonte de verdade)
├── data/
│   └── geolite2/            # bancos .mmdb independentes (fora do Git)
├── src/
│   ├── server.js            # bootstrap Fastify
│   ├── config/              # carregamento e validação de ambiente/config
│   ├── collector/           # UDP, parser, validação, fila
│   ├── enrichment/          # MaxMind, bots, caches
│   ├── storage/             # Redis, streams, agregações
│   ├── classification/      # regras, score, decisões
│   ├── security/            # evento Fail2Ban, reconciliação
│   ├── routes/              # rotas REST e painel provisório
│   ├── panel/               # HTML/CSS/JS do painel 4A
│   ├── realtime/            # WebSocket (previsto)
│   ├── jobs/                # atualização, retenção, limpeza
│   └── utils/
├── panel/                   # Vue 3 + Quasar (Fase 7)
├── test/
├── scripts/                 # operação e diagnóstico
├── .env.example
├── .gitignore
└── package.json
```

Em produção, os bancos MaxMind devem ficar preferencialmente em `/var/lib/node-fw/geolite2/`, com permissões restritas, e não dentro do diretório do código.

## 5. Integração com o Nginx

### 5.1 Formato de log proposto

As diretivas `map` e `log_format` devem ser definidas no contexto `http` (por exemplo, em um arquivo incluído por `nginx.conf`). O formato deve ser usado em locations dinâmicas/PHP, não no `server` inteiro, para evitar volume de estáticos.

```nginx
map $request_uri $nodefw_request_path {
    default $request_uri;
    "~^(?<path_only>[^?]*)" $path_only;
}

map $upstream_addr $nodefw_dynamic {
    ""      0;
    default 1;
}

log_format security_json escape=json
'{'
  '"timestamp":"$time_iso8601",'
  '"request_id":"$request_id",'
  '"site":"$host",'
  '"server_name":"$server_name",'
  '"ip":"$remote_addr",'
  '"method":"$request_method",'
  '"path":"$nodefw_request_path",'
  '"final_uri":"$uri",'
  '"status":$status,'
  '"request_time":$request_time,'
  '"upstream_addr":"$upstream_addr",'
  '"upstream_time":"$upstream_response_time",'
  '"dynamic":$nodefw_dynamic,'
  '"scheme":"$scheme",'
  '"body_bytes_sent":$body_bytes_sent,'
  '"user_agent":"$http_user_agent"'
'}';
```

Pontos importantes:

- `$nodefw_request_path` remove a query string. O caminho original é preservado mesmo após reescritas internas.
- `$uri` representa a URI final após reescritas; é útil para separar rota original de rota executada.
- `$upstream_addr` indica se houve encaminhamento a um upstream (PHP-FPM). `dynamic=1` significa encaminhamento efetivo.
- `$request_id` permite correlacionar logs tradicionais, eventos e investigação.
- `escape=json` evita JSON inválido por aspas, barras e caracteres de controle no User-Agent.
- Não incluir `$args`, `$http_cookie`, `$http_authorization`, `$request_body` ou headers sensíveis.
- O User-Agent deve ser truncado no coletor (por exemplo, 512 caracteres) antes de armazenamento.

O `map` de caminho deve ser validado na versão de produção. Se o resultado não for o esperado, o coletor deve remover a query string como fallback antes de qualquer armazenamento.

### 5.2 Snippet por site

Criar um snippet reutilizável. Neste servidor ele está em `/home/edson/www/node-fw/nginx/node-fw-php-log.conf`; em produção pode ser copiado para `/etc/nginx/snippets/node-fw-php-log.conf`:

```nginx
access_log syslog:server=127.0.0.1:5514,facility=local6,tag=nodefw,severity=info,nohostname security_json;
```

Incluir somente nas locations que executam PHP:

```nginx
location ~ \.php$ {
    # ... fastcgi_pass e demais diretivas existentes ...

    include /etc/nginx/snippets/node-fw-php-log.conf;
}
```

Para Magento, verificar também locations que fazem `fastcgi_pass` diretamente em `@handler` ou em reescritas internas. A inclusão deve ocorrer em todos os caminhos que realmente executam PHP, evitando duplicidade quando houver redirecionamento interno.

### 5.3 Herança de `access_log`

- Um `access_log` definido em `location` substitui o herdado do `server` para aquela location.
- Sites com `access_log off;` no `server` continuam sem log tradicional; o snippet na location PHP adiciona o log de segurança, mas não restaura o log tradicional. Isso deve ser decidido por site.
- Um `access_log off;` em location de estáticos continua válido e não deve ser alterado.
- Diretivas dentro de `if` são desencorajadas; validar o comportamento com `nginx -T` e teste real.
- Para preservar o log tradicional, manter a diretiva original e adicionar o Syslog como segundo `access_log` no mesmo contexto, quando aplicável.

### 5.4 Identificação de requisições dinâmicas

A estratégia principal é:

1. Registrar somente em locations PHP.
2. Usar `$upstream_addr` para confirmar encaminhamento ao FastCGI.
3. Usar `$nodefw_request_path` para preservar a rota original.
4. Usar `$uri` para identificar a rota final após reescritas do Magento.

Limitações:

- Cache de FastCGI pode atender sem `$upstream_addr`; nesse caso o evento continua sendo de rota PHP, mas `dynamic=0`. O Node deve considerar `final_uri` terminando em `.php` como rota dinâmica.
- Reescritas internas podem fazer o log ocorrer apenas na location final. O caminho original deve vir de `$request_uri` sanitizado.
- Se um site usar `fastcgi_pass` em local incorreto, o evento pode não ser registrado. A validação deve comparar logs tradicionais e eventos recebidos.

### 5.5 Proxy, CDN e IP real

- `$remote_addr` só é confiável se o Nginx estiver configurado corretamente para proxies confiáveis.
- Usar `set_real_ip_from` apenas com faixas oficiais do CDN/proxy e `real_ip_header` correspondente.
- Nunca usar `set_real_ip_from 0.0.0.0/0` ou confiar em `X-Forwarded-For` de clientes arbitrários.
- Validar a configuração com requisições diretas e via CDN.
- Se o IP não puder ser determinado com confiança, o evento deve ser marcado e o score não deve gerar bloqueio automático apenas por geolocalização.

### 5.6 Validação da integração

- Executar `nginx -T` e revisar a configuração efetiva antes de alterar.
- Testar um único site piloto.
- Comparar uma amostra de acessos do log tradicional com os eventos recebidos.
- Verificar contagem de requisições PHP, estáticos, redirecionamentos e 404.
- Medir latência do coletor e perda de UDP.
- Expandir para outros sites somente após 24 horas de validação.

## 6. Contrato do evento

Evento recebido pelo coletor (campos do Nginx):

```json
{
  "timestamp": "2026-11-05T13:45:00-03:00",
  "request_id": "5f0c2f5e0f9a4b0c",
  "site": "www.exemplo.com.br",
  "server_name": "www.exemplo.com.br",
  "ip": "203.0.113.10",
  "method": "GET",
  "path": "/catalogsearch/result",
  "final_uri": "/index.php",
  "status": 200,
  "request_time": 0.123,
  "upstream_addr": "unix:/run/php/php8.2-fpm.sock",
  "upstream_time": "0.100",
  "dynamic": 1,
  "scheme": "https",
  "body_bytes_sent": 1234,
  "user_agent": "Mozilla/5.0 ..."
}
```

Campos adicionados pelo Node FW:

```json
{
  "received_at": "2026-11-05T16:45:00.123Z",
  "country": "BR",
  "asn": 12345,
  "asn_org": "Provedor Exemplo",
  "score": 42,
  "level": "suspeito",
  "reasons": ["rate_5m", "not_found_ratio"],
  "verified_bot": false
}
```

Regras de validação:

- `ip` deve ser IPv4 ou IPv6 válido; IP privado/reservado deve ser marcado.
- `site` deve corresponder a um domínio cadastrado; domínio desconhecido é registrado, mas não gera bloqueio automático.
- `path` deve começar com `/`, ter tamanho máximo e não conter query string.
- `status` deve estar entre 100 e 599.
- `request_time` e `upstream_time` devem ser numéricos e limitados.
- `user_agent` deve ser truncado e sanitizado.
- Eventos com JSON inválido, campos ausentes ou tamanho excessivo são descartados e contabilizados.

## 7. Estratégia de Redis

### 7.1 Topologia e segurança

- Redis acessível apenas em loopback ou rede privada confiável.
- Preferir instância dedicada ao Node FW; se compartilhada, usar DB e prefixo exclusivos.
- Proposta: DB `7` e prefixo `nodfw:v1:` (o projeto antigo usa DB `6`, que não deve ser reutilizado).
- Habilitar `requirepass` ou ACL com usuário de privilégio mínimo.
- `protected-mode yes`, `bind 127.0.0.1`, firewall restritivo.
- Não expor Redis ao painel ou à internet.
- Monitorar memória, conexões, latência e chaves expiradas.

### 7.2 Estruturas e chaves

| Chave | Tipo | Conteúdo | TTL |
|---|---|---|---|
| `nodfw:v1:rate:g:{window}:{bucket}` | string | Contador global | `max(2x janela, 60s)` |
| `nodfw:v1:rate:site:{site}:{window}:{bucket}` | string | Contador por site | `max(2x janela, 60s)` |
| `nodfw:v1:rate:ip:{ip}:{window}:{bucket}` | string | Contador por IP (1m/5m/15m) | `max(2x janela, 60s)` |
| `nodfw:v1:rate:ip_site:{ip}:{site}:{window}:{bucket}` | string | IP + site | `max(2x janela, 60s)` |
| `nodfw:v1:uniq:g:{window}:{bucket}` | HyperLogLog | Visitantes aproximados globais | `max(2x janela, 60s)` |
| `nodfw:v1:uniq:site:{site}:{window}:{bucket}` | HyperLogLog | Visitantes aproximados por site | `max(2x janela, 60s)` |
| `nodfw:v1:country:g:{window}:{bucket}` | sorted set | Ranking global de países | `max(2x janela, 60s)` |
| `nodfw:v1:country:site:{site}:{window}:{bucket}` | sorted set | Ranking de países por site | `max(2x janela, 60s)` |
| `nodfw:v1:status:g:{window}:{bucket}` | hash | Status HTTP global | `max(2x janela, 60s)` |
| `nodfw:v1:status:site:{site}:{window}:{bucket}` | hash | Status HTTP por site | `max(2x janela, 60s)` |
| `nodfw:v1:dynamic:g:{window}:{bucket}` | string | Requisições dinâmicas globais | `max(2x janela, 60s)` |
| `nodfw:v1:dynamic:site:{site}:{window}:{bucket}` | string | Requisições dinâmicas por site | `max(2x janela, 60s)` |
| `nodfw:v1:rank:ip:g:{window}:{bucket}` | sorted set | Ranking global de IPs | `max(2x janela, 60s)` |
| `nodfw:v1:rank:ip:site:{site}:{window}:{bucket}` | sorted set | Ranking de IPs por site | `max(2x janela, 60s)` |
| `nodfw:v1:ip:{ip}:sites` | set | Domínios acessados | 24h |
| `nodfw:v1:score:ip:{ip}` | hash | Reputação: firstSeen, lastSeen, totalEvents, último site/status/método/país | 30d |
| `nodfw:v1:events` | stream | Eventos recentes (`MAXLEN ~`) | 50.000 entradas por padrão |

Chaves de suspeitos, verificação de bots, cooldown de ban e metadados MaxMind serão adicionadas nas fases 5, 6 e 8.

Janelas implementadas:

- 1 segundo: taxa, status e dinâmicas globais e por site.
- 1 minuto, 5 minutos e 15 minutos: global, site, IP e IP+site.
- Buckets alinhados por epoch UTC em segundos; o sufixo é o início do bucket.
- As consultas atuais usam os buckets correntes (janelas tumbling). Somas móveis podem ser adicionadas na Fase 7 se o painel exigir.

Operações:

- Incrementos em lote via `MULTI`/pipeline a cada 100 ms ou ao atingir 200 eventos.
- Para contadores com TTL, `INCRBY`/`ZINCRBY`/`HINCRBY`/`PFADD`/`SADD` seguidos de `EXPIRE` no mesmo pipeline.
- Rankings usam `ZINCRBY`; consultas usam `ZREVRANGE`/`ZRANGE WITHSCORES` com limite.
- Unicidade usa `PFADD`/`PFCOUNT` com erro aproximado aceitável.
- O stream usa `XADD ... MAXLEN ~` para limitar memória.
- Reputação é atualizada com `HSETNX` (firstSeen), `HINCRBY` (totalEvents) e `HSET` (último estado).
- O circuito fica aberto enquanto `isReady=false`; a fila limitada retém os eventos e o pipeline retoma quando a conexão volta.

### 7.3 Memória e retenção

- Nenhuma requisição individual é armazenada indefinidamente.
- Contadores expiram em no máximo 30 minutos.
- Stream de eventos com `MAXLEN ~` (por exemplo, 100.000 a 200.000 entradas) e política de retenção.
- Scores e suspeitos têm TTL ou decaimento; reincidência é recalculada a partir do histórico recente.
- Definir `maxmemory` e política compatível com o uso. Preferir `noeviction` com alerta, ou `volatile-lru` apenas se todos os dados relevantes tiverem TTL.
- Em caso de pressão de memória, o coletor deve descartar telemetria, nunca bloquear o processo nem os sites.

### 7.4 Tempo real

- Pub/Sub `nodfw:live` publica lotes agregados, não cada evento individual.
- WebSocket envia atualizações com throttle (por exemplo, 1 vez por segundo por cliente).
- Backfill do painel usa o stream de eventos, não Pub/Sub.
- Clientes lentos são desconectados; não há fila ilimitada por conexão.

## 8. Motor de classificação

### 8.1 Níveis

| Nível | Faixa inicial | Ação padrão |
|---|---|---|
| Normal | 0–19 | Nenhuma |
| Observação | 20–39 | Registrar e monitorar |
| Suspeito | 40–69 | Destacar no painel |
| Crítico | 70–100 | Registrar evento de bloqueio quando elegível |
| Bloqueado | Estado separado | Refletir estado real do Fail2Ban |

Bloqueado não é apenas uma faixa de score: é um estado operacional confirmado pelo Fail2Ban.

### 8.2 Sinais e pesos iniciais

Os pesos são provisórios e devem ser calibrados em modo monitoramento.

| Sinal | Peso inicial | Observação |
|---|---|---|
| País fora do Brasil | +15 | Nunca suficiente sozinho para bloquear |
| País desconhecido por falha de base | 0 | Falha de infraestrutura não penaliza o visitante |
| ASN de hospedagem/VPN/proxy | +10 | Dependente de lista/ASN confiável |
| Taxa 1m acima de 3x o limite do site | +20 | Limite por site |
| Taxa 1m acima de 10x o limite | +35 | Substitui o anterior |
| Burst em 10s acima do limite | +15 | Rotas críticas podem ter limite menor |
| Proporção de 404 acima de 70% com volume relevante | +20 | Varredura de rotas |
| Proporção de 403/429 acima de 50% | +15 | Tentativas repetidas |
| Acesso a rotas críticas sensíveis | +20 por categoria, cap +30 | Ex.: arquivos de configuração, login, XML-RPC |
| User-Agent vazio ou claramente automatizado | +10 | Não confundir com bots verificados |
| UA alega Googlebot/Bingbot sem verificação | +25 | Só depois da verificação |
| Bot verificado | -40, piso 0 | Tratamento e limites próprios |
| POST repetido em endpoints de autenticação | +20 | Evitar força bruta |
| Reincidência de banimento | +25 | Histórico próprio |
| IP acessando muitos domínios em pouco tempo | +15 | Pode indicar varredura multi-site |

Regras de segurança:

- País é apenas um componente; nunca é critério isolado de bloqueio.
- Bloqueio automático exige score mínimo (proposta: 85), pelo menos dois sinais independentes, ausência de exceção e modo de operação 3.
- Modo 1 (monitoramento) e modo 2 (sugestão) nunca escrevem evento de banimento.
- Falha de MaxMind, Redis ou verificação de bot não pode criar evidência artificial.
- Scores decaem com o tempo e são recalculados com janelas recentes; reincidência persistente tem decaimento mais lento.
- Toda decisão deve registrar os motivos e os valores que a originaram.

### 8.3 Bots legítimos

A verificação não confia apenas no User-Agent:

1. Identificar a alegação de bot pelo User-Agent.
2. Resolver DNS reverso do IP.
3. Validar o sufixo do hostname esperado.
4. Resolver o hostname para frente e confirmar que retorna o mesmo IP.
5. Quando disponível, comparar com faixas publicadas oficialmente (Google/Bing).
6. Cachear o resultado por 24 horas.

Se a verificação falhar, o IP não recebe o desconto de bot. Se alegar ser bot sem comprovar, recebe penalidade. Bots verificados podem ter limites próprios e exceção a bloqueios baseados apenas em taxa, mas continuam sujeitos a registro e análise.

### 8.4 Configuração por site

Cada site pode definir:

- Limites de requisições por janela.
- Rotas críticas e limites específicos.
- Países com monitoramento reforçado.
- Exceções por IP/CIDR, ASN, bot verificado e rota.
- Modo de operação: 1, 2 ou 3.
- Score mínimo e critérios de bloqueio.
- Retenção de dados específica.

Exceções devem ser auditadas e não podem desativar silenciosamente todas as regras. Uma exceção de bloqueio não impede o registro do evento.

### 8.5 Persistência de configuração

- Configurações em arquivos JSON versionados em `config/`, com escrita atômica e schema validado.
- Redis guarda cache e estado temporário, não a fonte de verdade da configuração.
- Alterações pelo painel geram registro de auditoria append-only.
- Toda alteração deve ser reversível e identificar autor, data e diff.
- Se a necessidade de consultas históricas crescer, avaliar SQLite em fase futura; não introduzir banco relacional agora.

## 9. API e painel

### 9.1 API

Rotas implementadas na fase atual:

```text
GET  /panel                  # painel provisório 4A (HTML/CSS/JS)
GET  /api/health
GET  /api/ready
GET  /api/stats
GET  /api/summary
GET  /api/events/recent      # paginação cursorizada e filtros limitados
```

Rotas administrativas previstas para a Fase 7:

```text
GET  /api/ips/:ip
GET  /api/suspects
GET  /api/sites
POST /api/sites
PUT  /api/sites/:id
GET  /api/rules
PUT  /api/rules
GET  /api/exceptions
POST /api/exceptions
GET  /api/bans
POST /api/bans/:ip/unban
GET  /api/settings
PUT  /api/settings
WS   /ws
```

- O painel 4A e `/api/events/recent` são somente leitura, com API em loopback e sem autenticação nesta fase. Não devem ser expostos à Internet.
- A consulta de eventos usa `XREVRANGE` com `COUNT` limitado e cursor de stream; não usa `KEYS` nem carrega o stream inteiro.
- Autenticação por sessão segura; cookie `HttpOnly`, `Secure`, `SameSite=Strict` (Fase 7).
- CSRF obrigatório em métodos que alteram estado.
- Rate limit em login e endpoints administrativos.
- Validação de entrada por schema.
- Toda ação administrativa registrada em auditoria.
- Desbloqueio administrativo não executa comando de shell arbitrário; usa helper restrito e IP validado.

### 9.2 Painel

**Fase 4A (implementado):**

- Painel provisório em HTML/CSS/JS servido pelo próprio Fastify em `/panel`.
- Somente leitura, loopback, sem autenticação nesta etapa.
- Polling de 10 segundos; sem WebSocket.
- Eventos do stream Redis com paginação cursorizada; filtros por site, IP e status.
- Indicadores de `/api/stats` e `/api/summary`; sem MaxMind/score.

**Fase 7 (previsto):**

- Vue 3 + Quasar, build estático.
- Servido atrás de proxy com TLS; não exposto diretamente.
- Dashboard, monitoramento, suspeitos, sites, regras, exceções, bloqueios e retenção.
- Atualizações em tempo real via WebSocket, com fallback de polling.
- Exibir claramente o modo de operação atual e o estado de saúde dos componentes.
- Exibir atribuição MaxMind no rodapé ou tela "Sobre".

## 10. Integração com Fail2Ban

### 10.1 Formato do evento

Linha única, campos fixos e validados:

```text
NODEFW_BAN ts=2026-11-05T16:45:00Z ip=203.0.113.10 score=92 level=critical site=www.exemplo.com.br rule=RATE_10X window=60s id=9f2c1a7b4e8d4c6a
```

Regras:

- Apenas IP válido em `ip`.
- `score` inteiro; `level` e `rule` em enumeração fechada.
- `site` restrito a `[a-z0-9.-]+` e tamanho máximo.
- `id` hexadecimal/ULID; `ts` em UTC.
- Nenhum URI, User-Agent, header ou texto livre na linha.
- Uma linha por evento, sem quebras internas.
- Escrita append-only, com `fsync` conforme política de durabilidade.

### 10.2 Arquivo e permissões

Proposta:

```text
/var/log/node-fw/                  root:nodefw 0750
/var/log/node-fw/security-events.log  nodefw:nodefw 0640
```

- O diretório não deve ser gravável pelo usuário do serviço; apenas o arquivo é append-only para ele.
- O Fail2Ban lê o arquivo com privilégios próprios.
- Nenhum usuário de aplicação ou site pode escrever no diretório.
- Logrotate deve recriar o arquivo com as permissões corretas e sinalizar o Fail2Ban quando necessário.
- O caminho não deve estar sob document root.

### 10.3 Filtro e jail

Filtro proposto (`filter.d/nodefw.conf`):

```ini
[Definition]
failregex = ^NODEFW_BAN\s+ts=\S+\s+ip=<HOST>\s+score=\d+\s+level=(?:critical|blocked)\s+site=[a-z0-9.-]+\s+rule=[A-Z0-9_]+\s+window=\S+\s+id=[a-f0-9]{8,64}\s*$
ignoreregex =
```

Jail proposto (`jail.d/nodefw.local`):

```ini
[nginx-security-monitor]
enabled  = true
filter   = nodefw
logpath  = /var/log/node-fw/security-events.log
maxretry = 1
findtime = 60
bantime  = 24h
bantime.increment = true
bantime.factor = 30
bantime.maxtime = 30d
```

Os valores acima são um ponto de partida, não uma configuração pronta para produção. O comportamento de `bantime.increment` varia conforme a versão e a fórmula do Fail2Ban: com incremento exponencial, `factor = 30` pode não produzir exatamente 24 horas no primeiro banimento e 30 dias na reincidência. Antes da Fase 8, validar o resultado real com banimentos controlados e, se necessário, adaptar a fórmula ou reutilizar a mesma lógica já validada no jail `nginx-wishlist`, sem alterar esse jail. O requisito funcional é: primeiro banimento de 24 horas e reincidência de 30 dias.

### 10.4 Consistência e desbloqueio

- O painel registra a intenção e o evento emitido, mas o estado "bloqueado" só é confirmado após consulta ao Fail2Ban.
- Job de reconciliação periódico consulta `fail2ban-client status nginx-security-monitor` e compara com o estado local.
- Divergências geram alerta e registro de auditoria; não removem bans automaticamente.
- Desbloqueio usa comando restrito (`fail2ban-client set nginx-security-monitor unbanip <ip>`) via helper com validação de IP e sudoers mínimo.
- O Node process não executa comandos de firewall diretamente.
- Em caso de indisponibilidade do Fail2Ban, o painel mostra estado degradado e não simula sucesso.

## 11. Segurança

### 11.1 Fronteiras de confiança

| Fronteira | Risco | Controle |
|---|---|---|
| Internet → Nginx | Ataque HTTP, IP falsificado | Nginx, real_ip restrito, TLS |
| Nginx → coletor UDP | Datagrama forjado por processo local | Bind em loopback, validação, modo monitoramento, permissões |
| Coletor → Redis | Acesso indevido a dados | Loopback, ACL, firewalls |
| Node → arquivo Fail2Ban | Injeção de linha | Campos fixos, validação, permissões |
| Admin → painel | Sequestro de sessão/CSRF | TLS, cookies seguros, CSRF, rate limit |
| Node → MaxMind | Vazamento de credenciais | `.env` 0600, redaction, sem URL em logs |

### 11.2 Credenciais e segredos

- `.env` com permissão `0600`, fora do Git.
- `MAXMIND_ACCOUNT_ID` e `MAXMIND_LICENSE_KEY` nunca são exibidos em logs, respostas, métricas ou mensagens de erro.
- URLs de download com chave são construídas em memória e nunca logadas.
- `SESSION_SECRET` forte e distinto por ambiente.
- Senhas administrativas armazenadas com Argon2id, nunca em texto puro.
- Rotação documentada de credenciais.

### 11.3 Proteção contra injeção no log

- O coletor não escreve conteúdo vindo do visitante no arquivo do Fail2Ban.
- Apenas campos enumerados e validados são usados.
- IP é validado com biblioteca nativa; site e regra têm regex e tamanho máximo.
- O filtro do Fail2Ban é ancorado no início e no fim da linha.
- O arquivo tem permissões restritas e não é gravável por usuários das aplicações.

### 11.4 DoS e abuso

- Limite de tamanho por datagrama (por exemplo, 8 KB) e descarte do excedente.
- Fila interna limitada; ao encher, descartar os eventos mais antigos e incrementar métrica.
- Rate limit por IP e por site.
- WebSocket com limite de conexões e de mensagens.
- API com limite de requisições e timeout.
- Nenhuma operação de rede síncrona no caminho de coleta.
- Monitorar crescimento de chaves Redis e uso de CPU/memória.

### 11.5 Privacidade

- Não registrar query string, cookies, `Authorization`, corpo de requisição ou tokens.
- User-Agent truncado.
- IP e histórico com retenção definida.
- Acesso ao painel restrito.
- Documentar base legal e finalidade conforme a LGPD, quando aplicável.

## 12. Tratamento de falhas

| Falha | Comportamento | Impacto nos sites |
|---|---|---|
| Redis indisponível | Coletor continua, fila limitada, descarte e reconexão | Nenhum |
| Redis lento | Escrita em lote com timeout e circuit breaker | Nenhum |
| MaxMind ausente | Evento sem país/ASN, score degradado, alerta | Nenhum |
| MaxMind corrompido | Manter versão anterior; não trocar o arquivo | Nenhum |
| UDP perdido | Métricas de recebimento e comparação com logs | Nenhum |
| Node.js cai | systemd reinicia; Nginx continua enviando logs tradicionais | Nenhum |
| Fail2Ban indisponível | Nenhum novo ban; painel degradado | Nenhum |
| Disco cheio | Parar escrita de eventos, alertar, não bloquear sites | Nenhum |
| Configuração inválida | API recusa alteração; manter última versão válida | Nenhum |
| Nginx recarregado | Coletor permanece; eventos continuam | Nenhum |

Princípio: falha do Node FW reduz visibilidade ou bloqueio, nunca disponibilidade dos sites.

## 13. Observabilidade

Métricas mínimas:

- Datagramas recebidos, válidos, inválidos e descartados.
- Profundidade da fila e tempo de espera.
- Latência de escrita no Redis e falhas.
- Consultas MaxMind por segundo e falhas.
- Eventos classificados por nível.
- Bans emitidos, confirmados e reconciliados.
- Conexões WebSocket e clientes lentos.
- Uso de memória do processo e do Redis.
- Idade dos bancos MaxMind.

Logs:

- JSON estruturado, com `request_id` quando aplicável.
- Nível configurável; sem dados sensíveis.
- Rotação e retenção definidas.
- Health check de liveness e readiness.

## 14. Metas de desempenho (provisórias)

- Sustentar 500 eventos/s e rajadas de 2.000 eventos/s no ambiente de teste.
- Processamento do coletor com p99 abaixo de 5 ms, sem I/O síncrono.
- Uso de memória do Node abaixo de 200 MB em operação normal.
- Redis com crescimento controlado e TTL efetivo.
- Nenhum bloqueio do event loop por DNS, disco ou rede.
- Latência adicionada ao Nginx: apenas o custo do log Syslog local.

As metas devem ser revalidadas com carga real antes da Fase 9.

## 15. Decisões e trade-offs

| Decisão | Alternativa descartada | Motivo |
|---|---|---|
| Syslog UDP nativo | `auth_request` | Não adiciona dependência HTTP por requisição e preserva status/tempo final |
| Logs tradicionais mantidos | Substituir logs pelo Node | Recuperação, auditoria e independência |
| Node não bloqueia | Bloqueio direto no Node | Fail2Ban/iptables é a única camada de bloqueio |
| Country + ASN | Apenas Country | ASN/hospedagem é sinal relevante |
| Redis temporário | Redis como banco principal | Configuração e auditoria não devem depender de dados voláteis |
| Configuração em JSON | Banco relacional | Simplicidade e baixo custo nesta fase |
| Query string removida | Registrar URL completa | Evita vazamento de tokens e dados sensíveis |
| Log apenas em locations PHP | Log no server inteiro | Evita volume de estáticos |
| Jail separado | Reutilizar `nginx-wishlist` | Isolamento e não regressão |
| Modo monitoramento inicial | Bloqueio automático imediato | Calibração e prevenção de falsos positivos |

## 16. Estado da implementação (Fase 4 — piloto + painel 4A)

Implementado:

- Backend Node.js ESM com Fastify 5 e logger Pino com redaction.
- Configuração validada por ambiente, com bind obrigatório em loopback para API e coletor.
- Coletor Syslog UDP nativo, com validação de origem, tamanho, tag, JSON e campos do evento.
- Fila limitada no coletor, com descarte do evento mais antigo e métricas de profundidade/perda.
- Cliente Redis com timeout, reconexão com backoff, `disableOfflineQueue` e circuit breaker fail-fast.
- Agregação em lote com janelas de 1s/1m/5m/15m, TTL, rankings, unicidade aproximada, status e dinâmicas.
- Stream de eventos recentes com limite de 50.000 entradas.
- Cache de reputação por IP (firstSeen, lastSeen, totalEvents, último site/status/método/país).
- Consultas agregadas em `/api/summary` (global e por site).
- Rotas `/api/health`, `/api/ready`, `/api/stats` e `/api/summary`.
- Encerramento gracioso por `SIGINT`/`SIGTERM`, incluindo último lote e fechamento do Redis.
- Testes unitários, testes com Redis real em DB/prefixo isolados, rajada de 200 eventos, indisponibilidade e recuperação do Redis.
- Piloto Nginx `casadoppia.site` com `log_format security_json`, mapa de caminho sem query, marcação dinâmica e snippet em location PHP.
- Log tradicional mantido na location PHP do piloto; estáticos permanecem sem log.
- Validação em Nginx 1.18.0 temporário na porta 18080: 3 requisições, 3 eventos, `dynamic=1`, `final_uri=/index.php`, status 200 e path sem query.
- `/etc/nginx/nginx.conf` inclui `/home/edson/www/node-fw/nginx/00-node-fw-log.conf` antes de `sites-enabled`; a cópia antiga em `/home/edson/www/nginx/` foi removida para evitar duplicidade.
- Reload do Nginx de produção aceito em 05/11/2026 e teste real no `casadoppia.site`: 3 eventos gravados no DB 7, sem inválidos.
- Documentação operacional em `docs/NGINX.md`; backup do vhost em `backups/`.
- Painel provisório 4A em `/panel`, somente leitura, loopback, com polling de 10s, filtros e paginação cursorizada do stream.
- Endpoint `/api/events/recent` com limite de 100 por página, varredura máxima de 1.000 entradas e User-Agent truncado em 160 caracteres.
- UI validada em Chrome headless com eventos reais; 60 testes automatizados aprovados.

Pendente na Fase 4:

- Soak de 24 horas e comparação contínua de contagens/perda de UDP.
- Execução explícita de `sudo nginx -t` antes do próximo reload.
- Validação de Laravel/WordPress e de proxy/CDN em sites reais.
- Expansão para os demais sites, um por vez.

Ainda não implementado:

- Enriquecimento MaxMind e país/ASN reais (Fase 5). O pipeline já aceita `country`/`asn` quando presentes.
- Score, níveis e lista de suspeitos (Fase 6). A reputação atual é descritiva, não classificatória.
- Painel administrativo completo (Fase 7); o painel 4A é apenas observação.
- Evento e jail Fail2Ban (Fase 8).
- Serviços systemd, alertas formais e endurecimento de produção (Fase 9).

Fluxo atual: Nginx → UDP → parser → fila limitada → aggregator em lote → Redis → `/api/summary`, `/api/stats` e `/panel`. O callback `onEvent` é o ponto de integração do coletor com o pipeline.
