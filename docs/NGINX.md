# Node FW — Integração com Nginx

| Campo | Valor |
|---|---|
| Documento | Configuração do Nginx para envio de eventos ao Node FW |
| Versão | 0.5.0 |
| Data | 06/11/2026 |
| Status | Configuração do piloto ativa e validada no Nginx real; Node de teste encerrado; soak de 24h pendente |
| Nginx validado | 1.18.0 (Ubuntu) |

## 1. Objetivo

Enviar os acessos dinâmicos (PHP/FastCGI) de cada site ao coletor Syslog UDP do Node FW, preservando os logs tradicionais e sem adicionar dependência HTTP no caminho de atendimento.

O Node FW escuta em:

```text
127.0.0.1:5514/udp
tag: nodefw
```

O `SYSLOG_TAG` do Node FW e o `tag=` do Nginx devem ser iguais.

## 2. Arquivos desta integração

| Arquivo | Função |
|---|---|
| `nginx/00-node-fw-log.conf` | Define `map` e `log_format` no contexto `http` |
| `nginx/node-fw-php-log.conf` | Snippet com o `access_log` Syslog para incluir em locations PHP |

Arquivos ativos neste servidor:

```text
/home/edson/www/node-fw/nginx/00-node-fw-log.conf       # definicoes http (incluido no nginx.conf)
/home/edson/www/node-fw/nginx/node-fw-php-log.conf      # snippet das locations PHP
```

O `/etc/nginx/nginx.conf` atual inclui diretamente o arquivo do projeto antes de `sites-enabled`:

```nginx
include /etc/nginx/conf.d/*.conf;
include /home/edson/www/node-fw/nginx/00-node-fw-log.conf;
include /etc/nginx/sites-enabled/*;
include /home/edson/www/nginx/*.conf;
```

A cópia antiga em `/home/edson/www/nginx/00-node-fw-log.conf` foi removida para evitar `map`/`log_format` duplicados.

## 3. Configuração central no contexto `http`

Conteúdo de `nginx/00-node-fw-log.conf`:

