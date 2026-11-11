# Node FW — Painel Provisório de Observação (Fase 4A)

| Campo | Valor |
|---|---|
| Documento | Guia do painel provisório de observação |
| Versão | 0.7.0 |
| Data | 11/11/2026 |
| Status | Implementado e validado; MaxMind e classificação (com perfis geográficos) em desenvolvimento; soak de 24h da Fase 4 ainda pendente |
| Natureza | Somente leitura, loopback, sem autenticação nesta etapa |

## 1. Objetivo

Permitir o acompanhamento visual dos acessos reais do piloto `casadoppia.site` durante o soak da Fase 4, usando o stream Redis já existente e as APIs de saúde/agregação. Com as Fases 5 e 6 em desenvolvimento, a tela também mostra país/ASN quando os bancos GeoLite2 estão carregados, além de score, nível e motivos da classificação local.

Este painel é um incremento operacional provisório. O painel administrativo completo (autenticação, suspeitos, regras, administração e WebSocket) continua planejado para a Fase 7.

## 2. Como iniciar

Pré-requisitos: Redis local ativo, Nginx do piloto configurado e o projeto com dependências instaladas. MaxMind é opcional: sem os bancos, o painel inicia em modo degradado e mostra `—` para país/ASN.

```bash
cd /home/edson/www/node-fw
tmux new -s nodefw
npm start 2>&1 | tee logs/node-fw-soak.log
```

Saia do tmux com `Ctrl+B` e depois `D`.

Abra no navegador local:

```text
http://127.0.0.1:8088/panel
```

A API e o painel escutam em loopback (`127.0.0.1:8088`). Não exponha essa porta publicamente.

### Acesso pelo navegador do seu computador via túnel SSH

Execute o comando **no terminal do seu computador**, não no shell do servidor. Use a porta local `18088` para não confundir/colidir com outro Node FW que possa estar rodando localmente na porta `8088`:

```bash
ssh -N -L 18088:127.0.0.1:8088 usuario@servidor
```

Substitua `usuario@servidor` pelo usuário e endereço SSH reais. Se o SSH usa uma porta diferente da padrão, acrescente, por exemplo, `-p 2222`. Mantenha esse terminal aberto enquanto usa o painel e abra:

```text
http://127.0.0.1:18088/panel
```

O lado esquerdo (`18088`) é a porta no seu computador; o lado direito (`127.0.0.1:8088`) é a porta de loopback no servidor. Para encerrar o túnel, pressione `Ctrl+C` nesse terminal; isso não encerra o Node FW no servidor. Se outro serviço já usar `18088`, escolha outra porta local livre, mantendo `127.0.0.1:8088` como destino remoto.

Use o conteúdo da tela para confirmar que chegou ao servidor: o domínio deve ser o do piloto online (por exemplo, `casadoppia.com.br` ou `www.casadoppia.com.br`) e os IPs devem corresponder aos acessos reais. Se aparecerem eventos de teste como `casadoppia.site`, IP `127.0.0.1` e User-Agent `curl`, provavelmente foi aberto o Node FW local, e não o túnel para o servidor.

Autenticação e TLS para acesso remoto ficam para uma etapa posterior; por isso, mantenha o encaminhamento SSH e não exponha a porta do painel publicamente.

Para encerrar o processo iniciado no tmux, use `Ctrl+C` dentro da sessão. Ainda não há serviço systemd; se o servidor reiniciar, o processo não volta automaticamente.

## 3. Tela

### 3.1 Indicadores

- Requisições nas janelas de 1, 5 e 15 minutos.
- Visitantes únicos estimados em 1 minuto (HyperLogLog).
- Status HTTP da janela de 1 minuto.
- Eventos inválidos e motivos.
- Profundidade da fila e total descartado.
- Prontidão do Redis e reconexões.
- Lotes, eventos gravados, falhas de escrita e descartes do pipeline.
- MaxMind: habilitado, país/ASN prontos, cache, lookups, hits e erros.
- Classificação: modo, decisões, níveis, perfis geográficos aplicados, IPs rastreados, exceções e erros.
- Saúde do coletor: recebidos, aceitos, inválidos e erros de callback.

Se um indicador não existir na resposta, a tela mostra `—` ou `indisponível`; nenhum valor é inventado.

### 3.2 Eventos recentes