```nginx
map $request_uri $nodefw_request_path {
    default $request_uri;
    "~^(?<nodefw_path_only>[^?]*)" $nodefw_path_only;
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

### 3.1 Onde colocar em produção

Escolha **uma** opção, sem duplicar as definições:

1. **Neste servidor (configuração atual):** o `/etc/nginx/nginx.conf` inclui diretamente `/home/edson/www/node-fw/nginx/00-node-fw-log.conf` antes de `sites-enabled`. A cópia em `/home/edson/www/nginx/` foi removida.
2. **Padrão Debian/Ubuntu:** copiar para `/etc/nginx/conf.d/00-node-fw-log.conf`, que é incluído antes de `sites-enabled`.
3. **No topo do bloco `http`:** incluir o arquivo antes de qualquer `server` que use `security_json`.

Não mantenha o arquivo simultaneamente em `/etc/nginx/conf.d/` e no caminho do projeto; `log_format` e `map` duplicados causam erro de configuração.

### 3.2 Por que a ordem importa

`log_format` precisa estar definido antes do `access_log` que o referencia. Se o Nginx carregar um vhost antes da definição, o teste falha com formato desconhecido. Neste servidor, o include do arquivo do projeto foi colocado antes de `sites-enabled` e de `/home/edson/www/nginx/*.conf`.

### 3.3 Campos e decisões

| Campo | Origem | Uso |
|---|---|---|
| `timestamp` | `$time_iso8601` | Horário da requisição |
| `request_id` | `$request_id` | Correlação entre logs |
| `site` | `$host` | Domínio efetivamente acessado |
| `server_name` | `$server_name` | Nome configurado no vhost |
| `ip` | `$remote_addr` | IP do cliente; depende de `real_ip` confiável |
| `path` | `$nodefw_request_path` | Caminho original sem query string |
| `final_uri` | `$uri` | URI final após reescritas internas |
| `dynamic` | `$upstream_addr` | 1 quando houve encaminhamento a upstream |
| `upstream_addr` | `$upstream_addr` | Socket/host do PHP-FPM |
| `upstream_time` | `$upstream_response_time` | Tempo do upstream |
| `user_agent` | `$http_user_agent` | Truncado pelo Node FW |

Não são registrados: query string, cookies, `Authorization`, corpo da requisição, headers arbitrários ou tokens.

## 4. Configuração por vhost

### 4.1 Regra principal

Incluir o snippet **somente dentro de locations que executam PHP/FastCGI**:

```nginx
location ~ \.php$ {
    # ... diretivas existentes ...

    include /home/edson/www/node-fw/nginx/node-fw-php-log.conf;
}
```

Conteúdo do snippet:

```nginx
access_log syslog:server=127.0.0.1:5514,facility=local6,tag=nodefw,severity=info,nohostname security_json;
```

### 4.2 Preservar o log tradicional

O Node FW não substitui o access log tradicional. Se o site já possui um log no `server` ou na location PHP, mantenha-o e adicione o Syslog como uma segunda diretiva `access_log` no mesmo contexto:

```nginx
location ~ \.php$ {
    access_log /var/log/nginx/site-access.log combined;
    include /etc/nginx/snippets/node-fw-php-log.conf;

    # fastcgi_pass e demais diretivas existentes
}
```

Quando uma location define `access_log`, ela substitui o herdado do `server`. Por isso, se o log tradicional estiver apenas no `server`, ele não será herdado nessa location. Para manter os dois no PHP, declare ambos na location.

### 4.3 Sites com `access_log off`

Muitos sites usam `access_log off;` no `server` para evitar volume de estáticos. Isso pode permanecer.

- Estáticos continuam sem log.
- A location PHP passa a ter o Syslog.
- Se for necessário comparar contagens, adicione temporariamente um log tradicional na location PHP, como no piloto.

Exemplo de validação temporária:

```nginx
location ~ \.php$ {
    access_log /home/edson/www/node-fw/logs/casadoppia-access.log combined;
    include /home/edson/www/node-fw/nginx/node-fw-php-log.conf;
    # ...
}
```

Remova o log tradicional temporário após a validação se ele não for desejado. O Syslog deve permanecer.

### 4.4 Magento

Configurações Magento normalmente usam:

```nginx
location / {
    try_files $uri $uri/ @handler;
}

location @handler {
    rewrite / /index.php;
}

location ~ \.php$ {
    # ...
    include /etc/nginx/snippets/node-fw-php-log.conf;
}
```

- O `@handler` apenas reescreve; o log ocorre na location PHP final.
- O caminho original é preservado em `$nodefw_request_path` (por exemplo, `/catalogsearch/result/`).
- `$uri` mostra `/index.php`, indicando a rota executada.
- Não inclua o snippet duas vezes se `@handler` também fizer `fastcgi_pass`; teste e observe duplicidade.

### 4.5 Laravel e WordPress

Adicionar o snippet na location PHP que recebe o `fastcgi_pass`. O `try_files` interno para `index.php` gera um redirecionamento interno e o evento é registrado na location PHP final.

### 4.6 Cache de FastCGI

Em cache hit, o PHP pode não ser consultado e `$upstream_addr` pode ficar vazio. Nesse caso, `dynamic=0`, mas `final_uri` ainda termina em `.php`. O Node FW conta a requisição e o painel deve considerar `final_uri` para rotas dinâmicas. O contador `dynamic` representa encaminhamento efetivo ao upstream, não apenas rota PHP.

### 4.7 Proxy e CDN

`$remote_addr` só é confiável se o Nginx estiver configurado para o proxy/CDN:

```nginx
set_real_ip_from 203.0.113.0/24;   # exemplo; usar faixas oficiais
real_ip_header CF-Connecting-IP;   # exemplo
real_ip_recursive on;
```

Nunca use `set_real_ip_from 0.0.0.0/0` nem confie em `X-Forwarded-For` de clientes não confiáveis. O piloto `casadoppia.site` não usa CDN e registra o IP direto.

### 4.8 O que não fazer

- Não incluir o snippet em `location /` ou em locations de estáticos.
- Não incluir em `if`.
- Não usar `access_log off` na location PHP.
- Não registrar query string; o mapa remove.
- Não adicionar cookies, `Authorization` ou headers sensíveis no `log_format`.
- Não alterar o jail `nginx-wishlist` nem o Fail2Ban nesta fase.

## 5. Alteração aplicada no piloto

Arquivo: `/home/edson/www/nginx/casadoppia.conf`

Backup: `/home/edson/www/node-fw/backups/` (ver seção 9).

Trecho adicionado na location PHP:

```nginx
location ~ .php$ {
    if (!-e $request_filename) { rewrite / /index.php last; }
    expires off;

    # Node FW - validacao local. O log tradicional abaixo e temporario
    # para comparar contagens; o Syslog JSON e o log de seguranca.
    access_log /home/edson/www/node-fw/logs/casadoppia-access.log combined;
    include /home/edson/www/node-fw/nginx/node-fw-php-log.conf;

    fastcgi_pass unix:/run/php/php5.6-fpm.sock;
    # ...
}
```

O `access_log off;` do `server` foi mantido. Estáticos continuam sem log; somente a location PHP registra.

O arquivo tradicional do piloto foi criado pelo master do Nginx como `root:root`. Os workers escrevem pelo descritor herdado, mas ele é **temporário**. Para um log permanente, use `/var/log/nginx/` com a rotação e o `su`/permissões adequados na Fase 9.

## 6. Validação local realizada

Foi usada uma instância Nginx temporária em `127.0.0.1:18080`, com uma cópia do vhost piloto e o mesmo arquivo central. Naquele momento o Nginx de produção ainda não havia sido recarregado; o reload e o teste real estão registrados na seção 7.

Comandos de referência:

```bash
# Gerar cópia de teste (não altera o vhost ativo)
cp /home/edson/www/nginx/casadoppia.conf /tmp/kilo/nginx-test/casadoppia-18080.conf
sed -i 's/listen 80;/listen 127.0.0.1:18080;/' /tmp/kilo/nginx-test/casadoppia-18080.conf
sed -i 's#include fastcgi_params;#include /etc/nginx/fastcgi_params;#' /tmp/kilo/nginx-test/casadoppia-18080.conf

# Validar e iniciar o Nginx temporário
nginx -t -c /tmp/kilo/nginx-test/nginx.conf
nginx -c /tmp/kilo/nginx-test/nginx.conf
```

Requisições de teste:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: casadoppia.site' 'http://127.0.0.1:18080/'
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: casadoppia.site' 'http://127.0.0.1:18080/index.php?foo=bar&token=secret'
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: casadoppia.site' 'http://127.0.0.1:18080/catalogsearch/result/?q=abc'
```

Resultado observado:

- 3 requisições, 3 eventos aceitos, 0 inválidos.
- `site`: `casadoppia.site`.
- `path`: `/`, `/index.php`, `/catalogsearch/result/` — sem query string.
- `final_uri`: `/index.php` para as rotas reescritas.
- `dynamic`: `1`.
- `upstream_addr`: `unix:/run/php/php5.6-fpm.sock`.
- `status`: `200`.
- Log tradicional: 3 linhas correspondentes.

## 7. Validação no servidor de produção

O reload foi executado em 05/11/2026 com `systemctl reload nginx`. Os workers foram reiniciados e a configuração foi aceita.

Requisições de validação:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: casadoppia.site' 'http://127.0.0.1/'
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: casadoppia.site' 'http://127.0.0.1/index.php?foo=bar'
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: casadoppia.site' 'http://127.0.0.1/catalogsearch/result/?q=abc'
```

Resultado observado no Nginx real:

- 3 requisições, 3 eventos aceitos, 0 inválidos.
- `site`: `casadoppia.site`.
- `path`: `/`, `/index.php`, `/catalogsearch/result/` — sem query.
- `final_uri`: `/index.php` nas rotas reescritas.
- `dynamic`: `1`.
- `upstream_addr`: `unix:/run/php/php5.6-fpm.sock`.
- Log tradicional: 3 linhas correspondentes.
- Redis DB 7 recebeu os eventos de teste no prefixo `nodfw:v1`.

Conferência:

```bash
curl -s http://127.0.0.1:8088/api/stats
curl -s 'http://127.0.0.1:8088/api/summary?site=casadoppia.site'
redis-cli -n 7 xrevrange nodfw:v1:events + - COUNT 5
tail -n 5 /home/edson/www/node-fw/logs/casadoppia-access.log
```

O Node FW de teste foi encerrado após a validação. Para retomar o monitoramento, iniciar com `npm start` ou, na Fase 9, pelo serviço systemd.

O uso de `redis-cli -n 7` pressupõe a configuração padrão de produção (`REDIS_DB=7`, `REDIS_PREFIX=nodfw:v1`). Para testes isolados, use DB 15 e prefixo próprio.

## 8. Troubleshooting

| Sintoma | Verificação |
|---|---|
| Nenhum evento recebido | `ss -lunp \| grep 5514`; Node ativo; tag igual a `nodefw`; location PHP realmente executada |
| `unknown log format "security_json"` | Arquivo central não foi incluído antes dos vhosts; usar prefixo `00-` ou conf.d |
| Erro de `log_format` duplicado | Existe mais de uma cópia do arquivo central; manter apenas uma |
| Evento inválido no Node | `curl /api/stats`; ver `invalidByReason`; conferir `escape=json` e tag |
| `path` com query string | `map` não aplicado; validar `$nodefw_request_path`; o Node também remove query como fallback |
| Eventos duplicados | Snippet incluído em mais de uma location que atende a mesma requisição |
| `dynamic=0` em PHP | Cache FastCGI ou `$upstream_addr` vazio; conferir `final_uri` |
| Site errado | `$host`; validar `server_name` e cabeçalho `Host` |
| Nenhum log tradicional no PHP | A location define `access_log` e substitui o herdado; declarar o log tradicional na própria location |
| Estáticos gerando volume | Snippet incluído em `location /`; mover para a location PHP |
| IP de CDN incorreto | Configurar `set_real_ip_from` apenas com faixas oficiais |

## 9. Rollback

Backup do vhost:

```text
/home/edson/www/node-fw/backups/casadoppia.conf.bak-20261105-112011
```

Rollback do piloto:

1. Restaurar o backup ou remover as duas linhas adicionadas na location PHP.
2. Testar e recarregar:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

3. O arquivo central `00-node-fw-log.conf` pode permanecer, pois não afeta vhosts que não usam `security_json`. Se ele for removido, remover também o include do snippet.

## 10. Checklist de produção

- [x] Backup do vhost antes da alteração.
- [x] Arquivo central em um único local, carregado antes dos vhosts.
- [x] Snippet incluído apenas em locations PHP/FastCGI.
- [x] Logs tradicionais preservados.
- [x] Estáticos sem log de segurança.
- [ ] `sudo nginx -t` sem erros (executar explicitamente antes do próximo reload).
- [x] Reload controlado aceito pelo Nginx.
- [x] Requisições de teste aceitas pelo Node FW.
- [x] `path` sem query string.
- [x] `final_uri` e `dynamic` coerentes.
- [x] Comparação de contagens com log tradicional.
- [x] Perda de UDP na amostra (0 perdas).
- [ ] Piloto estável por 24 horas antes de expandir.
- [x] Jail `nginx-wishlist` e Fail2Ban intocados.

## 11. Próximos passos

1. Manter o Node FW em execução (`npm start` ou systemd na Fase 9) e o piloto por 24 horas.
2. Acompanhar `/api/stats`, `invalidByReason`, profundidade da fila e perda de UDP.
3. Comparar contagens do log tradicional com eventos aceitos.
4. Remover o log tradicional temporário do piloto se não for desejado; manter o Syslog.
5. Expandir um site por vez, usando o mesmo snippet.