Colunas exibidas:

| Campo | Origem | Observação |
|---|---|---|
| Horário | `timestamp`/`receivedAt` | Exibido em horário local |
| Site | `site` | Domínio do evento |
| IP | `ip` | IP do cliente |
| Origem | `country`, `asn` | País e ASN quando o MaxMind está carregado; `—` em modo degradado |
| Perfil geográfico | `geoProfile`, `geoFactor`, `geoFallback` | Exibido apenas no título da célula Origem; `geoFallback` indica país ausente/inválido. Sem edição pela UI |
| Método | `method` | GET, POST etc. |
| Caminho | `path` | Sem query string |
| Status | `status` | Com cor por faixa 2xx/3xx/4xx/5xx |
| Score | `score`, `level`, `reasons` | Score 0–100, nível e motivos no título |
| Tempo | `requestTime` | Milissegundos ou segundos |
| Dinâmica | `dynamic` | Indica encaminhamento a upstream PHP |
| User-Agent | `userAgent` | Truncado em 160 caracteres no servidor |

A URI final (`finalUri`) não é exibida como coluna; quando difere do caminho, aparece no título da célula. O caminho original é mantido sem query string.

### 3.3 Filtros e paginação

- Filtros: site, IP e status HTTP.
- Tamanho de página: 25, 50 ou 100.
- Ordem: mais recente primeiro.
- Paginação: cursor de stream Redis, com `Carregar mais`.
- Os filtros são validados no servidor.
- A consulta lê no máximo 1.000 entradas por chamada e filtra em memória; não usa `KEYS`, não varre todas as chaves e não retorna o stream inteiro.
- A resposta contém somente campos sanitizados: sem query string, cookies, `Authorization`, corpo ou credenciais.

### 3.4 Atualização

- Atualização automática a cada 10 segundos.
- O navegador pausa a atualização automática quando a aba está oculta.
- A tabela é atualizada via `fetch`, sem recarregar a página.
- Quando o operador carrega páginas antigas, a atualização automática não reinicia a paginação; os indicadores continuam sendo atualizados.
- Botão `Atualizar agora` reinicia os eventos na primeira página.
- Estados de carregamento, erro, vazio e última atualização são exibidos.

## 4. Segurança e privacidade

- Interface e APIs novas são somente leitura; não há banimento, edição, exclusão ou alteração de configuração.
- O bind da API continua restrito a `127.0.0.1`/`::1` pela configuração existente.
- Não há autenticação nesta etapa; por isso, não exponha a porta.
- Não há proxy público, TLS ou WebSocket nesta etapa.
- A UI usa `textContent`/elementos DOM para dados não confiáveis, sem `innerHTML` com conteúdo do evento.
- CSP restritiva, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` e `X-Content-Type-Options: nosniff`.
- User-Agent é truncado; query string é removida no servidor e novamente na consulta.
- Logs de requisição HTTP estão desativados; a tela não registra o conteúdo integral dos eventos.

## 5. Limitações desta versão

- MaxMind pode estar ausente/corrompido: país e ASN aparecem como `—`; nenhum valor é inventado.
- Score, nível e motivos são calculados localmente em modo monitoramento; não há calibração real nem bloqueio nesta fase.
- O perfil geográfico (`relaxed`, `standard` ou `strict`) e o fator efetivo aparecem apenas como diagnóstico no título da origem; não há edição de perfis pela UI.
- País ausente/inválido usa o perfil `standard` e é marcado como `geoFallback`; a ausência de país não adiciona score.
- O tracker de janelas é em memória e reinicia com o processo; a reputação/score persistidos no Redis permanecem, mas as janelas são reconstruídas.
- O painel administrativo de suspeitos, regras e exceções continua na Fase 7; a tela apenas exibe os campos do evento.
- Sem autenticação, multiusuário ou auditoria administrativa.
- Sem WebSocket; atualização por polling de 10 segundos.
- Stream limitado por `MAXLEN ~` (50.000 entradas por padrão).
- Filtros são aplicados sobre uma janela limitada de até 1.000 entradas por chamada; um filtro muito seletivo pode exigir várias páginas.
- O painel não substitui o log tradicional do Nginx, que continua sendo a fonte de auditoria/comparação.
- O processo não é supervisionado por systemd nesta fase.

## 6. Procedimento do soak de 24h

1. Iniciar o Node FW em `tmux`/`screen`, com o log de stdout em `logs/node-fw-soak.log`.
2. Registrar o baseline: data, `collector.accepted`, `collector.invalid` e linhas do log tradicional.
3. Manter o piloto `casadoppia.site` recebendo tráfego real por 24 horas.
4. Acompanhar pelo painel e pelas APIs:
   - eventos recentes e caminhos;
   - requisições 1m/5m/15m;
   - status HTTP;
   - inválidos por motivo;
   - profundidade da fila e descartes;
   - prontidão do Redis e falhas de escrita.
5. Comparar o delta de eventos aceitos com o delta de linhas do log tradicional.
6. Verificar se houve reinício do processo; contadores do processo zeram em um reinício.
7. Registrar erros/warnings do `logs/node-fw-soak.log` e do `/var/log/nginx/error.log`.

Comandos úteis:

```bash
curl -s http://127.0.0.1:8088/api/stats
curl -s 'http://127.0.0.1:8088/api/summary?site=casadoppia.site'
curl -s 'http://127.0.0.1:8088/api/events/recent?site=casadoppia.site&limit=50'
redis-cli -n 7 dbsize
redis-cli -n 7 xlen nodfw:v1:events
redis-cli -n 7 info memory | grep -E 'used_memory_human|used_memory_peak_human'
wc -l logs/casadoppia-access.log
```

## 7. Relação com as Fases 5 e 6

MaxMind e classificação estão implementados em desenvolvimento, mas **não implantados**. Bancos/credenciais reais, calibração dos scores/fatores geográficos e a decisão de produção continuam pendentes da revisão do soak da Fase 4. O painel mostra país/ASN quando os bancos estão carregados, score/nível em modo monitoramento, perfil/fator geográfico no diagnóstico e `—` quando o dado não existe. O estado atual e os comandos de coleta estão em `docs/SOAK-24H-PENDENTE.md`.

- eventos aceitos sem inválidos relevantes;
- contagens compatíveis com o log tradicional;
- nenhuma perda/descarte relevante;
- Redis e fila saudáveis;
- Nginx sem erros;
- MaxMind com readers prontos ou modo degradado explicitamente registrado;
- classificação em modo 1, com score/nível coerentes e sem erros;
- limitações conhecidas registradas.

## 8. Validação realizada

- 108 testes automatizados aprovados.
- Teste real de paginação no stream Redis DB 7.
- Filtros por site, IP e status validados.
- Consulta de cursor sem duplicidade.
- Caminho sem query string e User-Agent truncado.
- Renderização validada em Chrome headless, com eventos reais e indicadores.
- Origem (país/ASN) exibida quando há dados; `—` em modo degradado.
- MaxMind degradado validado sem invenção de país/ASN e com aviso no painel.
- Score/nível validados no painel com evento real (`critical_path` + UA vazio).
- Perfil/fator geográfico validados no diagnóstico de origem; país desconhecido não adiciona score.
- Interface e assets com headers restritivos; bind mantido em loopback.

Atribuição: o painel inclui o texto “Inclui dados GeoLite2 criados pela MaxMind, disponíveis em https://www.maxmind.com.”

## 9. Arquivos principais

- `src/panel/observation.html`: estrutura da tela.
- `src/panel/style.css`: layout responsivo.
- `src/panel/app.js`: atualização, filtros, paginação e renderização.
- `src/routes/panel.js`: serve a UI e o endpoint `/api/events/recent`.
- `src/storage/queries.js`: consulta cursorizada do stream, incluindo país/ASN e score.
- `src/enrichment/maxmind.js`: readers, cache e modo degradado.
- `src/classification/`: regras, perfis geográficos, tracker, verificador de bots e motor de score.
- `config/classification.example.json`: exemplo de regras globais, perfis geográficos e overrides por site.
- `test/event-query.test.js`: paginação, filtros e validação.
- `test/panel.test.js`: assets, headers e respostas de erro.
- `test/maxmind-enricher.test.js` e `test/maxmind-updater.test.js`: mocks/fixtures de MaxMind.
- `test/classifier.test.js`, `test/ip-tracker.test.js`, `test/bot-verifier.test.js` e `test/classification-rules.test.js`: classificação, janelas, bots, exceções e regras.
